import { portalSupabase as supabase } from './supabase.js';
import { showConfirmModal } from './feedback_modal.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { renderPagination, getTotalPages, getPageRange } from './pagination.js';
import { initAutoRefresh } from './auto_refresh.js';
import { mountRefreshStatus } from './refresh_status.js';
import { initTableSort, rpcWithSort } from './table_sort.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';
import { logAudit } from './audit_logger.js';
import { bindSaving } from './button_saving.js';

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
const idFilterChips = document.getElementById('idFilterChips');
const chipAllCount = document.getElementById('chipAllCount');
const chipFlaggedCount = document.getElementById('chipFlaggedCount');
const idReviewModal = document.getElementById('idReviewModal');
const idReviewSubtitle = document.getElementById('idReviewSubtitle');
const idReviewStatus = document.getElementById('idReviewStatus');
const idReviewGrid = document.getElementById('idReviewGrid');
const idReviewDecision = document.getElementById('idReviewDecision');
const idReviewNote = document.getElementById('idReviewNote');
const idReviewMessage = document.getElementById('idReviewMessage');
const idReviewApproveBtn = document.getElementById('idReviewApproveBtn');
const idReviewRejectBtn = document.getElementById('idReviewRejectBtn');
const idReviewCancelBtn = document.getElementById('idReviewCancelBtn');
const idReviewClose = document.getElementById('idReviewClose');

// Server-side pagination: the database returns one page of customers at a
// time (get_admin_customers_page), already filtered by the search term. The
// browser never holds the full customer list.
const CUSTOMERS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

let customersCurrentPage = 1;
// Alphabetical by name until a header is clicked. Sorting runs in the
// database so it covers every customer, not just the page on screen.
const customersSort = initTableSort(document.querySelector('.customers-table'), {
  defaultSort: { key: 'customer', dir: 'asc' },
  onChange: () => {
    customersCurrentPage = 1;
    loadCustomers({ withStats: false });
  }
});
let customersTotal = 0;            // customers matching the active search
let totalRegisteredCustomers = 0;  // all customers, ignoring the search
let activeSearch = '';             // the search term currently applied
let latestRequestId = 0;           // lets a newer request supersede an older one
let searchDebounceTimer = null;
let currentRole = '';               // 'manager' | 'admin', set after the session check
// 'all' | 'flagged' (the chips above the table). The ID-flagged notification
// links here as /admin/customers?id=flagged, so that opens with the filter on.
let activeIdFilter = new URLSearchParams(window.location.search).get('id') === 'flagged' ? 'flagged' : 'all';
let customersOnPage = [];           // rows on screen, so the ID modal can name the customer
let pendingFlash = '';              // shown once by the next render (e.g. after an ID decision)

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

// ── Valid ID ────────────────────────────────────────────────────────────
// valid_id_status comes from get_admin_customers_page (valid_id_review, or
// 'none' when no photo is on file). Before the 20261205 migration is applied
// the field is missing, and the column just shows a dash.
const VALID_ID_META = {
  none: { label: 'No ID', tone: 'soft', sub: 'Not uploaded yet' },
  unchecked: { label: 'Not checked', tone: 'soft', sub: 'Saved; the automatic check hasn\u2019t confirmed a signature' },
  clear: { label: 'Clear', tone: 'good', sub: 'Signature found' },
  flagged: { label: 'Flagged', tone: 'warn', sub: 'No signature found \u2014 needs a manager' },
  approved: { label: 'Approved', tone: 'good', sub: 'Approved by a manager' },
  rejected: { label: 'Rejected', tone: 'bad', sub: 'Waiting for a new ID' }
};

function getValidIdStatus(customer) {
  if (!Object.prototype.hasOwnProperty.call(customer, 'valid_id_status')) return null;
  const status = String(customer.valid_id_status || 'none').toLowerCase();
  return VALID_ID_META[status] ? status : 'unchecked';
}

