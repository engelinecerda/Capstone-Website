import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { refreshAdminSidebarCounts, setBadgeCount } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import {
  getScopeLabel as getSharedScopeLabel,
} from './reservation_availability.js';
import { getPaymentStatusPillMeta, fetchUnseenReservationChanges, markReservationChangesSeen } from './reservation_shared.js';
import { renderPagination, getTotalPages, getPageRange } from './pagination.js';
import { initAutoRefresh } from './auto_refresh.js';

const tableMessage = document.getElementById('tableMessage');
const reservationsBody = document.getElementById('reservationsBody');
const reservationsPagination = document.getElementById('reservationsPagination');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const chipsRow = document.getElementById('chipsRow');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');
const statIds = ['pending', 'approved', 'completed', 'total'];
const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const rescheduleAlert = document.getElementById('rescheduleAlert');
const rescheduleAlertCount = document.getElementById('rescheduleAlertCount');
const rescheduleAlertText = document.getElementById('rescheduleAlertText');
const rescheduleAlertAction = document.getElementById('rescheduleAlertAction');
const rescheduleAlertDismiss = document.getElementById('rescheduleAlertDismiss');

// Server-side pagination: the database returns one page of reservations at a
// time (get_admin_reservations_page), already filtered by status and search,
// and the stat-card / chip counts come from get_admin_reservation_counts().
// The browser never holds the full reservation list.
const RESERVATIONS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

let reservationsCurrentPage = 1;
let reservationsTotal = 0;      // reservations matching the active filters
let visibleReservations = [];   // the rows of the page on screen
let paymentSummaryMap = {};     // payment fields for the rows on screen
let activeSearch = '';          // the search term currently applied
let latestRequestId = 0;        // lets a newer request supersede an older one
let searchDebounceTimer = null;
let rosterLoaded = false;
let unseenChangeNames = [];     // { reservation_id, reservation_number, contact_name } for the banner
let appliedReviewIds = null;    // ids the list on screen is narrowed to (null = not narrowed)
let adminSession = null;
let currentRole = null;
let staffDirectory = [];
let assignmentMapByReservationId = {};
let assignmentFeatureReady = true;
let assignmentFeatureMessage = '';
let unseenChangeIds = new Set();
// Separate from unseenChangeIds: snapshotted when "Review" is clicked, so
// the table filter still shows the just-reviewed rows for this viewing
// session even after unseenChangeIds itself is cleared (which is what
// makes the banner disappear).
let reviewFilterIds = new Set();
let showPendingRescheduleOnly = false;

