import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { refreshAdminSidebarCounts, setBadgeCount } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import {
  getOccupiedScopesFromReservations,
  getScopeLabel as getSharedScopeLabel,
} from './reservation_availability.js';
import { PAGE_SIZE, paginate, renderPagination } from './pagination.js';

const tableMessage = document.getElementById('tableMessage');
const reservationsBody = document.getElementById('reservationsBody');
const reservationsPagination = document.getElementById('reservationsPagination');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const chipsRow = document.getElementById('chipsRow');
const refreshBtn = document.getElementById('refreshBtn');
const calendarToggleBtn = document.getElementById('calendarToggleBtn');
const calendarCollapse = document.getElementById('calendarCollapse');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');
const statIds = ['pending', 'approved', 'completed', 'total'];
const calendarGrid = document.getElementById('calendarGrid');
const calendarMonthLabel = document.getElementById('calendarMonthLabel');
const prevMonthBtn = document.getElementById('prevMonth');
const nextMonthBtn = document.getElementById('nextMonth');
const calendarMessage = document.getElementById('calendarMessage');
const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const rescheduleAlert = document.getElementById('rescheduleAlert');
const rescheduleAlertCount = document.getElementById('rescheduleAlertCount');
const rescheduleAlertText = document.getElementById('rescheduleAlertText');
const rescheduleAlertAction = document.getElementById('rescheduleAlertAction');
const blackoutModal = document.getElementById('blackoutModal');
const blackoutModalClose = document.getElementById('blackoutModalClose');
const blackoutCancelBtn = document.getElementById('blackoutCancelBtn');
const blackoutConfirmBtn = document.getElementById('blackoutConfirmBtn');
const blackoutModalTitle = document.getElementById('blackoutModalTitle');
const blackoutModalCopy = document.getElementById('blackoutModalCopy');
const blackoutModalWarning = document.getElementById('blackoutModalWarning');
const blackoutReasonField = document.getElementById('blackoutReasonField');
const blackoutReasonLabel = document.getElementById('blackoutReasonLabel');
const blackoutReasonInput = document.getElementById('blackoutReason');
const blackoutModalMessage = document.getElementById('blackoutModalMessage');
const calendarDayPanel = document.getElementById('calendarDayPanel');
const dayPanelDate = document.getElementById('dayPanelDate');
const dayPanelStatusPill = document.getElementById('dayPanelStatusPill');
const dayPanelCount = document.getElementById('dayPanelCount');
const dayPanelBookings = document.getElementById('dayPanelBookings');
const dayPanelFooter = document.getElementById('dayPanelFooter');
const dayPanelActionBtn = document.getElementById('dayPanelActionBtn');
const PAYMENT_TYPE_LABELS = {
  reservation_fee: 'Reservation Fee',
  down_payment: 'Down Payment',
  full_payment: 'Full Payment',
  reschedule_fee: 'Reschedule Fee',
  cancellation_fee: 'Cancellation Fee'
};
const PAYMENT_BALANCE_DUE_DAYS = 7;
const UPCOMING_ACTIVE_STATUSES = new Set(['pending', 'approved', 'rescheduled']);
const CAPACITY_BLOCKING_STATUSES = new Set([
  'pending', 'pending_review', 'for_finalization', 'for_contract_signing',
  'approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled'
]);

let reservationsCache = [];
let reservationsFiltered = [];
let reservationsCurrentPage = 1;
let blackouts = new Set();
let currentMonth = new Date();
let adminSession = null;
let currentRole = null;
const BLACKOUT_DATE_COLUMNS = ['closed_date', 'date'];
const BLACKOUT_REASON_COLUMNS = ['note', 'reason'];
let blackoutDateColumn = null;
let blackoutReasonColumn = null;
let pendingBlackoutDate = null;
let isCalendarExpanded = false;
let selectedCalendarDate = null;
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

