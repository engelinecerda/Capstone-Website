import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { renderPagination, getTotalPages, getPageRange } from './pagination.js';
import { initAutoRefresh } from './auto_refresh.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const customersMessage = document.getElementById('customersMessage');
const customersBody = document.getElementById('customersBody');
const customersPagination = document.getElementById('customersPagination');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');
const statTotalCustomers = document.getElementById('statTotalCustomers');
const statCustomersWithReservations = document.getElementById('statCustomersWithReservations');
const statNewThisMonth = document.getElementById('statNewThisMonth');
const statCustomersWithPhone = document.getElementById('statCustomersWithPhone');

// Server-side pagination: the database returns one page of customers at a
// time (get_admin_customers_page), already filtered by the search term. The
// browser never holds the full customer list.
const CUSTOMERS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

let customersCurrentPage = 1;
let customersTotal = 0;            // customers matching the active search
let totalRegisteredCustomers = 0;  // all customers, ignoring the search
let activeSearch = '';             // the search term currently applied
let latestRequestId = 0;           // lets a newer request supersede an older one
let searchDebounceTimer = null;

function redirectToAdminLogin() {
  window.location.replace('/admin');
}

function setCustomersMessage(message, isError = false) {
  if (!customersMessage) return;
  customersMessage.textContent = message;
  customersMessage.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return 'No date on file';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No date on file';
  }

  return date.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function formatDateTime(value) {
  if (!value) return 'No date on file';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No date on file';
  }

  return date.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getCustomerName(profile) {
  const nameParts = [
    profile.first_name,
    profile.middle_name,
    profile.last_name
  ].filter(Boolean);

  if (nameParts.length) {
    return nameParts.join(' ');
  }

  return profile.email || 'Unnamed customer';
}

function getCustomerInitials(profile) {
  const initials = [profile.first_name, profile.last_name]
    .filter(Boolean)
    .map((value) => value.trim().charAt(0).toUpperCase())
    .join('');

  return initials || (profile.email || 'C').charAt(0).toUpperCase();
}

function getActivityLabel(totalReservations) {
  if (!totalReservations) return 'No reservations yet';
  if (totalReservations === 1) return '1 reservation';
  return `${totalReservations} reservations`;
}

// Start (inclusive) and end (exclusive) of the admin's current local calendar
// month, sent to the database so "New this month" means the same thing it
// always did in the browser.
function getCurrentMonthRange() {
  const now = new Date();
  return {
    startIso: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    endIso: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  };
}