function setMessage(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function getAssignmentSchemaHint(error) {
  const message = error?.message || '';
  if (
    message.includes('relation "public.reservation_staff_assignments" does not exist')
    || message.includes("Could not find the table 'reservation_staff_assignments' in the schema cache")
  ) {
    return 'Create the reservation_staff_assignments table in Supabase before using employee assignment.';
  }
  if (
    message.includes("Could not find the 'assignment_note' column")
    || message.includes('column reservation_staff_assignments.assignment_note does not exist')
  ) {
    return 'Add an `assignment_note` text column to reservation_staff_assignments so admins can save staff notes.';
  }
  if (message.includes('row-level security policy')) {
    return 'The employee assignment table exists, but its RLS policy is blocking admin access. Add an admin manage policy for reservation_staff_assignments.';
  }
  return message || 'Employee assignment is unavailable right now.';
}

function getStaffDirectoryHint(error) {
  const message = error?.message || '';
  if (
    message.includes('relation "public.staff_roster" does not exist')
    || message.includes("Could not find the table 'staff_roster' in the schema cache")
  ) {
    return 'Create the staff_roster table in Supabase before using employee assignment.';
  }
  if (message.includes('row-level security policy')) {
    return 'Staff roster could not be loaded because its RLS policy is blocking admin access. Add a manager/admin read policy for staff_roster.';
  }
  return message || 'Staff roster could not be loaded right now.';
}


function formatDateKey(value) {
  return String(value || '').split('T')[0];
}

function formatReservationDate(dateIso) {
  if (!dateIso) return 'No date selected';
  return new Date(`${formatDateKey(dateIso)}T00:00:00`).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatReservationTime(timeValue) {
  return timeValue || 'No time selected';
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

// The status shown for a reservation (confirmed -> approved, an event that
// has passed and is paid in full -> completed, ...) is worked out in the
// database by reservation_effective_status(), so the status filters, the
// chip counts and this pill can never disagree. This just reads it back.
function getEffectiveReservationStatus(reservation) {
  return String(reservation?.effective_status || reservation?.status || 'pending').toLowerCase();
}

function getEmptyFilterMessage(status) {
  if (showPendingRescheduleOnly) return 'No recently cancelled or rescheduled reservations match the current filter.';
  if (status === 'upcoming') return 'No upcoming reservations found.';
  return 'No reservations match the current filter.';
}

function getCustomerInitials(name, email = '') {
  const initials = String(name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return initials || String(email || 'R').charAt(0).toUpperCase();
}

function getStaffDisplayName(profile) {
  const nameParts = [
    profile?.first_name,
    profile?.middle_name,
    profile?.last_name
  ].filter(Boolean);

  return nameParts.join(' ') || profile?.email || 'Unnamed staff';
}

function getAssignedStaff(reservationId) {
  return assignmentMapByReservationId[reservationId] || [];
}

function redirectLogin() {
  window.location.replace('/admin');
}

function formatStatusPill(status) {
  const key = (status || 'pending').toLowerCase();
  const label = key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { key, label };
}

function getScopeLabel(scope) {
  return getSharedScopeLabel(scope);
}

function isMissingColumnError(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column reservation_contracts.${columnName} does not exist`)
    || message.includes(`column reservation_staff_assignments.${columnName} does not exist`);
}

function getReservationRescheduleRequests(reservation) {
  return reservation.reschedule_requests || [];
}

function formatReadableKey(value) {
  return String(value || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getLatestOpenRescheduleRequest(reservation) {
  return getReservationRescheduleRequests(reservation)
    .find((request) => String(request.status || '').toLowerCase() === 'approved_pending_payment') || null;
}

function renderPendingRescheduleAlert() {
  if (!rescheduleAlert || !rescheduleAlertCount || !rescheduleAlertText) return;

  const count = unseenChangeIds.size;
  if (!count) {
    showPendingRescheduleOnly = false;
    rescheduleAlert.hidden = true;
    rescheduleAlert.classList.add('hidden');
    rescheduleAlert.setAttribute('aria-hidden', 'true');
    rescheduleAlertCount.textContent = '0';
    return;
  }

  rescheduleAlert.hidden = false;
  rescheduleAlert.classList.remove('hidden');
  rescheduleAlert.setAttribute('aria-hidden', 'false');
  rescheduleAlertCount.textContent = String(count);
  if (rescheduleAlertAction) {
    rescheduleAlertAction.textContent = 'Review';
  }

  // Name the specific booking(s) instead of a bare count, so an admin can
  // tell at a glance which reservation(s) triggered this without clicking
  // through. The names come from fetchUnseenReservationChanges(), which
  // returns them alongside the ids, so this no longer depends on the
  // reservation being on the current page.
  const MAX_NAMED = 3;
  const changed = unseenChangeNames.filter((r) => unseenChangeIds.has(r.reservation_id));
  const names = changed.map((r) => r.reservation_number || r.contact_name || 'Unknown booking');
  const namedList = names.length > MAX_NAMED
    ? `${names.slice(0, MAX_NAMED).join(', ')}, and ${names.length - MAX_NAMED} more`
    : names.join(', ');
  rescheduleAlertText.textContent = names.length
    ? `${namedList} — customers can cancel or reschedule without approval, this is just for visibility.`
    : 'Customers can cancel or reschedule without approval — this is just for visibility.';
}

// Sourced from reservation_payment_summary (the one server-side computed-
// status view every surface reads), replacing the old per-file re-derivation
// that didn't exclude cancellation_fee/reschedule_fee from the paid total.
function paymentStatus(res) {
  const summary = paymentSummaryMap[res.reservation_id];
  const statusMeta = getPaymentStatusPillMeta(summary?.computed_status);
  const outstanding = Number(summary?.outstanding_balance ?? res.total_price ?? 0);
  return {
    label: statusMeta.label,
    key: statusMeta.key,
    sublabel: outstanding > 0 ? `${formatCurrency(outstanding)} outstanding` : 'Fully settled'
  };
}

function getStaffSummary(reservationId) {
  const assignedStaff = getAssignedStaff(reservationId);
  if (!assignedStaff.length) {
    return {
      label: 'Not assigned',
      sublabel: 'No staff assigned yet',
      names: []
    };
  }

  return {
    label: assignedStaff.length === 1 ? '1 Staff Assigned' : `${assignedStaff.length} Staff Assigned`,
    sublabel: assignedStaff.length === 1
      ? getStaffDisplayName(assignedStaff[0])
      : `${getStaffDisplayName(assignedStaff[0])} +${assignedStaff.length - 1}`,
    names: assignedStaff.map((staff) => getStaffDisplayName(staff))
  };
}

function renderAssignedStaffMarkup(reservationId) {
  const summary = getStaffSummary(reservationId);
  return `
    <div class="staff-summary">
      <span class="table-main">${escapeHtml(summary.label)}</span>
      <span class="table-sub">${escapeHtml(summary.sublabel)}</span>
    </div>
  `;
}

// counts comes from get_admin_reservation_counts(): the same numbers the
// browser used to tally from the full list, now computed in the database.
function renderStats(counts) {
  const safe = counts || {};
  const countFor = (key) => Number(safe[key]) || 0;

  statIds.forEach(id => {
    const el = document.getElementById(`stat-${id}`);
    if (el) el.textContent = countFor(id);
  });
  setBadgeCount(navReservationCount, countFor('pending'));
  chipsRow?.querySelectorAll('.chip').forEach(chip => {
    const status = chip.dataset.status;
    const val = countFor(status === 'all' ? 'total' : status);
    chip.textContent = `${chip.textContent.split('(')[0].trim()} (${val})`;
  });
  renderPendingRescheduleAlert();
}

function renderTable(list) {
  if (!reservationsBody) return;
  if (!list.length) {
    reservationsBody.innerHTML = '<tr class="empty-row"><td colspan="6">No reservations found.</td></tr>';
    return;
  }
  reservationsBody.innerHTML = list.map(res => {
    const pkg = res.package?.package_name || 'No package selected';
    const pay = paymentStatus(res);
    const status = formatStatusPill(getEffectiveReservationStatus(res));
    const staffSummary = getStaffSummary(res.reservation_id);
    return `
      <tr class="reservation-row" data-reservation-id="${res.reservation_id}">
        <td data-label="Customer / Package">
          <div class="reservation-customer">
            <span class="avatar">${escapeHtml(getCustomerInitials(res.contact_name, res.contact_email))}</span>
            <div class="reservation-customer-copy">
              ${res.reservation_number ? `<span class="table-reservation-number">${escapeHtml(res.reservation_number)}</span>` : ''}
              <span class="table-main">${escapeHtml(res.contact_name || 'Unknown')}</span>
              <span class="table-sub">${escapeHtml(res.contact_email || '')}</span>
              <span class="table-meta">${escapeHtml(pkg)}</span>
            </div>
          </div>
        </td>
        <td data-label="Event Date & Time">
          <div class="table-date">
            <span class="table-date-main">${escapeHtml(formatReservationDate(res.event_date))}</span>
            <span class="table-date-time">${escapeHtml(formatReservationTime(res.event_time))}</span>
          </div>
        </td>
        <td class="table-status-cell" data-label="Payment">
          <div class="table-summary-stack">
            <span class="status-pill ${escapeHtml(pay.key)}">${escapeHtml(pay.label)}</span>
            <span class="table-sub">${escapeHtml(pay.sublabel || '')}</span>
          </div>
        </td>
        <td class="table-status-cell" data-label="Status">
          <div class="table-summary-stack">
            <span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
          </div>
        </td>
        <td data-label="Staff">
          <div class="staff-summary">
            <span class="table-main">${escapeHtml(staffSummary.label)}</span>
            <span class="table-sub">${escapeHtml(staffSummary.sublabel)}</span>
          </div>
        </td>
        <td class="actions actions-single" data-label="Action">
          <button class="action-btn view" data-action="view-details" data-reservation-id="${res.reservation_id}">
            View Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
}






// Which status filter is active: the dropdown wins over the chips, as before.
function getActiveStatus() {
  const dropdownStatus = statusDropdown?.value || 'all';
  const chipStatus = chipsRow?.querySelector('.chip.active')?.dataset.status || 'all';
  return dropdownStatus !== 'all' ? dropdownStatus : chipStatus;
}

// BUG-04 fix (kept): "Review" clears unseenChangeIds as its very first step
// (so the banner disappears) before the list reloads, so the "only show these
// rows" filter is driven by reviewFilterIds, the snapshot taken when Review
// was clicked. Only reset the filter once nothing is left in that snapshot.
// Returns the ids to narrow the list to, or null for no narrowing.
function getReviewIdsFilter() {
  if (!reviewFilterIds.size) {
    showPendingRescheduleOnly = false;
  }
  return showPendingRescheduleOnly ? Array.from(reviewFilterIds) : null;
}

function renderReservationsView(status) {
  renderTable(visibleReservations);
  renderPagination(reservationsPagination, {
    totalItems: reservationsTotal,
    currentPage: reservationsCurrentPage,
    pageSize: RESERVATIONS_PAGE_SIZE,
    onPageChange: (page) => {
      reservationsCurrentPage = page;
      // Moving between pages must stay inside the list on screen, so keep
      // the same narrowing instead of re-reading the (possibly reset) flag.
      loadData({ full: false, keepNarrowing: true });
    }
  });
  setMessage(tableMessage, reservationsTotal ? '' : getEmptyFilterMessage(status), false);
  if (!assignmentFeatureReady) {
    setMessage(tableMessage, `Loaded reservations. Staff assignment note: ${assignmentFeatureMessage}`, true);
  }
}

// A changed filter or search always starts again from page 1.
function reloadFromFirstPage() {
  reservationsCurrentPage = 1;
  loadData({ full: false });
}

// Search runs in the database, so wait for a short pause in typing instead of
// sending a request on every keystroke.
function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const nextSearch = (searchInput?.value || '').trim();
    if (nextSearch === activeSearch) return;

    activeSearch = nextSearch;
    reloadFromFirstPage();
  }, SEARCH_DEBOUNCE_MS);
}

function wireFilters() {
  searchInput?.addEventListener('input', handleSearchInput);
  statusDropdown?.addEventListener('change', () => {
    showPendingRescheduleOnly = false;
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    reloadFromFirstPage();
  });
  chipsRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    showPendingRescheduleOnly = false;
    chipsRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    statusDropdown.value = 'all';
    reloadFromFirstPage();
  });
  rescheduleAlertAction?.addEventListener('click', async () => {
    reviewFilterIds = new Set(unseenChangeIds);
    showPendingRescheduleOnly = true;
    statusDropdown.value = 'all';
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chipsRow?.querySelector('[data-status="all"]')?.classList.add('active');

    const idsToMark = Array.from(unseenChangeIds);
    unseenChangeIds = new Set();
    renderPendingRescheduleAlert();
    reloadFromFirstPage();

    try {
      await markReservationChangesSeen(supabase, idsToMark);
    } catch (error) {
      // Non-fatal — worst case the banner re-shows these on the next load.
    }
  });

  // BUG-04: acknowledge and hide without navigating/filtering — same
  // mark-as-seen call "Review" makes, minus the table filter, for an admin
  // who's already aware and just wants the banner gone.
  rescheduleAlertDismiss?.addEventListener('click', async () => {
    const idsToMark = Array.from(unseenChangeIds);
    unseenChangeIds = new Set();
    renderPendingRescheduleAlert();

    try {
      await markReservationChangesSeen(supabase, idsToMark);
    } catch (error) {
      // Non-fatal — worst case the banner re-shows these on the next load.
    }
  });
}

