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
import { getPaymentStatusPillMeta } from './reservation_shared.js';
import { PAGE_SIZE, paginate, renderPagination, getTotalPages } from './pagination.js';
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
const UPCOMING_ACTIVE_STATUSES = new Set(['pending', 'approved', 'rescheduled']);

let reservationsCache = [];
let reservationsFiltered = [];
let reservationsCurrentPage = 1;
let paymentSummaryMap = {};
let adminSession = null;
let currentRole = null;
let staffDirectory = [];
let assignmentMapByReservationId = {};
let assignmentFeatureReady = true;
let assignmentFeatureMessage = '';
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

function buildLocalDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function getTodayDateKey() {
  return buildLocalDateKey(new Date());
}

function parseReservationTimeParts(timeValue) {
  const value = String(timeValue || '').trim();
  if (!value) return null;

  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return {
      hours: Number(match[1]),
      minutes: Number(match[2])
    };
  }

  const parsed = new Date(`1970-01-01 ${value}`);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    hours: parsed.getHours(),
    minutes: parsed.getMinutes()
  };
}

function getReservationEventDateTime(reservation) {
  const dateKey = formatDateKey(reservation?.event_date);
  if (!dateKey) return null;

  const timeParts = parseReservationTimeParts(reservation?.event_time);
  const eventDate = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(eventDate.getTime())) return null;

  if (timeParts) {
    eventDate.setHours(timeParts.hours, timeParts.minutes, 0, 0);
  }

  return eventDate;
}

function getEffectiveReservationStatus(reservation) {
  const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
    return normalizedStatus;
  }

  const eventDateTime = getReservationEventDateTime(reservation);
  if (eventDateTime && eventDateTime.getTime() < Date.now() && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
    return 'completed';
  }

  if (normalizedStatus === 'confirmed') {
    return 'approved';
  }

  return normalizedStatus;
}

function getReservationTimeSortValue(timeValue) {
  const value = String(timeValue || '').trim();
  if (!value) return null;

  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return (Number(match[1]) * 60) + Number(match[2]);
  }

  const parsed = new Date(`1970-01-01T${value}`);
  if (!Number.isNaN(parsed.getTime())) {
    return (parsed.getHours() * 60) + parsed.getMinutes();
  }

  return null;
}

function isUpcomingReservation(reservation) {
  const status = getEffectiveReservationStatus(reservation);
  const eventDateKey = formatDateKey(reservation?.event_date);
  return Boolean(eventDateKey)
    && eventDateKey >= getTodayDateKey()
    && UPCOMING_ACTIVE_STATUSES.has(status);
}

function sortReservationsForView(list, status) {
  const rows = [...list];
  if (status !== 'upcoming') return rows;

  return rows.sort((left, right) => {
    const leftDateKey = formatDateKey(left.event_date);
    const rightDateKey = formatDateKey(right.event_date);
    if (leftDateKey !== rightDateKey) {
      return leftDateKey.localeCompare(rightDateKey);
    }

    const leftTime = getReservationTimeSortValue(left.event_time);
    const rightTime = getReservationTimeSortValue(right.event_time);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return new Date(left.created_at || 0) - new Date(right.created_at || 0);
  });
}