function renderValidIdCell(customer) {
  const status = getValidIdStatus(customer);
  if (!status) return '<span class="table-sub">\u2014</span>';

  const meta = VALID_ID_META[status];
  const sub = status === 'rejected' && customer.valid_id_review_note
    ? `Rejected: ${customer.valid_id_review_note}`
    : meta.sub;
  // Managers decide on flagged IDs; anyone else (and any other status) can
  // only look. Nothing to open when no photo is on file.
  let button = '';
  if (status !== 'none') {
    const decides = status === 'flagged' && currentRole === 'manager';
    button = `<button type="button" class="id-review-open${decides ? ' primary' : ''}" data-id-review="${escapeHtml(customer.user_id)}">${decides ? 'Review ID' : 'View ID'}</button>`;
  }

  return `
    <div class="valid-id-cell">
      <span class="tag ${meta.tone}">${escapeHtml(meta.label)}</span>
      <span class="table-sub">${escapeHtml(sub)}</span>
      ${button}
    </div>
  `;
}

function renderCustomers(customers) {
  customersOnPage = customers;
  if (!customersBody) return;

  if (!customers.length) {
    customersBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">${escapeHtml(activeIdFilter === 'flagged' ? 'No flagged IDs to show.' : 'No registered customers matched this search.')}</td>
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
    const validIdCell = renderValidIdCell(customer);

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
        <td data-label="Valid ID">${validIdCell}</td>
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
  if (chipAllCount) chipAllCount.textContent = asCount(safe.total);
  if (chipFlaggedCount) chipFlaggedCount.textContent = asCount(safe.flagged_ids);
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

  if (pendingFlash) {
    setCustomersMessage(pendingFlash);
    pendingFlash = '';
  } else if (customersTotal) {
    setCustomersMessage('');
  } else if (activeIdFilter === 'flagged') {
    setCustomersMessage(activeSearch
      ? `No flagged IDs matched "${activeSearch}".`
      : 'No flagged IDs. Every ID with no signature has been reviewed.');
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
  const params = {
    p_search: search || null,
    p_limit: CUSTOMERS_PAGE_SIZE,
    p_offset: from
  };
  // Only sent when filtering, so the unfiltered list keeps working even before
  // the 20261205 migration (which adds p_id_filter) is applied.
  if (activeIdFilter === 'flagged') params.p_id_filter = 'flagged';
  const { data, error } = await rpcWithSort(supabase, 'get_admin_customers_page', params, customersSort.getRpcParams());

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

    if (!activeSearch && activeIdFilter === 'all') {
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
      return false; // tells initAutoRefresh not to advance the "Updated" time
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

// ── Valid ID filter chips ──────────────────────────────────────────────
function syncIdFilterChips(filter) {
  idFilterChips?.querySelectorAll('[data-id-filter]').forEach((chip) => {
    const active = chip.dataset.idFilter === filter;
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setIdFilter(nextFilter) {
  const filter = nextFilter === 'flagged' ? 'flagged' : 'all';
  syncIdFilterChips(filter);
  if (filter === activeIdFilter) return;
  activeIdFilter = filter;
  customersCurrentPage = 1;
  loadCustomers({ withStats: false });
}

function wireIdFilterChips() {
  syncIdFilterChips(activeIdFilter);   // may already be 'flagged' (opened from a notification)
  idFilterChips?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-id-filter]');
    if (chip) setIdFilter(chip.dataset.idFilter);
  });
}

// ── Customer's valid ID (view for staff, approve/reject for managers) ──
// Photos never come straight from storage (staff have no read policy on the
// private bucket). review-customer-id checks the caller's role, logs the view
// and returns 2-minute signed links. Admins can look; only managers decide,
// and only while the ID is flagged (no signature found).
let idReviewCustomerId = null;
let idReviewCustomerName = '';
let idReviewSaving = false;
let idReviewOpen = false;
let idReviewRequest = 0;            // a newer open (or a close) makes older responses stale

async function readIdReviewError(error, fallback) {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return String(body.error);
  } catch { /* fall through */ }
  return fallback;
}

function setIdReviewMessage(text = '', isError = false) {
  if (!idReviewMessage) return;
  idReviewMessage.textContent = text;
  idReviewMessage.classList.toggle('error', !!isError);
}

function setIdReviewBusy(busy) {
  idReviewSaving = busy;
  [idReviewApproveBtn, idReviewRejectBtn, idReviewCancelBtn, idReviewClose].forEach((btn) => {
    if (btn) btn.disabled = busy;
  });
  if (idReviewNote) idReviewNote.disabled = busy;
}

function showIdDecision(show) {
  idReviewDecision?.classList.toggle('hidden', !show);
  idReviewApproveBtn?.classList.toggle('hidden', !show);
  idReviewRejectBtn?.classList.toggle('hidden', !show);
}

function renderIdReviewFigure(label, url) {
  if (!url) {
    return `<figure class="id-review-figure"><figcaption>${escapeHtml(label)}</figcaption><div class="id-review-image-wrap"><p class="id-review-missing">Not uploaded.</p></div></figure>`;
  }
  return `<figure class="id-review-figure"><figcaption>${escapeHtml(label)}</figcaption><div class="id-review-image-wrap"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}"></div><a class="id-review-open-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open larger</a></figure>`;
}

function closeIdReview() {
  if (idReviewSaving || !idReviewOpen) return;   // a decision is being saved
  idReviewOpen = false;
  idReviewModal?.classList.add('hidden');
  idReviewModal?.setAttribute('aria-hidden', 'true');
  // Drop the signed links so the photos don't linger in the page.
  if (idReviewGrid) idReviewGrid.innerHTML = '';
  if (idReviewNote) idReviewNote.value = '';
  setIdReviewMessage('');
  idReviewCustomerId = null;
  idReviewCustomerName = '';
  idReviewRequest += 1;
  unlockBodyScroll();
}

async function openIdReview(customerId) {
  if (!idReviewModal || !customerId || idReviewOpen) return;
  const requestId = ++idReviewRequest;
  const customer = customersOnPage.find((row) => row.user_id === customerId);
  idReviewCustomerId = customerId;
  idReviewCustomerName = customer ? getCustomerName(customer) : 'Customer';

  idReviewOpen = true;
  if (idReviewSubtitle) idReviewSubtitle.textContent = idReviewCustomerName;
  idReviewGrid.innerHTML = '<p class="id-review-missing">Loading the ID…</p>';
  idReviewNote.value = '';
  idReviewStatus?.classList.add('hidden');
  showIdDecision(false);
  setIdReviewMessage('');
  setIdReviewBusy(false);   // Close stays usable while the photos load
  idReviewModal.classList.remove('hidden');
  idReviewModal.setAttribute('aria-hidden', 'false');
  lockBodyScroll();

  try {
    const { data, error } = await supabase.functions.invoke('review-customer-id', {
      body: { action: 'view', customer_id: customerId }
    });
    if (error || !data?.success) {
      throw new Error(await readIdReviewError(error, data?.error || 'We couldn’t load the ID right now.'));
    }
    if (requestId !== idReviewRequest) return;   // closed (or reopened) meanwhile

    idReviewGrid.innerHTML = renderIdReviewFigure('Front of ID', data.front_url) + renderIdReviewFigure('Back of ID', data.back_url);

    const status = String(data.review?.status || 'unchecked');
    const reviewCopy = {
      flagged: ['flagged', 'Flagged: no handwritten signature was found on this ID. Decide whether to accept it.'],
      clear: ['clear', 'The automatic check found a signature on this ID.'],
      approved: ['approved', `Approved by a manager${data.review?.note ? `: ${data.review.note}` : '.'}`],
      rejected: ['rejected', `Rejected by a manager${data.review?.note ? `: ${data.review.note}` : '.'} Waiting for the customer to upload a new ID.`],
      unchecked: ['unchecked', 'The automatic check hasn’t confirmed a signature on this ID yet.']
    }[status];
    if (idReviewStatus && reviewCopy) {
      idReviewStatus.className = `id-review-status state-${reviewCopy[0]}`;
      idReviewStatus.textContent = reviewCopy[1];
    }

    const hasPhoto = !!(data.front_url || data.back_url);
    const canDecide = currentRole === 'manager' && data.can_decide === true && status === 'flagged';
    showIdDecision(canDecide);
    if (!hasPhoto) {
      setIdReviewMessage('The customer has no ID photo on file.', true);
    } else if (currentRole !== 'manager' && status === 'flagged') {
      setIdReviewMessage('Only a manager can approve or reject this ID.');
    }
    setIdReviewBusy(false);
    // Approving needs something to look at; asking for a new ID never does.
    if (idReviewApproveBtn) idReviewApproveBtn.disabled = !hasPhoto;
  } catch (err) {
    if (requestId !== idReviewRequest) return;
    idReviewGrid.innerHTML = '';
    setIdReviewBusy(false);
    showIdDecision(false);
    setIdReviewMessage(err.message || 'We couldn’t load the ID right now.', true);
  }
}

async function submitIdReviewDecision(action) {
  const customerId = idReviewCustomerId;
  if (!customerId || currentRole !== 'manager' || idReviewSaving) return;
  const note = idReviewNote.value.replace(/\s+/g, ' ').trim();

  if (action === 'reject' && !note) {
    setIdReviewMessage('Please tell the customer what is wrong with the ID.', true);
    idReviewNote.focus();
    return;
  }
  if (action === 'approve' && !await showConfirmModal({
    type: 'warning',
    title: 'Approve this ID?',
    message: `Confirm this is a genuine valid ID that belongs to ${idReviewCustomerName}. The ID is approved even though it has no signature to compare. Any of their contracts waiting on this ID are verified now, and their future bookings skip the signature comparison until they replace their ID.`,
    confirmText: 'Yes, approve ID',
    cancelText: 'Cancel'
  })) return;

  setIdReviewBusy(true);
  setIdReviewMessage(action === 'approve' ? 'Approving…' : 'Sending your request…');
  try {
    const { data, error } = await supabase.functions.invoke('review-customer-id', {
      body: { action, customer_id: customerId, note }
    });
    if (error || !data?.success) {
      throw new Error(await readIdReviewError(error, data?.error || 'Something went wrong. Please try again.'));
    }

    const contracts = Number(data.contracts_updated) || 0;
    await logAudit({
      action: action === 'approve' ? 'Approved Customer ID' : 'Rejected Customer ID',
      category: 'contract',
      details: action === 'approve'
        ? `Approved the valid ID of ${idReviewCustomerName} from the Customers page (${contracts} waiting contract${contracts === 1 ? '' : 's'} verified).${note ? ` Note: ${note}` : ''}`
        : `Rejected the valid ID of ${idReviewCustomerName} from the Customers page; they were asked to upload it again. Reason: ${note}`,
      entityId: customerId
    });

    setIdReviewBusy(false);
    closeIdReview();
    pendingFlash = action === 'approve'
      ? (contracts
        ? `ID approved. ${contracts} contract${contracts === 1 ? ' was' : 's were'} waiting on it and ${contracts === 1 ? 'is' : 'are'} now verified.`
        : 'ID approved. Their future contracts will go through without the signature comparison.')
      : 'ID rejected. The customer was asked to upload a new one.';
    // Counts and the row both change; the next render shows pendingFlash.
    await loadCustomers({ silent: true });
  } catch (err) {
    setIdReviewMessage(err.message || 'Something went wrong. Please try again.', true);
    setIdReviewBusy(false);
  }
}

function wireIdReviewModal() {
  customersBody?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id-review]');
    if (button) openIdReview(button.dataset.idReview);
  });
  bindSaving(idReviewApproveBtn, () => submitIdReviewDecision('approve'), { label: 'Approving…' });
  bindSaving(idReviewRejectBtn, () => submitIdReviewDecision('reject'), { label: 'Rejecting…' });
  idReviewCancelBtn?.addEventListener('click', closeIdReview);
  idReviewClose?.addEventListener('click', closeIdReview);
  idReviewModal?.addEventListener('click', (event) => {
    if (event.target === idReviewModal) closeIdReview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && idReviewOpen) closeIdReview();
  });
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

    // Decides which Valid ID actions the page offers (the Edge Function
    // enforces the same rule server-side).
    currentRole = String(profile.role || '').toLowerCase();

    // Attach UI listeners (IMPORTANT)
    searchInput?.addEventListener('input', handleSearchInput);
    wireIdFilterChips();
    wireIdReviewModal();

    // Load data
    await loadCustomers();
  }
});

// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
const autoRefresh = initAutoRefresh(() => loadCustomers({ silent: true }), { pollMs: 2 * 60 * 1000 });
mountRefreshStatus(autoRefresh);