// One page of reservations (already filtered by status / search / review ids
// in the database), each row carrying its effective status and the payment
// summary fields the table shows. The RPC takes limit/offset, which is the same
// window .range(from, to) would select.
async function fetchReservationsPage(page, { status, search, ids }) {
  const { from } = getPageRange(page, RESERVATIONS_PAGE_SIZE);
  const { data, error } = await supabase.rpc('get_admin_reservations_page', {
    p_status: status,
    p_search: search || null,
    p_reservation_ids: ids,
    p_limit: RESERVATIONS_PAGE_SIZE,
    p_offset: from
  });

  if (error) throw error;

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    total: Number(data?.total) || 0,
    rows: rows.map((row) => ({
      ...row,
      package: row.package_name ? { package_name: row.package_name } : null
    }))
  };
}

// If the requested page no longer exists (reservations were removed or changed
// status since the last load, so there are fewer pages now), fall back to the
// last page that does exist instead of showing an empty table.
async function fetchPageWithClamp(page, filters) {
  let result = await fetchReservationsPage(page, filters);
  const lastPage = getTotalPages(result.total, RESERVATIONS_PAGE_SIZE);

  if (page > lastPage) {
    page = lastPage;
    result = await fetchReservationsPage(page, filters);
  }

  return { ...result, page };
}