function getEmptyFilterMessage(status) {
  if (showPendingRescheduleOnly) return 'No pending reschedule requests match the current filter.';
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
  window.location.replace('/admin/index.html');
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

async function fetchPaymentSummaries(reservationIds) {
  if (!reservationIds.length) return {};
  const { data, error } = await supabase
    .from('reservation_payment_summary')
    .select('reservation_id, reservation_total, total_paid, outstanding_balance, latest_payment_date, computed_status')
    .in('reservation_id', reservationIds);
  if (error) throw error;
  return (data || []).reduce((map, row) => {
    map[row.reservation_id] = row;
    return map;
  }, {});
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
    .find((request) => ['pending', 'approved_pending_payment'].includes(String(request.status || '').toLowerCase())) || null;
}

function hasPendingRescheduleRequest(reservation) {
  return getReservationRescheduleRequests(reservation)
    .some((request) => String(request.status || '').toLowerCase() === 'pending');
}

function getPendingRescheduleRequestCount(list) {
  return list.filter((reservation) => hasPendingRescheduleRequest(reservation)).length;
}

function renderPendingRescheduleAlert(list) {
  if (!rescheduleAlert || !rescheduleAlertCount || !rescheduleAlertText) return;

  const pendingCount = getPendingRescheduleRequestCount(list);
  if (!pendingCount) {
    showPendingRescheduleOnly = false;
    rescheduleAlert.hidden = true;
    rescheduleAlert.classList.add('hidden');
    rescheduleAlert.setAttribute('aria-hidden', 'true');
    rescheduleAlertCount.textContent = '0';
    rescheduleAlertText.textContent = 'Customers have requested schedule changes that still need admin review.';
    return;
  }

  rescheduleAlert.hidden = false;
  rescheduleAlert.classList.remove('hidden');
  rescheduleAlert.setAttribute('aria-hidden', 'false');
  rescheduleAlertCount.textContent = String(pendingCount);
  rescheduleAlertText.textContent = pendingCount === 1
    ? '1 customer has requested a schedule change that still needs admin review.'
    : `${pendingCount} customers have requested schedule changes that still need admin review.`;
  if (rescheduleAlertAction) {
    rescheduleAlertAction.textContent = 'Review Requests';
  }
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

function matchesSearch(res, term) {
  if (!term) return true;
  const needle = term.toLowerCase();
  return (res.contact_name || '').toLowerCase().includes(needle)
      || (res.contact_email || '').toLowerCase().includes(needle)
      || (res.package?.package_name || '').toLowerCase().includes(needle)
      || (res.reservation_number || '').toLowerCase().includes(needle);
}

function matchesStatus(res, status) {
  if (status === 'all') return true;
  if (status === 'upcoming') return isUpcomingReservation(res);
  return getEffectiveReservationStatus(res) === status;
}

function renderStats(list) {
  const counts = {
    upcoming: 0, pending: 0, approved: 0, declined: 0, completed: 0,
    cancelled: 0, rescheduled: 0, total: list.length
  };
  list.forEach(r => {
    const k = getEffectiveReservationStatus(r);
    if (counts[k] !== undefined) counts[k] += 1;
    if (isUpcomingReservation(r)) counts.upcoming += 1;
  });
  statIds.forEach(id => {
    const el = document.getElementById(`stat-${id}`);
    if (el) el.textContent = counts[id] ?? 0;
  });
  setBadgeCount(navReservationCount, counts.pending);
  chipsRow?.querySelectorAll('.chip').forEach(chip => {
    const status = chip.dataset.status;
    const val = status === 'all' ? counts.total : (counts[status] ?? 0);
    chip.textContent = `${chip.textContent.split('(')[0].trim()} (${val})`;
  });
  renderPendingRescheduleAlert(list);
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
        <td data-label="Payment">
          <div class="table-summary-stack">
            <span class="status-pill ${escapeHtml(pay.key)}">${escapeHtml(pay.label)}</span>
            <span class="table-sub">${escapeHtml(pay.sublabel || '')}</span>
          </div>
        </td>
        <td class="table-status-cell" data-label="Status"><span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span></td>
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






function filterAndRender({ resetPage = true } = {}) {
  const term = searchInput?.value.trim().toLowerCase();
  const dropdownStatus = statusDropdown?.value || 'all';
  const chipStatus = chipsRow?.querySelector('.chip.active')?.dataset.status || 'all';
  const status = dropdownStatus !== 'all' ? dropdownStatus : chipStatus;
  if (!getPendingRescheduleRequestCount(reservationsCache)) {
    showPendingRescheduleOnly = false;
  }
  const filtered = sortReservationsForView(
    reservationsCache.filter(r => matchesStatus(r, status) && matchesSearch(r, term) && (!showPendingRescheduleOnly || hasPendingRescheduleRequest(r))),
    status
  );
  renderStats(reservationsCache);
  reservationsFiltered = filtered;
  if (resetPage) {
    reservationsCurrentPage = 1;
  } else {
    reservationsCurrentPage = Math.min(reservationsCurrentPage, getTotalPages(filtered.length, PAGE_SIZE));
  }
  renderReservationsPage();
  setMessage(tableMessage, filtered.length ? '' : getEmptyFilterMessage(status), false);
}

function renderReservationsPage() {
  renderTable(paginate(reservationsFiltered, reservationsCurrentPage, PAGE_SIZE));
  renderPagination(reservationsPagination, {
    totalItems: reservationsFiltered.length,
    currentPage: reservationsCurrentPage,
    pageSize: PAGE_SIZE,
    onPageChange: (page) => {
      reservationsCurrentPage = page;
      renderReservationsPage();
    }
  });
}

function wireFilters() {
  searchInput?.addEventListener('input', filterAndRender);
  statusDropdown?.addEventListener('change', () => {
    showPendingRescheduleOnly = false;
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    filterAndRender();
  });
  chipsRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    showPendingRescheduleOnly = false;
    chipsRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    statusDropdown.value = 'all';
    filterAndRender();
  });
  rescheduleAlertAction?.addEventListener('click', () => {
    showPendingRescheduleOnly = true;
    statusDropdown.value = 'all';
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chipsRow?.querySelector('[data-status="all"]')?.classList.add('active');
    filterAndRender();
  });
}

async function fetchReservations() {
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      reservation_number,
      contact_name,
      contact_email,
      contact_phone,
      status,
      event_type,
      event_date,
      event_time,
      start_time,
      event_end_time,
      duration_hours,
      guest_count,
      location_type,
      venue_location,
      special_requests,
      total_price,
      created_at,
      booking_scope,
      package:package_id ( package_name, duration_hours, booking_scope )
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const list = reservations || [];
  const reservationIds = list.map((reservation) => reservation.reservation_id).filter(Boolean);

  if (!reservationIds.length) return list;

  const [
    contracts,
    { data: payments, error: paymentsError },
    { data: rescheduleRequests, error: rescheduleError }
  ] = await Promise.all([
    fetchReservationContracts(reservationIds),
    supabase
      .from('payment')
      .select(`
        payment_id,
        reservation_id,
        reschedule_request_id,
        payment_type,
        payment_method,
        amount,
        payment_status,
        reference_number,
        payment_date,
        notes,
        proof_url,
        cash_payment_date,
        submitted_at,
        verified_at
      `)
      .in('reservation_id', reservationIds)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('reschedule_requests')
      .select(`
        reschedule_request_id,
        reservation_id,
        original_date,
        original_time,
        requested_date,
        requested_time,
        status,
        requested_at,
        reviewed_at
      `)
      .in('reservation_id', reservationIds)
      .order('requested_at', { ascending: false })
  ]);

  if (paymentsError) throw paymentsError;
  if (rescheduleError) throw rescheduleError;

  const contractsByReservationId = (contracts || []).reduce((map, contract) => {
    map[contract.reservation_id] = contract;
    return map;
  }, {});

  const paymentsByReservationId = (payments || []).reduce((map, payment) => {
    if (!map[payment.reservation_id]) map[payment.reservation_id] = [];
    map[payment.reservation_id].push(payment);
    return map;
  }, {});

  const requestsByReservationId = (rescheduleRequests || []).reduce((map, request) => {
    if (!map[request.reservation_id]) map[request.reservation_id] = [];
    map[request.reservation_id].push(request);
    return map;
  }, {});

  return list.map((reservation) => ({
    ...reservation,
    contracts: contractsByReservationId[reservation.reservation_id]
      ? [contractsByReservationId[reservation.reservation_id]]
      : [],
    payments: paymentsByReservationId[reservation.reservation_id] || [],
    reschedule_requests: requestsByReservationId[reservation.reservation_id] || []
  }));
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

async function fetchReservationContracts(reservationIds) {
  if (!reservationIds.length) return [];

  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at';
  const fallbackSelect = 'reservation_id, contract_url, verified_date, template_id';
  const { data, error } = await supabase
    .from('reservation_contracts')
    .select(extendedSelect)
    .in('reservation_id', reservationIds);

  if (!error) {
    return data || [];
  }

  if (
    isMissingColumnError(error, 'review_status')
    || isMissingColumnError(error, 'review_notes')
    || isMissingColumnError(error, 'reviewed_at')
  ) {
    const fallback = await supabase
      .from('reservation_contracts')
      .select(fallbackSelect)
      .in('reservation_id', reservationIds);

    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }

  throw error;
}






async function loadData({ silent = false } = {}) {
  if (!silent) {
    setMessage(tableMessage, 'Loading reservations...');
  }
  try {
    let nextAssignmentFeatureReady = true;
    let nextAssignmentFeatureMessage = '';

    const freshReservations = await fetchReservations();
    const freshReservationIds = freshReservations.map((r) => r.reservation_id).filter(Boolean);

    const freshPaymentSummaryMap = await fetchPaymentSummaries(freshReservationIds).catch(() => ({}));

    let freshStaffDirectory = [];
    let freshAssignmentMap = {};

    try {
      freshStaffDirectory = await fetchStaffRoster();
    } catch (staffError) {
      nextAssignmentFeatureReady = false;
      nextAssignmentFeatureMessage = getStaffDirectoryHint(staffError);
    }

    if (nextAssignmentFeatureReady) {
      try {
        freshAssignmentMap = await fetchReservationAssignments(freshReservationIds, freshStaffDirectory);
      } catch (assignmentError) {
        nextAssignmentFeatureReady = false;
        nextAssignmentFeatureMessage = getAssignmentSchemaHint(assignmentError);
        freshAssignmentMap = {};
      }
    }


    reservationsCache = freshReservations;
    paymentSummaryMap = freshPaymentSummaryMap;
    staffDirectory = freshStaffDirectory;
    assignmentMapByReservationId = freshAssignmentMap;
    assignmentFeatureReady = nextAssignmentFeatureReady;
    assignmentFeatureMessage = nextAssignmentFeatureMessage;

    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    }).catch(() => {});
    renderStats(reservationsCache);
    filterAndRender({ resetPage: !silent });  
    if (!assignmentFeatureReady) {
      setMessage(tableMessage, `Loaded reservations. Staff assignment note: ${assignmentFeatureMessage}`, true);
    }
  } catch (err) {
    if (silent) {
      // Quiet failure: keep whatever is already on screen; the next
      // successful trigger (focus, poll, or the user changing a filter)
      // resumes normal updates.
      console.warn('Auto-refresh failed, keeping last loaded reservations:', err.message);
      return;
    }
    setMessage(tableMessage, `Failed to load: ${err.message}`, true);
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    }).catch(() => {});
    renderTable([]);
  }
}

function goToReservationDetails(reservationId) {
  if (!reservationId) return;
  window.location.href = `/admin/reservation-details.html?id=${encodeURIComponent(reservationId)}`;
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
  window.location.replace(`/admin/reservation-details.html?id=${encodeURIComponent(requestedId)}`);
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
    await loadData();
  }
});