function getBlackoutSchemaHint(error) {
  const message = error?.message || '';
  if (
    message.includes("Could not find the 'date' column of 'calendar_blackouts' in the schema cache")
    || message.includes('column calendar_blackouts.date does not exist')
  ) {
    return "calendar_blackouts exists, but Supabase cannot see a `date` column yet. Run the Step 7 SQL again, or add `date date` plus a unique index on `date`, then reload the schema cache.";
  }
  if (message.includes('null value in column "closed_date"')) {
    return "calendar_blackouts expects the blackout date in `closed_date`, not `date`. The page will now auto-detect that column, so reload and try again.";
  }
  if (message.includes('row-level security policy')) {
    return "Your session is logged in, but the `calendar_blackouts` RLS policy is still denying inserts. If `profiles` now uses `user_id`, recreate the blackout policy so it checks `p.user_id = auth.uid()` and confirm your profile row has `role = 'manager'`.";
  }
  if (
    message.includes("Could not find the 'note' column of 'calendar_blackouts' in the schema cache")
    || message.includes('column calendar_blackouts.note does not exist')
  ) {
    return "The blackout was not saved because `calendar_blackouts` does not have a `note` column yet. Add a `note text` column or update the table to store the close reason.";
  }
  return message;
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

async function resolveBlackoutDateColumn() {
  if (blackoutDateColumn) return blackoutDateColumn;

  let lastError = null;
  for (const column of BLACKOUT_DATE_COLUMNS) {
    const { error } = await supabase
      .from('calendar_blackouts')
      .select(column)
      .limit(1);

    if (!error) {
      blackoutDateColumn = column;
      return blackoutDateColumn;
    }

    lastError = error;
  }

  throw lastError || new Error('Unable to determine the blackout date column.');
}

async function resolveBlackoutReasonColumn() {
  if (blackoutReasonColumn) return blackoutReasonColumn;

  let lastError = null;
  for (const column of BLACKOUT_REASON_COLUMNS) {
    const { error } = await supabase
      .from('calendar_blackouts')
      .select(column)
      .limit(1);

    if (!error) {
      blackoutReasonColumn = column;
      return blackoutReasonColumn;
    }

    lastError = error;
  }

  throw lastError || new Error('Unable to determine the blackout reason column.');
}

function setModalMessage(message, isError = false) {
  if (!blackoutModalMessage) return;
  blackoutModalMessage.textContent = message;
  blackoutModalMessage.classList.toggle('error', isError);
}

function formatBlackoutDate(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-PH', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
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

function setCalendarExpanded(nextExpanded) {
  isCalendarExpanded = Boolean(nextExpanded);
  calendarCollapse?.classList.toggle('hidden', !isCalendarExpanded);
  calendarCollapse?.setAttribute('aria-hidden', String(!isCalendarExpanded));
  calendarToggleBtn?.classList.toggle('is-active', isCalendarExpanded);
  calendarToggleBtn?.setAttribute('aria-expanded', String(isCalendarExpanded));
  const toggleLabel = calendarToggleBtn?.querySelector('span');
  if (toggleLabel) {
    toggleLabel.textContent = isCalendarExpanded ? 'Hide calendar' : 'Show calendar';
  }
}

function formatShortMonthDay(dateIso) {
  return new Date(`${dateIso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function getReservationsForDate(dateIso) {
  return (reservationsCache || []).filter((r) => String(r.event_date || '').split('T')[0] === dateIso);
}

function closeBlackoutModal() {
  pendingBlackoutDate = null;
  blackoutModal?.classList.add('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'true');
  blackoutConfirmBtn?.removeAttribute('disabled');
  if (blackoutReasonInput) blackoutReasonInput.value = '';
  setModalMessage('');
}

function openBlackoutModal(dateIso) {
  pendingBlackoutDate = dateIso;
  if (blackoutModalTitle) {
    blackoutModalTitle.textContent = `Close ${formatShortMonthDay(dateIso)}?`;
  }
  if (blackoutModalCopy) {
    blackoutModalCopy.textContent = 'Customers will not be able to book this date.';
  }
  const bookingCount = getReservationsForDate(dateIso).length;
  if (blackoutModalWarning) {
    if (bookingCount > 0) {
      blackoutModalWarning.hidden = false;
      blackoutModalWarning.textContent = `This date has ${bookingCount} reservation${bookingCount !== 1 ? 's' : ''}. Closing prevents new bookings only — existing reservations are not affected.`;
    } else {
      blackoutModalWarning.hidden = true;
      blackoutModalWarning.textContent = '';
    }
  }
  if (blackoutReasonInput) blackoutReasonInput.value = '';
  setModalMessage('');
  blackoutModal?.classList.remove('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'false');
  blackoutReasonInput?.focus();
}

async function confirmBlackout() {
  if (!pendingBlackoutDate) return;

  blackoutConfirmBtn?.setAttribute('disabled', 'true');
  setModalMessage('Saving closed date...');

  try {
    const dateColumn = await resolveBlackoutDateColumn();
    const reason = blackoutReasonInput?.value.trim() || '';
    if (!reason) {
      setModalMessage('Please enter the reason for closing this date.', true);
      blackoutConfirmBtn?.removeAttribute('disabled');
      blackoutReasonInput?.focus();
      return;
    }

    const reasonColumn = await resolveBlackoutReasonColumn();
    const payload = {
      [dateColumn]: pendingBlackoutDate,
      [reasonColumn]: reason,
      created_by: adminSession?.user?.id || null
    };

    const { error } = await supabase
      .from('calendar_blackouts')
      .upsert(payload, { onConflict: dateColumn });

    if (error) throw error;

    blackouts.add(pendingBlackoutDate);
    setMessage(calendarMessage, `Closed ${formatBlackoutDate(pendingBlackoutDate)}.`, false);
    renderCalendar(approvedDatesFromCache());
    renderDayDetailPanel();
    closeBlackoutModal();
  } catch (error) {
    blackoutConfirmBtn?.removeAttribute('disabled');
    setModalMessage(getBlackoutSchemaHint(error), true);
  }
}

async function reopenDate(dateIso) {
  dayPanelActionBtn?.setAttribute('disabled', 'true');
  try {
    const dateColumn = await resolveBlackoutDateColumn();
    const { error } = await supabase
      .from('calendar_blackouts')
      .delete()
      .eq(dateColumn, dateIso);

    if (error) throw error;

    blackouts.delete(dateIso);
    setMessage(calendarMessage, `Reopened ${formatBlackoutDate(dateIso)}.`, false);
    renderCalendar(approvedDatesFromCache());
    renderDayDetailPanel();
  } catch (error) {
    setMessage(calendarMessage, `Failed to reopen date: ${getBlackoutSchemaHint(error)}`, true);
  } finally {
    dayPanelActionBtn?.removeAttribute('disabled');
  }
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

function getReservationPayments(reservation) {
  return reservation.payments || [];
}

function getReservationRescheduleRequests(reservation) {
  return reservation.reschedule_requests || [];
}

function getApprovedBasePaymentsTotal(reservation) {
  return getReservationPayments(reservation)
    .filter((payment) => (
      !payment.reschedule_request_id
      && String(payment.payment_status || '').toLowerCase() === 'approved'
    ))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function getReservationBalanceSummary(reservation) {
  const totalAmount = Number(reservation?.total_price || 0);
  const approvedTotal = getApprovedBasePaymentsTotal(reservation);
  const remainingBalance = Math.max(totalAmount - approvedTotal, 0);
  const eventDateKey = formatDateKey(reservation?.event_date);

  let dueDateKey = '';
  let dueDateLabel = 'No due date';
  if (eventDateKey) {
    const dueDate = new Date(`${eventDateKey}T00:00:00`);
    if (!Number.isNaN(dueDate.getTime())) {
      dueDate.setDate(dueDate.getDate() - PAYMENT_BALANCE_DUE_DAYS);
      dueDateKey = buildLocalDateKey(dueDate);
      dueDateLabel = formatReservationDate(dueDateKey);
    }
  }

  const isPastDue = Boolean(remainingBalance > 0 && dueDateKey && getTodayDateKey() > dueDateKey);
  const hasPartialPayment = approvedTotal > 0 && remainingBalance > 0;

  return {
    totalAmount,
    approvedTotal,
    remainingBalance,
    dueDateKey,
    dueDateLabel,
    isPastDue,
    hasPartialPayment,
    toneKey: remainingBalance <= 0 ? 'approved' : isPastDue ? 'unpaid' : 'pending',
    statusLabel: remainingBalance <= 0 ? 'Paid in Full' : isPastDue ? 'Overdue' : hasPartialPayment ? 'Partially Paid' : 'Initial Payment'
  };
}

function getPaymentTypeLabel(type) {
  return PAYMENT_TYPE_LABELS[type] || type || 'Payment';
}

function formatReadableKey(value) {
  return String(value || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getPendingPayment(reservation) {
  return getReservationPayments(reservation)
    .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
    .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
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

function paymentStatus(res) {
  const balance = getReservationBalanceSummary(res);
  const pendingPayment = getPendingPayment(res);
  if (pendingPayment) {
    return {
      label: 'Pending Review',
      key: 'pending',
      sublabel: `${getPaymentTypeLabel(pendingPayment.payment_type)} / ${formatCurrency(balance.remainingBalance)} remaining`
    };
  }

  if (balance.remainingBalance <= 0) {
    return { label: 'Paid', key: 'approved', sublabel: 'Paid in full' };
  }

  if (balance.hasPartialPayment) {
    return {
      label: balance.isPastDue ? 'Overdue' : 'Partially Paid',
      key: balance.toneKey,
      sublabel: `Remaining ${formatCurrency(balance.remainingBalance)} / Pay by ${balance.dueDateLabel}`
    };
  }

  const rescheduleRequest = getLatestOpenRescheduleRequest(res);
  if (rescheduleRequest && String(rescheduleRequest.status || '').toLowerCase() === 'approved_pending_payment') {
    return { label: 'Pending', key: 'pending', sublabel: 'Reschedule fee' };
  }

  return {
    label: balance.isPastDue ? 'Overdue' : 'Unpaid',
    key: balance.isPastDue ? 'unpaid' : 'pending',
    sublabel: balance.dueDateKey ? `Pay by ${balance.dueDateLabel}` : 'No payment yet'
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

function filterAndRender() {
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
  reservationsCurrentPage = 1;
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

async function fetchStaffRoster() {
  const { data, error } = await supabase
    .from('staff_roster')
    .select(`
      staff_id,
      first_name,
      last_name,
      staff_role
    `)
    .eq('is_active', true)
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

  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at, resubmitted_at';
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
    || isMissingColumnError(error, 'resubmitted_at')
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

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function bindCalendarAction(cell, handler) {
  cell.setAttribute('role', 'button');
  cell.tabIndex = 0;
  cell.addEventListener('click', handler);
  cell.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  });
}

function renderCalendar(bookedDates = []) {
  if (!calendarGrid) return;
  const start = startOfMonth(currentMonth);
  const bookedSet = new Set(bookedDates.map(d => d.split('T')[0]));
  const closedSet = blackouts;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIso = formatDateKey([
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-'));
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());

  calendarGrid.innerHTML = '';

  for (let index = 0; index < 42; index += 1) {
    const dateObj = new Date(gridStart);
    dateObj.setDate(gridStart.getDate() + index);
    const iso = formatDateKey([
      dateObj.getFullYear(),
      String(dateObj.getMonth() + 1).padStart(2, '0'),
      String(dateObj.getDate()).padStart(2, '0')
    ].join('-'));
    const isCurrentMonth = dateObj.getMonth() === currentMonth.getMonth();
    const isPast = dateObj < today;
    const isToday = iso === todayIso;
    const booked = bookedSet.has(iso);
    const closed = closedSet.has(iso);
    const formattedDate = formatBlackoutDate(iso);
    const dayCount = (reservationsCache || []).filter((r) =>
      String(r.event_date || '').split('T')[0] === iso &&
      CAPACITY_BLOCKING_STATUSES.has(String(r.status || '').toLowerCase())
    ).length;

    const cell = document.createElement('div');
    cell.className = 'calendar-cell';

    let titleText = `${formattedDate} is open.`;

    if (!isCurrentMonth) {
      cell.classList.add('outside-month');
      titleText = `${formattedDate} is outside the current month.`;
    } else {
      if (closed) {
        cell.classList.add('closed');
        titleText = `${formattedDate} is closed.`;
      }
      if (isPast) {
        titleText = `${formattedDate} is in the past.`;
      }
      if (booked) {
        titleText = dayCount
          ? `${formattedDate} has ${dayCount} reservation${dayCount !== 1 ? 's' : ''}.`
          : `${formattedDate} has bookings.`;
      }
      if (isToday) {
        cell.classList.add('today');
      }
      if (iso === selectedCalendarDate) {
        cell.classList.add('selected');
      }
    }

    cell.dataset.date = iso;
    cell.title = titleText;
    cell.setAttribute('aria-label', titleText);
    cell.innerHTML = `
      <span class="calendar-day-number">${dateObj.getDate()}</span>
      ${isCurrentMonth && booked ? `<span class="calendar-day-marker"><span class="calendar-day-dot"></span>${dayCount}</span>` : ''}
    `;

    if (isCurrentMonth) {
      cell.classList.add('is-actionable');
      bindCalendarAction(cell, () => selectCalendarDate(iso));
    } else {
      cell.setAttribute('aria-disabled', 'true');
    }
    calendarGrid.appendChild(cell);
  }
  calendarMonthLabel.textContent = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
}

function selectCalendarDate(dateIso) {
  selectedCalendarDate = dateIso;
  renderCalendar(approvedDatesFromCache());
  renderDayDetailPanel();
}

function renderDayDetailPanel() {
  if (!calendarDayPanel || !selectedCalendarDate) return;
  const iso = selectedCalendarDate;
  const dateObj = new Date(`${iso}T00:00:00`);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const isPast = dateObj < today;
  const closed = blackouts.has(iso);

  if (dayPanelDate) {
    dayPanelDate.textContent = dateObj.toLocaleDateString('en-PH', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  }

  if (dayPanelStatusPill) {
    dayPanelStatusPill.textContent = closed ? 'Closed' : 'Open';
    dayPanelStatusPill.className = `status-pill ${closed ? 'cancelled' : 'completed'}`;
  }

  const bookings = getReservationsForDate(iso);

  if (dayPanelCount) {
    dayPanelCount.textContent = bookings.length
      ? `${bookings.length} booking${bookings.length !== 1 ? 's' : ''} on this date`
      : 'No bookings on this date';
  }

  if (dayPanelBookings) {
    dayPanelBookings.innerHTML = bookings.map((reservation) => {
      const status = formatStatusPill(getEffectiveReservationStatus(reservation));
      return `
        <div class="day-booking-card">
          <div class="day-booking-head">
            <span class="day-booking-name">${escapeHtml(reservation.contact_name || 'Unknown customer')}</span>
            <span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
          </div>
          <p class="day-booking-meta">${escapeHtml(reservation.event_type || 'Event')} &middot; ${escapeHtml(reservation.event_time || 'No time selected')} &middot; ${escapeHtml(String(reservation.guest_count || 0))} guests</p>
          <a href="#" class="day-booking-link" data-reservation-id="${escapeHtml(reservation.reservation_id)}">View reservation &rarr;</a>
        </div>
      `;
    }).join('');
  }

  if (dayPanelFooter && dayPanelActionBtn) {
    if (isPast) {
      dayPanelFooter.hidden = true;
    } else {
      dayPanelFooter.hidden = false;
      dayPanelActionBtn.textContent = closed ? 'Reopen this date' : 'Close this date';
      dayPanelActionBtn.className = `day-panel-action ${closed ? 'action-reopen' : 'action-close'}`;
      dayPanelActionBtn.onclick = closed
        ? () => reopenDate(iso)
        : () => openBlackoutModal(iso);
    }
  }
}

async function fetchBlackouts() {
  try {
    const dateColumn = await resolveBlackoutDateColumn();
    const { data, error } = await supabase
      .from('calendar_blackouts')
      .select(dateColumn);
    if (error) throw error;
    blackouts = new Set((data || []).map(row => row[dateColumn]));
  } catch (err) {
    setMessage(calendarMessage, `Calendar note: ${getBlackoutSchemaHint(err)}`, true);
  }
}

function approvedDatesFromCache() {
  const dates = new Set(
    reservationsCache
      .map((reservation) => formatDateKey(reservation.event_date))
      .filter(Boolean)
  );

  return Array.from(dates).filter((dateKey) => getOccupiedScopesFromReservations(reservationsCache, dateKey).length > 0);
}

async function loadCalendar() {
  await fetchBlackouts();
  renderCalendar(approvedDatesFromCache());
  if (!selectedCalendarDate) {
    const now = new Date();
    selectedCalendarDate = formatDateKey([
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('-'));
  }
  renderDayDetailPanel();
}

async function loadData() {
  setMessage(tableMessage, 'Loading reservations...');
  try {
    assignmentFeatureReady = true;
    assignmentFeatureMessage = '';

    reservationsCache = await fetchReservations();
    staffDirectory = [];
    assignmentMapByReservationId = {};

    try {
      staffDirectory = await fetchStaffRoster();
    } catch (staffError) {
      assignmentFeatureReady = false;
      assignmentFeatureMessage = getStaffDirectoryHint(staffError);
    }

    if (assignmentFeatureReady) {
      try {
        assignmentMapByReservationId = await fetchReservationAssignments(
          reservationsCache.map((reservation) => reservation.reservation_id).filter(Boolean),
          staffDirectory
        );
      } catch (assignmentError) {
        assignmentFeatureReady = false;
        assignmentFeatureMessage = getAssignmentSchemaHint(assignmentError);
        assignmentMapByReservationId = {};
      }
    }

    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });
    renderStats(reservationsCache);
    filterAndRender();
    await loadCalendar();
    if (!assignmentFeatureReady) {
      setMessage(tableMessage, `Loaded reservations. Staff assignment note: ${assignmentFeatureMessage}`, true);
    }
  } catch (err) {
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

function wireCalendarNav() {
  prevMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar(approvedDatesFromCache());
  });
  nextMonthBtn?.addEventListener('click', () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar(approvedDatesFromCache());
  });
}

function wireBlackoutModal() {
  blackoutCancelBtn?.addEventListener('click', closeBlackoutModal);
  blackoutModalClose?.addEventListener('click', closeBlackoutModal);
  blackoutConfirmBtn?.addEventListener('click', confirmBlackout);
  blackoutModal?.addEventListener('click', (event) => {
    if (event.target === blackoutModal) closeBlackoutModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingBlackoutDate) closeBlackoutModal();
  });
}

function goToReservationDetails(reservationId) {
  if (!reservationId) return;
  window.location.href = `/admin/reservation-details.html?id=${encodeURIComponent(reservationId)}`;
}

function wireDayPanelBookingLinks() {
  dayPanelBookings?.addEventListener('click', (event) => {
    const link = event.target.closest('.day-booking-link');
    if (!link) return;
    event.preventDefault();
    goToReservationDetails(link.dataset.reservationId);
  });
}

function wireTableActions() {
  reservationsBody?.addEventListener('click', (event) => {
    const row = event.target.closest('.reservation-row');
    if (!row) return;
    goToReservationDetails(row.dataset.reservationId);
  });
}

function wireCalendarToggle() {
  calendarToggleBtn?.addEventListener('click', () => {
    setCalendarExpanded(!isCalendarExpanded);
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

/*logoutBtn?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  redirectLogin();
});*/

refreshBtn?.addEventListener('click', loadData);

/*supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') redirectLogin();
});*/

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
setCalendarExpanded(false);
wireFilters();
applyStatusFilterFromUrl();
wireTableActions();
wireCalendarToggle();
wireCalendarNav();
wireBlackoutModal();
wireDayPanelBookingLinks();

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
    await loadData();
  }
});