// Stat cards, status chips and the sidebar badge. They describe ALL
// reservations, never the current search or page.
async function fetchReservationCounts() {
  const { data, error } = await supabase.rpc('get_admin_reservation_counts');
  if (error) throw error;
  return data || {};
}

function buildPaymentSummaryMap(rows) {
  return rows.reduce((map, row) => {
    map[row.reservation_id] = {
      reservation_id: row.reservation_id,
      computed_status: row.computed_status,
      outstanding_balance: row.outstanding_balance
    };
    return map;
  }, {});
}

// ids of every reservation with a customer-initiated cancellation or an
// approved/completed reschedule, whether or not it has been "seen". Used only
// by the Dashboard's "Review" deep link (?filter=changed).
async function fetchChangedReservationIds() {
  const [
    { data: byStatus, error: statusError },
    { data: byReschedule, error: rescheduleError }
  ] = await Promise.all([
    supabase
      .from('reservations')
      .select('reservation_id')
      .in('status', ['cancellation_requested', 'cancellation_approved', 'cancelled']),
    supabase
      .from('reschedule_requests')
      .select('reservation_id')
      .in('status', ['approved_pending_payment', 'completed'])
  ]);

  if (statusError) throw statusError;
  if (rescheduleError) throw rescheduleError;

  return new Set([...(byStatus || []), ...(byReschedule || [])].map((row) => row.reservation_id));
}

