import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const refreshCustomersBtn = document.getElementById('refreshCustomersBtn');
const searchInput = document.getElementById('searchInput');
const customersMessage = document.getElementById('customersMessage');
const customersBody = document.getElementById('customersBody');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');
const statTotalCustomers = document.getElementById('statTotalCustomers');
const statCustomersWithReservations = document.getElementById('statCustomersWithReservations');
const statNewThisMonth = document.getElementById('statNewThisMonth');
const statCustomersWithPhone = document.getElementById('statCustomersWithPhone');

let allCustomers = [];

function redirectToAdminLogin() {
  window.location.replace('/admin/index.html');
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

function belongsToCurrentMonth(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
  );
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
        <td>
          <div class="customer-cell">
            <div class="customer-head">
              <span class="customer-avatar">${escapeHtml(getCustomerInitials(customer))}</span>
              <div>
                <span class="table-main">${escapeHtml(getCustomerName(customer))}</span>
                <span class="table-sub">${escapeHtml(customer.role || 'customer')}</span>
              </div>
            </div>
          </div>
        </td>
        <td>
          <span class="table-main">${escapeHtml(customer.email || 'No email on file')}</span>
          <span class="table-sub">${escapeHtml(phoneLabel)}</span>
        </td>
        <td>
          <span class="table-main">${escapeHtml(formatDate(customer.date_registered))}</span>
          <span class="table-sub">${escapeHtml(customer.date_registered ? 'Account created' : 'Missing registration date')}</span>
        </td>
        <td>
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

function updateStats(customers) {
  const customersWithReservations = customers.filter((customer) => customer.totalReservations > 0).length;
  const newThisMonth = customers.filter((customer) => belongsToCurrentMonth(customer.date_registered)).length;
  const customersWithPhone = customers.filter((customer) => Boolean(customer.phone_number)).length;

  if (statTotalCustomers) statTotalCustomers.textContent = String(customers.length);
  if (statCustomersWithReservations) statCustomersWithReservations.textContent = String(customersWithReservations);
  if (statNewThisMonth) statNewThisMonth.textContent = String(newThisMonth);
  if (statCustomersWithPhone) statCustomersWithPhone.textContent = String(customersWithPhone);
}

function applyFilters() {
  const query = (searchInput?.value || '').trim().toLowerCase();
  const filteredCustomers = !query
    ? allCustomers
    : allCustomers.filter((customer) => {
      const haystacks = [
        getCustomerName(customer),
        customer.email,
        customer.phone_number
      ]
        .filter(Boolean)
        .map((value) => value.toLowerCase());

      return haystacks.some((value) => value.includes(query));
    });

  renderCustomers(filteredCustomers);

  const summaryText = filteredCustomers.length
    ? `Showing ${filteredCustomers.length} of ${allCustomers.length} registered customer(s).`
    : `No registered customers matched "${query}".`;

  setCustomersMessage(summaryText);
}

async function fetchProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select(`
      user_id,
      first_name,
      middle_name,
      last_name,
      email,
      phone_number,
      date_registered,
      role
    `)
    .eq('role', 'customer')
    .order('date_registered', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

async function fetchReservationActivity() {
  const { data, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      user_id,
      status,
      created_at,
      event_type,
      event_date,
      package:package_id ( package_name )
    `);

  if (error) {
    throw error;
  }

  return data || [];
}

function mergeCustomersWithActivity(profiles, reservations) {
  const activityByUser = reservations.reduce((map, reservation) => {
    const userId = reservation.user_id;
    if (!userId) return map;

    if (!map[userId]) {
      map[userId] = {
        totalReservations: 0,
        approvedReservations: 0,
        lastReservationDate: null
      };
    }

    map[userId].totalReservations += 1;

    const status = (reservation.status || '').toLowerCase();
    if (status === 'approved' || status === 'confirmed') {
      map[userId].approvedReservations += 1;
    }

    if (!map[userId].lastReservationDate || new Date(reservation.created_at) > new Date(map[userId].lastReservationDate)) {
      map[userId].lastReservationDate = reservation.created_at;
    }

    return map;
  }, {});

  return profiles.map((profile) => ({
    ...profile,
    totalReservations: activityByUser[profile.user_id]?.totalReservations || 0,
    approvedReservations: activityByUser[profile.user_id]?.approvedReservations || 0,
    lastReservationDate: activityByUser[profile.user_id]?.lastReservationDate || null
  }));
}

function countPendingReservations(reservations) {
  return reservations.filter((reservation) => String(reservation?.status || '').toLowerCase() === 'pending').length;
}

async function loadCustomers() {
  setCustomersMessage('Loading customers...');

  try {
    const [profiles, reservations] = await Promise.all([
      fetchProfiles(),
      fetchReservationActivity()
    ]);

    allCustomers = mergeCustomersWithActivity(profiles, reservations);

    updateStats(allCustomers);
    initAdminSidebarBadges(supabase)

    applyFilters();
  } catch (error) {
    console.error('Failed to load customers:', error);
    allCustomers = [];
    updateStats([]);
    renderCustomers([]);
    initAdminSidebarBadges(supabase)
    setCustomersMessage(
      `Failed to load registered customers: ${error?.message || 'unknown error'}. If the admin account should see all profiles, check the RLS policies for the profiles table.`,
      true
    );
  }
}

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {

    // Setup inactivity
    setupInactivityLogout(profile.role);

    // Attach UI listeners (IMPORTANT)
    refreshCustomersBtn?.addEventListener('click', loadCustomers);
    searchInput?.addEventListener('input', applyFilters);

    // Load data
    await loadCustomers();
  }
});