function renderCustomers(customers) {
  if (!customersBody) return;

  if (!customers.length) {
    customersBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No registered customers matched this search.</td>
      </tr>
    `;
    return;
  }

  customersBody.innerHTML = customers.map((customer) => {
    const reservationBadge = customer.totalReservations
      ? `<span class="tag good">${escapeHtml(getActivityLabel(customer.totalReservations))}</span>`
      : `<span class="tag soft">No bookings yet</span>`;

    const approvedBadge = customer.approvedReservations
      ? `<span class="tag info">${escapeHtml(`${customer.approvedReservations} approved`)}</span>`
      : '';

    const phoneLabel = customer.phone_number || 'No phone number';
    const lastReservation = customer.lastReservationDate
      ? `Latest booking on ${formatDate(customer.lastReservationDate)}`
      : 'No reservation activity yet';

    return `
      <tr>
        <td data-label="Customer">
          <div class="customer-cell">
            <div class="customer-head">
              <span class="avatar">${escapeHtml(getCustomerInitials(customer))}</span>
              <div>
                <span class="table-main">${escapeHtml(getCustomerName(customer))}</span>
                <span class="table-sub">${escapeHtml(customer.role || 'customer')}</span>
              </div>
            </div>
          </div>
        </td>
        <td data-label="Contact">
          <span class="table-main">${escapeHtml(customer.email || 'No email on file')}</span>
          <span class="table-sub">${escapeHtml(phoneLabel)}</span>
        </td>
        <td data-label="Registered">
          <span class="table-main">${escapeHtml(formatDate(customer.date_registered))}</span>
          <span class="table-sub">${escapeHtml(customer.date_registered ? 'Account created' : 'Missing registration date')}</span>
        </td>
        <td data-label="Reservation Activity">
          <div class="customer-tags">
            ${reservationBadge}
            ${approvedBadge}
          </div>
          <span class="table-sub">${escapeHtml(lastReservation)}</span>
        </td>
      </tr>
    `;
  }).join('');
}

function updateStats(stats) {
  const safe = stats || {};
  const asCount = (value) => String(Number(value) || 0);

  if (statTotalCustomers) statTotalCustomers.textContent = asCount(safe.total);
  if (statCustomersWithReservations) statCustomersWithReservations.textContent = asCount(safe.with_reservations);
  if (statNewThisMonth) statNewThisMonth.textContent = asCount(safe.new_this_month);
  if (statCustomersWithPhone) statCustomersWithPhone.textContent = asCount(safe.with_phone);
}

function renderCustomersView(customers) {
  renderCustomers(customers);
  renderPagination(customersPagination, {
    totalItems: customersTotal,
    currentPage: customersCurrentPage,
    pageSize: CUSTOMERS_PAGE_SIZE,
    onPageChange: (page) => {
      customersCurrentPage = page;
      loadCustomers({ withStats: false });
    }
  });

  if (customersTotal) {
    setCustomersMessage('');
  } else if (activeSearch) {
    setCustomersMessage(`No registered customers matched "${activeSearch}".`);
  } else {
    setCustomersMessage('No registered customers yet.');
  }
}

// One page of customers (filtered by `search`), each row already carrying its
// reservation totals. The RPC takes limit/offset, which is the same window
// .range(from, to) would select.
async function fetchCustomersPage(page, search) {
  const { from } = getPageRange(page, CUSTOMERS_PAGE_SIZE);
  const { data, error } = await supabase.rpc('get_admin_customers_page', {
    p_search: search || null,
    p_limit: CUSTOMERS_PAGE_SIZE,
    p_offset: from
  });

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    total: Number(data?.total) || 0,
    customers: rows.map((row) => ({
      ...row,
      totalReservations: row.total_reservations || 0,
      approvedReservations: row.approved_reservations || 0,
      lastReservationDate: row.last_reservation_date || null
    }))
  };
}

// If the requested page no longer exists (customers were removed since the
// last load, so there are fewer pages now), fall back to the last page that
// does exist instead of showing an empty table.
async function fetchPageWithClamp(page, search) {
  let result = await fetchCustomersPage(page, search);
  const lastPage = getTotalPages(result.total, CUSTOMERS_PAGE_SIZE);

  if (page > lastPage) {
    page = lastPage;
    result = await fetchCustomersPage(page, search);
  }

  return { ...result, page };
}

// The four stat cards. They describe ALL customers, never the current search.
async function fetchCustomerStats() {
  const { startIso, endIso } = getCurrentMonthRange();
  const { data, error } = await supabase.rpc('get_admin_customer_stats', {
    p_month_start: startIso,
    p_month_end: endIso
  });

  if (error) {
    throw error;
  }

  return data || {};
}

// silent=true is used by the auto-refresh triggers: it skips the
// "Loading..." message so existing rows stay on screen, and on failure it
// keeps the last-good data and fails quietly instead of blanking the table.
// withStats=false is used for page changes and searches, which don't affect
// the stat cards, so only the page itself is fetched.
// Every call takes a request id; if a newer call starts before this one
// finishes, this one's result is discarded so a slow, older response can
// never overwrite a newer one.
async function loadCustomers({ silent = false, withStats = true } = {}) {
  const requestId = ++latestRequestId;

  if (!silent) {
    setCustomersMessage('Loading customers...');
  }

  try {
    const [result, stats] = await Promise.all([
      fetchPageWithClamp(customersCurrentPage, activeSearch),
      withStats ? fetchCustomerStats() : Promise.resolve(null)
    ]);

    if (requestId !== latestRequestId) return;

    customersCurrentPage = result.page;
    customersTotal = result.total;

    if (!activeSearch) {
      totalRegisteredCustomers = result.total;
    } else if (stats) {
      totalRegisteredCustomers = Number(stats.total) || 0;
    }

    if (stats) {
      updateStats(stats);
    }
    if (withStats) {
      initAdminSidebarBadges(supabase);
    }

    renderCustomersView(result.customers);
  } catch (error) {
    if (requestId !== latestRequestId) return;

    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded customers:', error.message);
      return;
    }

    customersTotal = 0;
    if (withStats) {
      updateStats(null);
      initAdminSidebarBadges(supabase);
    }
    renderCustomers([]);
    renderPagination(customersPagination, {
      totalItems: 0,
      currentPage: 1,
      pageSize: CUSTOMERS_PAGE_SIZE,
      onPageChange: () => {}
    });
    setCustomersMessage('Failed to load registered customers. Please try again.', true);
  }
}

// Search runs in the database, so wait for a short pause in typing instead of
// sending a request on every keystroke. A new search always starts at page 1.
function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const nextSearch = (searchInput?.value || '').trim();
    if (nextSearch === activeSearch) return;

    activeSearch = nextSearch;
    customersCurrentPage = 1;
    loadCustomers({ withStats: false });
  }, SEARCH_DEBOUNCE_MS);
}

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {

    // Setup inactivity
    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });

    // Attach UI listeners (IMPORTANT)
    searchInput?.addEventListener('input', handleSearchInput);

    // Load data
    await loadCustomers();
  }
});

// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
initAutoRefresh(() => loadCustomers({ silent: true }));