// Unfiltered — this file only ever uses the roster to resolve names for
// the read-only "Staff" summary column (no assignment picker lives here,
// that's on the reservation-details page), so a deactivated employee must
// still resolve to a name on reservations they're already assigned to
// rather than silently vanishing from this list.
async function fetchStaffRoster() {
  const { data, error } = await supabase
    .from('staff_roster')
    .select(`
      staff_id,
      first_name,
      last_name,
      staff_role
    `)
    .order('first_name', { ascending: true });

  if (error) throw error;
  return data || [];
}

// Staff names for the reservations on screen. The roster (a small table) is
// re-read on a full load / auto-refresh and reused when only the page, search
// or filter changed; the assignments are always read for the visible rows only.
async function fetchStaffForRows(rows, { refreshRoster }) {
  let directory = staffDirectory;
  let rosterOk = rosterLoaded;
  let ready = true;
  let message = '';

  if (refreshRoster || !rosterLoaded) {
    try {
      directory = await fetchStaffRoster();
      rosterOk = true;
    } catch (staffError) {
      directory = [];
      rosterOk = false;
      ready = false;
      message = getStaffDirectoryHint(staffError);
    }
  }

  let assignmentMap = {};
  if (ready) {
    try {
      assignmentMap = await fetchReservationAssignments(
        rows.map((row) => row.reservation_id).filter(Boolean),
        directory
      );
    } catch (assignmentError) {
      ready = false;
      message = getAssignmentSchemaHint(assignmentError);
      assignmentMap = {};
    }
  }

  return { directory, assignmentMap, ready, message, rosterOk };
}

async function fetchReservationAssignments(reservationIds, knownStaffRoster) {
  if (!reservationIds.length) return {};

  let response = await supabase
    .from('reservation_staff_assignments')
    .select(`
      reservation_id,
      roster_staff_id,
      assigned_at,
      assignment_note
    `)
    .in('reservation_id', reservationIds);

  if (response.error && isMissingColumnError(response.error, 'assignment_note')) {
    response = await supabase
      .from('reservation_staff_assignments')
      .select(`
        reservation_id,
        roster_staff_id,
        assigned_at
      `)
      .in('reservation_id', reservationIds);
  }

  const { data, error } = response;
  if (error) throw error;

  const staffById = (knownStaffRoster || []).reduce((map, staff) => {
    map[staff.staff_id] = staff;
    return map;
  }, {});

  return (data || []).reduce((map, assignment) => {
    if (!map[assignment.reservation_id]) map[assignment.reservation_id] = [];
    const staffProfile = staffById[assignment.roster_staff_id];
    if (staffProfile) {
      map[assignment.reservation_id].push({
        ...staffProfile,
        assigned_at: assignment.assigned_at || null,
        assignment_note: assignment.assignment_note || ''
      });
    }
    return map;
  }, {});
}

function refreshSidebarBadges() {
  return refreshAdminSidebarCounts({
    supabase,
    reservationBadgeEl: navReservationCount,
    paymentBadgeEl: navPaymentCount,
    contractBadgeEl: navContractCount,
    reviewBadgeEl: navReviewCount
  }).catch(() => {});
}

// silent=true is used by the auto-refresh triggers: it skips the
// "Loading..." message so existing rows stay on screen, and on failure it
// keeps the last-good data and fails quietly instead of blanking the table.
// full=false is used for page changes, searches and filter changes, which
// don't affect the stat cards, chips or banner, so only the page itself (and
// the staff for its rows) is fetched.
// keepNarrowing=true (page changes only) reuses the id narrowing of the list
// already on screen; every other load works it out afresh.
// Every call takes a request id; if a newer call starts before this one
// finishes, this one's result is discarded so a slow, older response can
// never overwrite a newer one.
async function loadData({ silent = false, full = true, keepNarrowing = false } = {}) {
  const requestId = ++latestRequestId;

  if (!silent) {
    setMessage(tableMessage, 'Loading reservations...');
  }

  try {
    const status = getActiveStatus();
    const ids = keepNarrowing ? appliedReviewIds : getReviewIdsFilter();

    const [pageResult, counts, unseenChanges] = await Promise.all([
      fetchPageWithClamp(reservationsCurrentPage, { status, search: activeSearch, ids }),
      full ? fetchReservationCounts() : Promise.resolve(null),
      full
        ? fetchUnseenReservationChanges(supabase).catch(() => ({ reservationIds: [], reservations: [] }))
        : Promise.resolve(null)
    ]);
    if (requestId !== latestRequestId) return;

    const staff = await fetchStaffForRows(pageResult.rows, { refreshRoster: full });
    if (requestId !== latestRequestId) return;

    if (full) {
      await refreshSidebarBadges();
      if (requestId !== latestRequestId) return;
    }

    appliedReviewIds = ids;
    reservationsCurrentPage = pageResult.page;
    reservationsTotal = pageResult.total;
    visibleReservations = pageResult.rows;
    paymentSummaryMap = buildPaymentSummaryMap(pageResult.rows);
    staffDirectory = staff.directory;
    rosterLoaded = staff.rosterOk;
    assignmentMapByReservationId = staff.assignmentMap;
    assignmentFeatureReady = staff.ready;
    assignmentFeatureMessage = staff.message;

    if (unseenChanges) {
      unseenChangeIds = new Set(unseenChanges.reservationIds || []);
      unseenChangeNames = unseenChanges.reservations || [];
    }
    if (counts) {
      renderStats(counts);
    }

    renderReservationsView(status);
  } catch (err) {
    if (requestId !== latestRequestId) return;

    if (silent) {
      // Quiet failure: keep whatever is already on screen; the next
      // successful trigger (focus, poll, or the user changing a filter)
      // resumes normal updates.
      console.warn('Auto-refresh failed, keeping last loaded reservations:', err.message);
      return;
    }
    setMessage(tableMessage, `Failed to load: ${err.message}`, true);
    if (full) {
      await refreshSidebarBadges();
    }
    reservationsTotal = 0;
    visibleReservations = [];
    renderTable([]);
    renderPagination(reservationsPagination, {
      totalItems: 0,
      currentPage: 1,
      pageSize: RESERVATIONS_PAGE_SIZE,
      onPageChange: () => {}
    });
  }
}

function goToReservationDetails(reservationId) {
  if (!reservationId) return;
  window.location.href = `/admin/reservation-details?id=${encodeURIComponent(reservationId)}`;
}

function wireTableActions() {
  reservationsBody?.addEventListener('click', (event) => {
    const row = event.target.closest('.reservation-row');
    if (!row) return;
    goToReservationDetails(row.dataset.reservationId);
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// Browsers can restore this page from the back-forward cache (e.g. the
// Manager hits Back after acting on reservation-details.html) without
// re-running any module code — pageshow with event.persisted (handled
// inside initAutoRefresh) is the only reliable signal for that case.
initAutoRefresh(() => loadData({ silent: true }));

function applyStatusFilterFromUrl() {
  const requestedStatus = new URLSearchParams(window.location.search).get('status');
  if (!requestedStatus || !chipsRow) return;
  const chip = chipsRow.querySelector(`[data-status="${requestedStatus}"]`);
  if (!chip) return;
  chipsRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  if (statusDropdown) statusDropdown.value = 'all';
}

// Legacy deep links (e.g. notification emails) point to
// /admin/reservations.html?reservation=<id>; forward them to the dedicated
// details page instead of opening the old in-page modal.
function redirectLegacyReservationLink() {
  const requestedId = new URLSearchParams(window.location.search).get('reservation');
  if (!requestedId) return false;
  window.location.replace(`/admin/reservation-details?id=${encodeURIComponent(requestedId)}`);
  return true;
}

//  run immediately (UI setup)
redirectLegacyReservationLink();
wireFilters();
applyStatusFilterFromUrl();
wireTableActions();

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ session, profile }) => {
    adminSession = session;
    currentRole = profile.role;
    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });
    // Arrived from the Dashboard's "Review" action (already marked seen
    // there) - apply the same "recently changed" filter here too. The ids are
    // looked up first so the list loads once, already narrowed.
    if (new URLSearchParams(window.location.search).get('filter') === 'changed') {
      try {
        const changedIds = await fetchChangedReservationIds();
        if (changedIds.size) {
          reviewFilterIds = changedIds;
          showPendingRescheduleOnly = true;
        }
      } catch (error) {
        // Non-fatal - fall back to the normal, unfiltered list.
      }
    }

    await loadData();
  }
});