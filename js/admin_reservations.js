import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';

const tableMessage = document.getElementById('tableMessage');
const reservationsBody = document.getElementById('reservationsBody');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const chipsRow = document.getElementById('chipsRow');
const refreshBtn = document.getElementById('refreshBtn');
const calendarToggleBtn = document.getElementById('calendarToggleBtn');
const calendarCollapse = document.getElementById('calendarCollapse');
const navReservationCount = document.getElementById('navReservationCount');
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
const blackoutModal = document.getElementById('blackoutModal');
const blackoutModalClose = document.getElementById('blackoutModalClose');
const blackoutCancelBtn = document.getElementById('blackoutCancelBtn');
const blackoutConfirmBtn = document.getElementById('blackoutConfirmBtn');
const blackoutModalEyebrow = document.getElementById('blackoutModalEyebrow');
const blackoutModalTitle = document.getElementById('blackoutModalTitle');
const blackoutModalCopy = document.getElementById('blackoutModalCopy');
const blackoutSelectedDate = document.getElementById('blackoutSelectedDate');
const blackoutReasonField = document.getElementById('blackoutReasonField');
const blackoutReasonLabel = document.getElementById('blackoutReasonLabel');
const blackoutReasonInput = document.getElementById('blackoutReason');
const blackoutModalMessage = document.getElementById('blackoutModalMessage');
const reservationDetailsModal = document.getElementById('reservationDetailsModal');
const reservationDetailsClose = document.getElementById('reservationDetailsClose');
const reservationDetailsDismiss = document.getElementById('reservationDetailsDismiss');
const reservationDetailsHero = document.getElementById('reservationDetailsHero');
const reservationDetailsMeta = document.getElementById('reservationDetailsMeta');
const reservationSummaryGrid = document.getElementById('reservationSummaryGrid');
const reservationPaymentSection = document.getElementById('reservationPaymentSection');
const reservationContractSection = document.getElementById('reservationContractSection');
const reservationStaffSection = document.getElementById('reservationStaffSection');
const reservationActionsSection = document.getElementById('reservationActionsSection');
const reservationDetailsMessage = document.getElementById('reservationDetailsMessage');
const assignmentModal = document.getElementById('assignmentModal');
const assignmentModalClose = document.getElementById('assignmentModalClose');
const assignmentCancelBtn = document.getElementById('assignmentCancelBtn');
const assignmentSaveBtn = document.getElementById('assignmentSaveBtn');
const assignmentModalMessage = document.getElementById('assignmentModalMessage');
const assignmentSearchInput = document.getElementById('assignmentSearchInput');
const assignmentStaffList = document.getElementById('assignmentStaffList');
const assignmentReservationSummary = document.getElementById('assignmentReservationSummary');
const assignmentReservationMeta = document.getElementById('assignmentReservationMeta');
const assignmentSelectionCount = document.getElementById('assignmentSelectionCount');
const assignmentNoteInput = document.getElementById('assignmentNoteInput');
const BOOKING_LIMITS = {
  onsite_vip: 1,
  onsite_main_hall: 1,
  offsite: 1
};
const PAYMENT_METHOD_LABELS = {
  card: 'Card',
  bancnet: 'BancNet',
  gcash_maya: 'GCash/Maya',
  cash: 'Cash'
};
const PAYMENT_TYPE_LABELS = {
  reservation_fee: 'Reservation Fee',
  down_payment: 'Down Payment',
  full_payment: 'Full Payment',
  reschedule_fee: 'Reschedule Fee'
};
const PAYMENT_BALANCE_DUE_DAYS = 7;

let reservationsCache = [];
let blackouts = new Set();
let currentMonth = new Date();
let adminSession = null;
const BLACKOUT_DATE_COLUMNS = ['closed_date', 'date'];
const BLACKOUT_REASON_COLUMNS = ['note', 'reason'];
let blackoutDateColumn = null;
let blackoutReasonColumn = null;
let pendingBlackoutDate = null;
let pendingBlackoutAction = 'close';
let isCalendarExpanded = false;
let staffDirectory = [];
let assignmentMapByReservationId = {};
let assignmentFeatureReady = true;
let assignmentFeatureMessage = '';
let activeAssignmentReservationId = null;
let assignmentSelection = new Set();
let assignmentSearchTerm = '';
let activeDetailsReservationId = null;
let reservationDetailsFlash = null;

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
    return "Your session is logged in, but the `calendar_blackouts` RLS policy is still denying inserts. If `profiles` now uses `user_id`, recreate the blackout policy so it checks `p.user_id = auth.uid()` and confirm your profile row has `role = 'admin'`.";
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
  if (message.includes('row-level security policy')) {
    return 'Staff accounts could not be loaded because the profiles RLS policy is blocking admin access. Add an admin read-all policy for profiles.';
  }
  return message || 'Staff accounts could not be loaded right now.';
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
  return `P${Number(value || 0).toLocaleString()}`;
}

function formatDateTime(value) {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
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

function getReservationById(reservationId) {
  return reservationsCache.find((reservation) => String(reservation.reservation_id) === String(reservationId)) || null;
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

function buildDetailCard(label, value, options = {}) {
  const classes = ['detail-card'];
  if (options.full) classes.push('full');
  const valueClass = options.subtle ? 'detail-value subtle' : 'detail-value';
  return `
    <div class="${classes.join(' ')}">
      <span class="detail-label">${escapeHtml(label)}</span>
      <div class="${valueClass}">${options.raw ? value : escapeHtml(value)}</div>
    </div>
  `;
}

function getStaffDisplayName(profile) {
  const nameParts = [
    profile?.first_name,
    profile?.middle_name,
    profile?.last_name
  ].filter(Boolean);

  return nameParts.join(' ') || profile?.email || 'Unnamed staff';
}

function formatStaffRole(staffRole) {
  const normalized = String(staffRole || '').trim().toLowerCase();
  if (!normalized) return 'Staff';

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAssignedStaff(reservationId) {
  return assignmentMapByReservationId[reservationId] || [];
}

function getAssignmentNoteForReservation(reservationId) {
  const assignedStaff = getAssignedStaff(reservationId);
  const noteHolder = assignedStaff.find((staff) => String(staff?.assignment_note || '').trim());
  return String(noteHolder?.assignment_note || '').trim();
}

function canAssignEmployees(reservation) {
  return ['approved', 'confirmed'].includes(String(reservation?.status || '').toLowerCase());
}

function getAssignmentAvailability(reservation) {
  const disabledReason = !assignmentFeatureReady
    ? assignmentFeatureMessage
    : (!staffDirectory.length ? 'No staff accounts are available yet.' : '');

  return {
    canAssign: canAssignEmployees(reservation),
    disabled: Boolean(disabledReason),
    disabledReason
  };
}

function setCalendarExpanded(nextExpanded) {
  isCalendarExpanded = Boolean(nextExpanded);
  calendarCollapse?.classList.toggle('hidden', !isCalendarExpanded);
  calendarCollapse?.setAttribute('aria-hidden', String(!isCalendarExpanded));
  calendarToggleBtn?.classList.toggle('is-active', isCalendarExpanded);
  calendarToggleBtn?.setAttribute('aria-expanded', String(isCalendarExpanded));
  const toggleLabel = calendarToggleBtn?.querySelector('span');
  if (toggleLabel) {
    toggleLabel.textContent = isCalendarExpanded ? 'Hide Availability Calendar' : 'Availability Calendar';
  }
}

function closeBlackoutModal() {
  pendingBlackoutDate = null;
  pendingBlackoutAction = 'close';
  blackoutModal?.classList.add('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'true');
  blackoutConfirmBtn?.removeAttribute('disabled');
  if (blackoutReasonInput) blackoutReasonInput.value = '';
  setModalMessage('');
}

function configureBlackoutModal(action) {
  const isReopen = action === 'reopen';
  if (blackoutModalEyebrow) {
    blackoutModalEyebrow.textContent = isReopen ? 'Reopen calendar date' : 'Close calendar date';
  }
  if (blackoutModalTitle) {
    blackoutModalTitle.textContent = isReopen ? 'Confirm date reopening' : 'Confirm date closure';
  }
  if (blackoutModalCopy) {
    blackoutModalCopy.textContent = isReopen
      ? 'You are about to reopen this date on the admin calendar.'
      : 'You are about to close this date on the admin calendar.';
  }
  if (blackoutReasonField) {
    blackoutReasonField.hidden = isReopen;
  }
  if (blackoutReasonLabel) {
    blackoutReasonLabel.textContent = 'Reason for closing this date';
  }
  if (blackoutReasonInput) {
    blackoutReasonInput.placeholder = 'Enter the reason for closing this date...';
  }
  if (blackoutConfirmBtn) {
    blackoutConfirmBtn.textContent = isReopen ? 'Confirm reopening' : 'Confirm closure';
  }
}

function openBlackoutModal(dateIso, action = 'close') {
  pendingBlackoutDate = dateIso;
  pendingBlackoutAction = action;
  configureBlackoutModal(action);
  if (blackoutSelectedDate) blackoutSelectedDate.textContent = formatBlackoutDate(dateIso);
  if (blackoutReasonInput) blackoutReasonInput.value = '';
  setModalMessage('');
  blackoutModal?.classList.remove('hidden');
  blackoutModal?.setAttribute('aria-hidden', 'false');
  if (action === 'reopen') {
    blackoutConfirmBtn?.focus();
  } else {
    blackoutReasonInput?.focus();
  }
}

async function confirmBlackout() {
  if (!pendingBlackoutDate) return;

  blackoutConfirmBtn?.setAttribute('disabled', 'true');
  setModalMessage(pendingBlackoutAction === 'reopen' ? 'Reopening date...' : 'Saving closed date...');

  try {
    const dateColumn = await resolveBlackoutDateColumn();
    let error = null;

    if (pendingBlackoutAction === 'reopen') {
      ({ error } = await supabase
        .from('calendar_blackouts')
        .delete()
        .eq(dateColumn, pendingBlackoutDate));
    } else {
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

      ({ error } = await supabase
        .from('calendar_blackouts')
        .upsert(payload, { onConflict: dateColumn }));
    }

    if (error) throw error;

    if (pendingBlackoutAction === 'reopen') {
      blackouts.delete(pendingBlackoutDate);
      setMessage(calendarMessage, `Reopened ${formatBlackoutDate(pendingBlackoutDate)}.`, false);
    } else {
      blackouts.add(pendingBlackoutDate);
      setMessage(calendarMessage, `Closed ${formatBlackoutDate(pendingBlackoutDate)}.`, false);
    }
    renderCalendar(approvedDatesFromCache());
    closeBlackoutModal();
  } catch (error) {
    blackoutConfirmBtn?.removeAttribute('disabled');
    setModalMessage(getBlackoutSchemaHint(error), true);
  }
}

async function validateAdmin() {
  const { session, profile } = await verifyAdminSession(supabase);
  if (!session) {
    await supabase.auth.signOut();
    return redirectLogin();
  }
  adminSession = session;
  populatePortalIdentity({
    profile,
    session,
    nameEl: sidebarNameEl,
    emailEl: sidebarEmailEl,
    roleEl: sidebarRolePillEl,
    fallbackLabel: 'Admin'
  });
  return session;
}

function redirectLogin() {
  window.location.replace('./admin_login.html');
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

function getBookingScope(reservation) {
  const locationType = (reservation?.location_type || '').toLowerCase();
  const packageName = (reservation?.package?.package_name || '').toLowerCase();

  if (locationType === 'offsite') return 'offsite';
  if (locationType === 'onsite' && packageName.includes('main hall')) return 'onsite_main_hall';
  if (locationType === 'onsite' && packageName.includes('vip')) return 'onsite_vip';
  return null;
}

function getScopeLabel(scope) {
  return {
    onsite_vip: 'VIP lounge',
    onsite_main_hall: 'Main Hall',
    offsite: 'offsite service'
  }[scope] || 'selected booking type';
}

function countApprovedReservationsForScope(dateKey, scope, excludeReservationId = null) {
  return reservationsCache.filter((reservation) => {
    const reservationDateKey = String(reservation.event_date || '').split('T')[0];
    const reservationStatus = (reservation.status || '').toLowerCase();
    return reservationDateKey === dateKey
      && reservationStatus === 'approved'
      && getBookingScope(reservation) === scope
      && String(reservation.reservation_id) !== String(excludeReservationId);
  }).length;
}

function getApprovalLimitMessage(reservation) {
  const scope = getBookingScope(reservation);
  if (!scope) return '';

  const dateKey = String(reservation.event_date || '').split('T')[0];
  if (!dateKey) return 'Cannot approve this reservation because it has no event date.';

  const limit = BOOKING_LIMITS[scope] || 1;
  const approvedCount = countApprovedReservationsForScope(dateKey, scope, reservation.reservation_id);
  if (approvedCount < limit) return '';

  const formattedDate = new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return `Cannot approve this reservation. The ${getScopeLabel(scope)} is already full on ${formattedDate}.`;
}

function isMissingColumnError(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column reservation_contracts.${columnName} does not exist`)
    || message.includes(`column reservation_staff_assignments.${columnName} does not exist`);
}

function getContractReviewMeta(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  const reviewStatus = String(contract?.review_status || '').toLowerCase();
  const reservationStatus = String(reservation?.status || '').toLowerCase();
  const resubmittedAt = contract?.resubmitted_at ? formatDateTime(contract.resubmitted_at) : '';

  if (!contract) {
    return {
      key: 'default',
      label: 'Contract missing',
      verification: 'No contract file uploaded yet',
      note: '',
      reviewedAt: '',
      resubmittedAt: '',
      hasFile: false,
      contract
    };
  }

  if (reviewStatus === 'verified' || contract?.verified_date) {
    return {
      key: 'approved',
      label: 'Verified contract',
      verification: contract?.verified_date ? formatDateTime(contract.verified_date) : 'Verified',
      note: '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'resubmission_requested' || (!reviewStatus && reservationStatus === 'resubmission_requested')) {
    return {
      key: 'resubmission_requested',
      label: 'Resubmission requested',
      verification: 'Waiting for customer re-upload',
      note: contract?.review_notes || 'Customer needs to upload a corrected signed contract.',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt: '',
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'pending_review' && contract?.resubmitted_at) {
    return {
      key: 'resubmitted',
      label: 'Replacement submitted',
      verification: 'Corrected contract is ready for review',
      note: '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'pending_review' || contract?.contract_url) {
    return {
      key: 'pending',
      label: 'Pending review',
      verification: 'Awaiting contract review',
      note: contract?.review_notes || '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  return {
    key: 'default',
    label: 'Contract missing',
    verification: 'No contract file uploaded yet',
    note: '',
    reviewedAt: '',
    resubmittedAt: '',
    hasFile: false,
    contract
  };
}

function contractStatus(res) {
  return getContractReviewMeta(res);
}

function getReservationApprovalState(reservation) {
  const contract = getContractReviewMeta(reservation);
  if (!contract.hasFile) {
    return {
      canApprove: false,
      reason: 'The reservation cannot be approved until the customer uploads a signed contract.'
    };
  }

  if (contract.key !== 'approved') {
    return {
      canApprove: false,
      reason: 'Verify the signed contract first before approving the reservation.'
    };
  }

  return { canApprove: true, reason: '' };
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

function getPaymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || 'Method';
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
      || (res.package?.package_name || '').toLowerCase().includes(needle);
}

function matchesStatus(res, status) {
  if (status === 'all') return true;
  return (res.status || '').toLowerCase() === status;
}

function renderStats(list) {
  const counts = {
    pending: 0, approved: 0, declined: 0, completed: 0,
    cancelled: 0, rescheduled: 0, total: list.length
  };
  list.forEach(r => {
    const k = (r.status || 'pending').toLowerCase();
    if (counts[k] !== undefined) counts[k] += 1;
  });
  statIds.forEach(id => {
    const el = document.getElementById(`stat-${id}`);
    if (el) el.textContent = counts[id] ?? 0;
  });
  if (navReservationCount) navReservationCount.textContent = String(counts.pending);
  chipsRow?.querySelectorAll('.chip').forEach(chip => {
    const status = chip.dataset.status;
    const val = status === 'all' ? counts.total : (counts[status] ?? 0);
    chip.textContent = `${chip.textContent.split('(')[0].trim()} (${val})`;
  });
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
    const status = formatStatusPill(res.status);
    const staffSummary = getStaffSummary(res.reservation_id);
    return `
      <tr class="reservation-row">
        <td>
          <div class="reservation-customer">
            <span class="reservation-avatar">${escapeHtml(getCustomerInitials(res.contact_name, res.contact_email))}</span>
            <div class="reservation-customer-copy">
              <span class="table-main">${escapeHtml(res.contact_name || 'Unknown')}</span>
              <span class="table-sub">${escapeHtml(res.contact_email || '')}</span>
              <span class="table-meta">${escapeHtml(pkg)}</span>
            </div>
          </div>
        </td>
        <td>
          <div class="table-date">
            <span class="table-date-main">${escapeHtml(formatReservationDate(res.event_date))}</span>
            <span class="table-date-time">${escapeHtml(formatReservationTime(res.event_time))}</span>
          </div>
        </td>
        <td>
          <div class="table-summary-stack">
            <span class="status-pill ${escapeHtml(pay.key)}">${escapeHtml(pay.label)}</span>
            <span class="table-sub">${escapeHtml(pay.sublabel || '')}</span>
          </div>
        </td>
        <td class="table-status-cell"><span class="status-pill ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span></td>
        <td>
          <div class="staff-summary">
            <span class="table-main">${escapeHtml(staffSummary.label)}</span>
            <span class="table-sub">${escapeHtml(staffSummary.sublabel)}</span>
          </div>
        </td>
        <td class="actions actions-single">
          <button class="action-btn view" data-action="view-details" data-reservation-id="${res.reservation_id}">
            View Details
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function setReservationDetailsMessage(message = '', isError = false) {
  if (!reservationDetailsMessage) return;
  reservationDetailsMessage.textContent = message;
  reservationDetailsMessage.classList.toggle('error', isError);
}

function getLatestPaymentEntry(reservation) {
  return getReservationPayments(reservation)
    .slice()
    .sort((left, right) => new Date(right.submitted_at || right.verified_at || 0) - new Date(left.submitted_at || left.verified_at || 0))[0] || null;
}

function renderReservationDetailsModal() {
  const reservation = getReservationById(activeDetailsReservationId);
  if (!reservation) {
    closeReservationDetailsModal();
    return;
  }

  const paymentSummary = paymentStatus(reservation);
  const balance = getReservationBalanceSummary(reservation);
  const reservationStatus = formatStatusPill(reservation.status);
  const contract = contractStatus(reservation);
  const contractRecord = contract.contract;
  const latestPayment = getLatestPaymentEntry(reservation);
  const pendingPayment = getPendingPayment(reservation);
  const activeRescheduleRequest = getLatestOpenRescheduleRequest(reservation);
  const assignedStaff = getAssignedStaff(reservation.reservation_id);
  const staffSummary = getStaffSummary(reservation.reservation_id);
  const assignmentState = getAssignmentAvailability(reservation);
  const approvalState = getReservationApprovalState(reservation);
  const heroName = reservation.contact_name || 'Unknown customer';
  const heroPackage = reservation.package?.package_name || 'Reservation';

  if (reservationDetailsHero) {
    reservationDetailsHero.innerHTML = `
      <div class="reservation-hero-main">
        <span class="reservation-hero-avatar">${escapeHtml(getCustomerInitials(heroName, reservation.contact_email))}</span>
        <div class="reservation-hero-copy">
          <div class="reservation-hero-name">${escapeHtml(heroName)}</div>
          <div class="reservation-hero-sub">${escapeHtml(reservation.contact_email || 'No email on file')}</div>
          <div class="reservation-hero-package">${escapeHtml(heroPackage)}</div>
        </div>
      </div>
    `;
  }

  if (reservationDetailsMeta) {
    reservationDetailsMeta.innerHTML = [
      buildDetailCard('Event Date', formatReservationDate(reservation.event_date)),
      buildDetailCard('Event Time', formatReservationTime(reservation.event_time)),
      buildDetailCard('Payment', paymentSummary.label),
      buildDetailCard('Status', reservationStatus.label),
      buildDetailCard('Staff', staffSummary.label),
      buildDetailCard('Location', reservation.venue_location || reservation.location_type || 'No location specified')
    ].join('');
  }

  if (reservationSummaryGrid) {
    reservationSummaryGrid.innerHTML = [
      buildDetailCard('Event Type', reservation.event_type || 'Not specified'),
      buildDetailCard('Guest Count', reservation.guest_count ? `${reservation.guest_count} pax` : 'Not specified'),
      buildDetailCard('Total Amount', formatCurrency(reservation.total_price)),
      buildDetailCard('Contact Number', reservation.contact_phone || 'No phone on file'),
      buildDetailCard('Location Type', reservation.location_type || 'Not specified'),
      buildDetailCard('Created', formatDateTime(reservation.created_at)),
      buildDetailCard('Special Requests', reservation.special_requests || 'No notes provided.', { full: true, subtle: !reservation.special_requests })
    ].join('');
  }

  if (reservationPaymentSection) {
    const paymentCards = [
      buildDetailCard('Total Amount', formatCurrency(balance.totalAmount)),
      buildDetailCard('Approved Payments', formatCurrency(balance.approvedTotal)),
      buildDetailCard('Remaining Balance', balance.remainingBalance <= 0 ? 'Paid in Full' : formatCurrency(balance.remainingBalance)),
      buildDetailCard('Pay By', balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel),
      latestPayment
        ? buildDetailCard('Latest Payment Type', getPaymentTypeLabel(latestPayment.payment_type))
        : buildDetailCard('Latest Payment', 'No submitted payment yet.', { subtle: true }),
      latestPayment
        ? buildDetailCard('Latest Amount', formatCurrency(latestPayment.amount))
        : buildDetailCard('Latest Method', 'No payment submitted yet.', { subtle: true }),
      latestPayment
        ? buildDetailCard('Latest Method', getPaymentMethodLabel(latestPayment.payment_method))
        : buildDetailCard('Latest Submitted', 'No submission yet.', { subtle: true }),
      latestPayment
        ? buildDetailCard('Latest Submitted', formatDateTime(latestPayment.submitted_at))
        : buildDetailCard('Balance Status', balance.statusLabel)
    ].join('');

    const paymentActions = pendingPayment ? `
      <div class="details-action-row">
        <button class="action-btn approve" data-action="approve-payment" data-reservation-id="${reservation.reservation_id}" data-payment-id="${pendingPayment.payment_id}">
          ${escapeHtml(pendingPayment.payment_method === 'cash' ? 'Verify Cash Payment' : 'Approve Payment')}
        </button>
        <button class="action-btn decline" data-action="reject-payment" data-reservation-id="${reservation.reservation_id}" data-payment-id="${pendingPayment.payment_id}">
          Reject Payment
        </button>
      </div>
    ` : '';

    const paymentLinks = `
      <div class="details-action-row">
        <a class="action-btn view" href="./admin_payments.html?reservation=${encodeURIComponent(reservation.reservation_id)}">Open Payments</a>
        ${pendingPayment?.proof_url ? `<a class="action-btn view" href="${pendingPayment.proof_url}" target="_blank" rel="noopener noreferrer">View Proof</a>` : ''}
      </div>
    `;

    reservationPaymentSection.innerHTML = `
      <div class="details-grid compact-grid">
        <div class="detail-card detail-card-summary">
          <span class="detail-label">Current Payment State</span>
          <div class="detail-badge-stack">
            <span class="status-pill ${escapeHtml(paymentSummary.key)}">${escapeHtml(paymentSummary.label)}</span>
            <span class="detail-inline-copy">${escapeHtml(paymentSummary.sublabel || balance.statusLabel)}</span>
          </div>
        </div>
        ${paymentCards}
      </div>
      ${paymentActions}
      ${paymentLinks}
    `;
  }

  if (reservationContractSection) {
    const contractNoteMarkup = contract.note
      ? buildDetailCard('Admin Note', contract.note, { full: true })
      : '';
    const contractReviewMetaMarkup = contract.reviewedAt
      ? buildDetailCard('Reviewed', contract.reviewedAt)
      : '';
    const contractResubmittedMarkup = contract.resubmittedAt
      ? buildDetailCard('Replacement Submitted', contract.resubmittedAt)
      : '';
    const contractActionMarkup = contract.hasFile ? `
      <div class="details-action-row">
        <a class="action-btn view" href="${contractRecord.contract_url}" target="_blank" rel="noopener noreferrer">View Contract</a>
        ${['pending', 'resubmitted'].includes(contract.key)
          ? `<button class="action-btn approve" data-action="verify-contract" data-reservation-id="${reservation.reservation_id}">Verify Contract</button>`
          : ''}
      </div>
      ${contract.key !== 'approved' ? `
        <label class="modal-field">
          <span class="modal-label">Correction note for the customer</span>
          <textarea
            class="modal-textarea contract-review-note"
            data-contract-review-note="${reservation.reservation_id}"
            rows="4"
            placeholder="Explain what the customer needs to fix before uploading the contract again."
          >${escapeHtml(contract.key === 'resubmission_requested' ? (contractRecord?.review_notes || '') : '')}</textarea>
        </label>
        <div class="details-action-row">
          <button class="action-btn request" data-action="request-contract-resubmission" data-reservation-id="${reservation.reservation_id}">
            Request Contract Resubmission
          </button>
        </div>
      ` : ''}
    ` : `
      <div class="details-action-row">
        <span class="details-empty-inline">No contract file uploaded yet.</span>
      </div>
    `;

    reservationContractSection.innerHTML = `
      <div class="details-grid compact-grid">
        ${buildDetailCard('Contract Status', contract.label)}
        ${buildDetailCard('Verification', contract.verification, { subtle: contract.key !== 'approved' })}
        ${contractReviewMetaMarkup}
        ${contractResubmittedMarkup}
        ${contractNoteMarkup}
      </div>
      ${contractActionMarkup}
    `;
  }

  if (reservationStaffSection) {
    reservationStaffSection.innerHTML = `
        <div class="assigned-staff-list">
          ${assignedStaff.length
            ? assignedStaff.map((staff) => `
            <span class="staff-pill">${escapeHtml(getStaffDisplayName(staff))} · ${escapeHtml(formatStaffRole(staff.staff_role))}</span>
          `).join('')
          : '<span class="staff-pill unassigned">Not assigned yet</span>'}
        </div>
      <div class="details-action-row">
        <button
          class="action-btn assign"
          data-action="assign-employee"
          data-reservation-id="${reservation.reservation_id}"
          title="${escapeHtml(assignmentState.disabled ? assignmentState.disabledReason : 'Assign staff to this reservation.')}"
          ${(!assignmentState.canAssign || assignmentState.disabled) ? 'disabled' : ''}
        >
          Assign Staff
        </button>
        ${!assignmentState.canAssign ? '<span class="details-empty-inline">Staff assignment becomes available after approval.</span>' : ''}
        ${(assignmentState.canAssign && assignmentState.disabled) ? `<span class="details-empty-inline">${escapeHtml(assignmentState.disabledReason)}</span>` : ''}
      </div>
    `;
  }

  if (reservationActionsSection) {
    const reservationActionMarkup = ['pending', 'resubmission_requested'].includes(reservationStatus.key) ? `
      <div class="details-action-row">
        <button
          class="action-btn approve"
          data-action="approve"
          data-id="${reservation.reservation_id}"
          data-reservation-id="${reservation.reservation_id}"
          ${approvalState.canApprove ? '' : 'disabled'}
          title="${escapeHtml(approvalState.reason || 'Approve reservation')}"
        >
          Approve
        </button>
        <button class="action-btn decline" data-action="decline" data-id="${reservation.reservation_id}" data-reservation-id="${reservation.reservation_id}">Decline</button>
      </div>
      ${!approvalState.canApprove ? `<div class="details-empty-inline">${escapeHtml(approvalState.reason)}</div>` : ''}
    ` : '<div class="details-empty-inline">No reservation status action is needed right now.</div>';

    const rescheduleMarkup = activeRescheduleRequest && String(activeRescheduleRequest.status || '').toLowerCase() === 'pending' ? `
      <div class="details-grid compact-grid">
        ${buildDetailCard('Requested Date', formatReservationDate(activeRescheduleRequest.requested_date))}
        ${buildDetailCard('Requested Time', formatReservationTime(activeRescheduleRequest.requested_time))}
      </div>
      <div class="details-action-row">
        <button class="action-btn approve" data-action="approve-reschedule" data-request-id="${activeRescheduleRequest.reschedule_request_id}" data-reservation-id="${reservation.reservation_id}">
          Approve Reschedule
        </button>
        <button class="action-btn decline" data-action="reject-reschedule" data-request-id="${activeRescheduleRequest.reschedule_request_id}" data-reservation-id="${reservation.reservation_id}">
          Reject Request
        </button>
      </div>
    ` : '';

    reservationActionsSection.innerHTML = `
      ${reservationActionMarkup}
      ${rescheduleMarkup}
    `;
  }

  if (reservationDetailsFlash) {
    setReservationDetailsMessage(reservationDetailsFlash.message, reservationDetailsFlash.isError);
    reservationDetailsFlash = null;
  } else {
    setReservationDetailsMessage('');
  }
}

function openReservationDetailsModal(reservationId) {
  activeDetailsReservationId = reservationId;
  renderReservationDetailsModal();
  reservationDetailsModal?.classList.remove('hidden');
  reservationDetailsModal?.setAttribute('aria-hidden', 'false');
}

function closeReservationDetailsModal() {
  activeDetailsReservationId = null;
  reservationDetailsFlash = null;
  reservationDetailsModal?.classList.add('hidden');
  reservationDetailsModal?.setAttribute('aria-hidden', 'true');
  setReservationDetailsMessage('');
}

function filterAndRender() {
  const term = searchInput?.value.trim().toLowerCase();
  const dropdownStatus = statusDropdown?.value || 'all';
  const chipStatus = chipsRow?.querySelector('.chip.active')?.dataset.status || 'all';
  const status = dropdownStatus !== 'all' ? dropdownStatus : chipStatus;
  const filtered = reservationsCache.filter(r => matchesStatus(r, status) && matchesSearch(r, term));
  renderStats(reservationsCache);
  renderTable(filtered);
  setMessage(tableMessage, filtered.length ? '' : 'No reservations match the current filter.', false);
}

function wireFilters() {
  searchInput?.addEventListener('input', filterAndRender);
  statusDropdown?.addEventListener('change', () => {
    chipsRow?.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    filterAndRender();
  });
  chipsRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    chipsRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    statusDropdown.value = 'all';
    filterAndRender();
  });
}

async function fetchReservations() {
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      contact_name,
      contact_email,
      contact_phone,
      status,
      event_type,
      event_date,
      event_time,
      guest_count,
      location_type,
      venue_location,
      special_requests,
      total_price,
      created_at,
      package:package_id ( package_name )
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

async function fetchStaffProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select(`
      user_id,
      first_name,
      middle_name,
      last_name,
      email,
      role,
      staff_role
    `)
    .eq('role', 'staff')
    .order('first_name', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function fetchReservationAssignments(reservationIds, knownStaffProfiles) {
  if (!reservationIds.length) return {};

  let response = await supabase
    .from('reservation_staff_assignments')
    .select(`
      reservation_id,
      staff_user_id,
      assigned_at,
      assignment_note
    `)
    .in('reservation_id', reservationIds);

  if (response.error && isMissingColumnError(response.error, 'assignment_note')) {
    response = await supabase
      .from('reservation_staff_assignments')
      .select(`
        reservation_id,
        staff_user_id,
        assigned_at
      `)
      .in('reservation_id', reservationIds);
  }

  const { data, error } = response;
  if (error) throw error;

  const staffById = (knownStaffProfiles || []).reduce((map, staff) => {
    map[staff.user_id] = staff;
    return map;
  }, {});

  return (data || []).reduce((map, assignment) => {
    if (!map[assignment.reservation_id]) map[assignment.reservation_id] = [];
    const staffProfile = staffById[assignment.staff_user_id];
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

async function logReservationStatusChange(reservationId, previousStatus, newStatus) {
  const { error } = await supabase
    .from('reservation_status')
    .insert({
      reservation_id: reservationId,
      previous_status: previousStatus || null,
      new_status: newStatus,
      changed_at: new Date().toISOString()
    });

  if (error) throw error;
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

async function markReservationContractVerified(reservationId) {
  const { data, error } = await supabase
    .from('reservation_contracts')
    .update({
      review_status: 'verified',
      review_notes: null,
      reviewed_at: new Date().toISOString(),
      verified_date: new Date().toISOString()
    })
    .eq('reservation_id', reservationId)
    .not('contract_url', 'is', null)
    .select('reservation_id')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error('No uploaded contract was found for this reservation.');
  }
}

async function requestReservationContractResubmission(reservationId, reviewNotes) {
  const trimmedNotes = String(reviewNotes || '').trim();
  if (!trimmedNotes) {
    throw new Error('Please enter the contract correction note before requesting resubmission.');
  }

  const reviewedAt = new Date().toISOString();
  let response = await supabase
    .from('reservation_contracts')
    .update({
      review_status: 'resubmission_requested',
      review_notes: trimmedNotes,
      reviewed_at: reviewedAt,
      verified_date: null,
      resubmitted_at: null
    })
    .eq('reservation_id', reservationId)
    .not('contract_url', 'is', null)
    .select('reservation_id')
    .maybeSingle();

  if (response.error && isMissingColumnError(response.error, 'resubmitted_at')) {
    response = await supabase
      .from('reservation_contracts')
      .update({
        review_status: 'resubmission_requested',
        review_notes: trimmedNotes,
        reviewed_at: reviewedAt,
        verified_date: null
      })
      .eq('reservation_id', reservationId)
      .not('contract_url', 'is', null)
      .select('reservation_id')
      .maybeSingle();
  }

  const { data, error } = response;

  if (error) throw error;
  if (!data) {
    throw new Error('No uploaded contract was found for this reservation.');
  }
}

async function updateReservationStatus(reservationId, status, previousStatus = null) {
  const normalizedPreviousStatus = String(previousStatus || '').toLowerCase();
  const normalizedNextStatus = String(status || '').toLowerCase();

  if (normalizedPreviousStatus && normalizedPreviousStatus === normalizedNextStatus) {
    return;
  }

  const { error } = await supabase
    .from('reservations')
    .update({ status })
    .eq('reservation_id', reservationId);
  if (error) throw error;

  await logReservationStatusChange(reservationId, previousStatus, status);
}

function generateReceiptNumber(paymentId) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AR-${stamp}-${String(paymentId || '').slice(0, 6).toUpperCase()}`;
}

async function ensureReceiptForPayment(paymentId) {
  const { data: existingReceipt, error: receiptLookupError } = await supabase
    .from('receipts')
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (receiptLookupError) throw receiptLookupError;
  if (existingReceipt) return existingReceipt;

  const payload = {
    payment_id: paymentId,
    receipt_number: generateReceiptNumber(paymentId),
    issued_at: new Date().toISOString()
  };

  const { data: receipt, error: receiptInsertError } = await supabase
    .from('receipts')
    .insert(payload)
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .single();

  if (receiptInsertError) throw receiptInsertError;
  return receipt;
}

async function handlePaymentReview(reservationId, paymentId, nextStatus) {
  const reservation = reservationsCache.find((entry) => String(entry.reservation_id) === String(reservationId));
  const payment = getReservationPayments(reservation || {}).find((entry) => String(entry.payment_id) === String(paymentId));

  if (!reservation || !payment) {
    throw new Error('Payment record could not be found.');
  }

  const updatePayload = {
    payment_status: nextStatus,
    verified_at: new Date().toISOString()
  };

  const { error: paymentError } = await supabase
    .from('payment')
    .update(updatePayload)
    .eq('payment_id', paymentId);

  if (paymentError) throw paymentError;

  if (nextStatus === 'approved') {
    await ensureReceiptForPayment(paymentId);

    if (payment.payment_type === 'reschedule_fee' && payment.reschedule_request_id) {
      const request = getReservationRescheduleRequests(reservation)
        .find((entry) => String(entry.reschedule_request_id) === String(payment.reschedule_request_id));

      if (!request) {
        throw new Error('Linked reschedule request could not be found.');
      }

      const { error: reservationError } = await supabase
        .from('reservations')
        .update({
          event_date: request.requested_date,
          event_time: request.requested_time
        })
        .eq('reservation_id', reservationId);

      if (reservationError) throw reservationError;

      const { error: requestError } = await supabase
        .from('reschedule_requests')
        .update({
          status: 'completed',
          reviewed_at: new Date().toISOString()
        })
        .eq('reschedule_request_id', payment.reschedule_request_id);

      if (requestError) throw requestError;
    }
  }
}

async function handleRescheduleReview(requestId, nextStatus) {
  const updatePayload = {
    status: nextStatus,
    reviewed_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('reschedule_requests')
    .update(updatePayload)
    .eq('reschedule_request_id', requestId);

  if (error) throw error;
}

function setAssignmentModalMessage(message, isError = false) {
  if (!assignmentModalMessage) return;
  assignmentModalMessage.textContent = message;
  assignmentModalMessage.classList.toggle('error', isError);
}

function renderAssignmentSelectionCount() {
  if (!assignmentSelectionCount) return;
  const count = assignmentSelection.size;
  assignmentSelectionCount.textContent = count === 1 ? '1 selected' : `${count} selected`;
}

function renderAssignmentStaffList() {
  if (!assignmentStaffList) return;

  const filteredStaff = staffDirectory.filter((staff) => {
    if (!assignmentSearchTerm) return true;
    const haystacks = [
      getStaffDisplayName(staff),
      staff.email,
      formatStaffRole(staff.staff_role)
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return haystacks.some((value) => value.includes(assignmentSearchTerm));
  });

  if (!staffDirectory.length) {
    assignmentStaffList.innerHTML = '<div class="assignment-staff-empty">No staff profiles are available yet.</div>';
    renderAssignmentSelectionCount();
    return;
  }

  if (!filteredStaff.length) {
    assignmentStaffList.innerHTML = '<div class="assignment-staff-empty">No staff matched your search.</div>';
    renderAssignmentSelectionCount();
    return;
  }

  assignmentStaffList.innerHTML = filteredStaff.map((staff) => `
    <label class="assignment-staff-option">
      <input
        type="checkbox"
        value="${escapeHtml(staff.user_id)}"
        ${assignmentSelection.has(staff.user_id) ? 'checked' : ''}
      />
      <span class="assignment-staff-copy">
        <span class="assignment-staff-name">${escapeHtml(getStaffDisplayName(staff))}</span>
        <span class="assignment-staff-role">${escapeHtml(formatStaffRole(staff.staff_role))}</span>
        <span class="assignment-staff-email">${escapeHtml(staff.email || 'No email on file')}</span>
      </span>
    </label>
  `).join('');

  renderAssignmentSelectionCount();
}

function closeAssignmentModal() {
  activeAssignmentReservationId = null;
  assignmentSelection = new Set();
  assignmentSearchTerm = '';
  assignmentModal?.classList.add('hidden');
  assignmentModal?.setAttribute('aria-hidden', 'true');
  if (assignmentSearchInput) assignmentSearchInput.value = '';
  if (assignmentNoteInput) assignmentNoteInput.value = '';
  assignmentSaveBtn?.removeAttribute('disabled');
  setAssignmentModalMessage('');
}

function openAssignmentModal(reservationId) {
  if (!assignmentFeatureReady) {
    setMessage(tableMessage, assignmentFeatureMessage, true);
    return;
  }

  const reservation = reservationsCache.find((entry) => String(entry.reservation_id) === String(reservationId));
  if (!reservation) return;

  activeAssignmentReservationId = reservationId;
  assignmentSelection = new Set(getAssignedStaff(reservationId).map((staff) => staff.user_id));
  assignmentSearchTerm = '';

  if (assignmentReservationSummary) {
    assignmentReservationSummary.textContent = `${reservation.contact_name || 'Customer'} - ${reservation.package?.package_name || 'Reservation'}`;
  }
  if (assignmentReservationMeta) {
    assignmentReservationMeta.textContent = `${formatReservationDate(reservation.event_date)} at ${formatReservationTime(reservation.event_time)}`;
  }
  if (assignmentNoteInput) {
    assignmentNoteInput.value = getAssignmentNoteForReservation(reservationId);
  }

  assignmentModal?.classList.remove('hidden');
  assignmentModal?.setAttribute('aria-hidden', 'false');
  renderAssignmentStaffList();
  setAssignmentModalMessage(staffDirectory.length ? 'Choose the staff members you want assigned to this reservation.' : 'No staff profiles are available yet.', !staffDirectory.length);
  assignmentSearchInput?.focus();
}

async function saveAssignmentSelection() {
  if (!activeAssignmentReservationId) return;

  assignmentSaveBtn?.setAttribute('disabled', 'true');
  setAssignmentModalMessage('Saving staff assignment...');

  const assignmentNote = String(assignmentNoteInput?.value || '').trim();
  const selectedStaffIds = Array.from(assignmentSelection);
  const existingStaffIds = new Set(
    getAssignedStaff(activeAssignmentReservationId).map((staff) => staff.user_id)
  );
  const selectedStaffIdSet = new Set(selectedStaffIds);
  const staffIdsToDelete = Array.from(existingStaffIds).filter((staffUserId) => !selectedStaffIdSet.has(staffUserId));
  const staffIdsToInsert = selectedStaffIds.filter((staffUserId) => !existingStaffIds.has(staffUserId));

  try {
    if (staffIdsToDelete.length) {
      const { error: deleteError } = await supabase
        .from('reservation_staff_assignments')
        .delete()
        .eq('reservation_id', activeAssignmentReservationId)
        .in('staff_user_id', staffIdsToDelete);

      if (deleteError) throw deleteError;
    }

    if (staffIdsToInsert.length) {
      const payload = staffIdsToInsert.map((staffUserId) => ({
        reservation_id: activeAssignmentReservationId,
        staff_user_id: staffUserId,
        assigned_by: adminSession?.user?.id || null,
        assignment_note: assignmentNote || null
      }));

      const { error: insertError } = await supabase
        .from('reservation_staff_assignments')
        .insert(payload);

      if (insertError) throw insertError;
    }

    if (selectedStaffIds.length) {
      const { error: updateError } = await supabase
        .from('reservation_staff_assignments')
        .update({ assignment_note: assignmentNote || null })
        .eq('reservation_id', activeAssignmentReservationId)
        .in('staff_user_id', selectedStaffIds);

      if (updateError) throw updateError;
    }

    closeAssignmentModal();
    await loadData();
    setMessage(tableMessage, 'Staff assignment updated.', false);
  } catch (error) {
    assignmentFeatureReady = false;
    assignmentFeatureMessage = getAssignmentSchemaHint(error);
    assignmentSaveBtn?.removeAttribute('disabled');
    setAssignmentModalMessage(`Failed to save assignment: ${assignmentFeatureMessage}`, true);
  }
}

async function performReservationAction(action, button) {
  const reservationId = button.dataset.reservationId || button.dataset.id;
  const reservation = getReservationById(reservationId);
  const previousStatus = reservation?.status || null;

  if (action === 'assign-employee') {
    closeReservationDetailsModal();
    openAssignmentModal(reservationId);
    return { shouldReload: false };
  }

  if (action === 'approve') {
    const limitMessage = getApprovalLimitMessage(reservation);
    if (limitMessage) {
      throw new Error(limitMessage);
    }
    const approvalState = getReservationApprovalState(reservation);
    if (!approvalState.canApprove) {
      throw new Error(approvalState.reason);
    }
    await updateReservationStatus(reservationId, 'approved', previousStatus);
    return { shouldReload: true, message: 'Reservation approved.' };
  }

  if (action === 'decline') {
    await updateReservationStatus(reservationId, 'declined', previousStatus);
    return { shouldReload: true, message: 'Reservation declined.' };
  }

  if (action === 'verify-contract') {
    await markReservationContractVerified(reservationId);
    return { shouldReload: true, message: 'Contract verified. You can now approve the reservation.' };
  }

  if (action === 'request-contract-resubmission') {
    const noteInput = reservationContractSection?.querySelector(`[data-contract-review-note="${reservationId}"]`);
    await requestReservationContractResubmission(reservationId, noteInput?.value || '');
    return { shouldReload: true, message: 'Customer has been asked to re-upload the signed contract.' };
  }

  if (action === 'approve-reschedule') {
    await handleRescheduleReview(button.dataset.requestId, 'approved_pending_payment');
    return { shouldReload: true, message: 'Reschedule request approved.' };
  }

  if (action === 'reject-reschedule') {
    await handleRescheduleReview(button.dataset.requestId, 'rejected');
    return { shouldReload: true, message: 'Reschedule request rejected.' };
  }

  if (action === 'approve-payment') {
    await handlePaymentReview(reservationId, button.dataset.paymentId, 'approved');
    return { shouldReload: true, message: 'Payment approved.' };
  }

  if (action === 'reject-payment') {
    await handlePaymentReview(reservationId, button.dataset.paymentId, 'rejected');
    return { shouldReload: true, message: 'Payment rejected.' };
  }

  return { shouldReload: false };
}

function wireTableActions() {
  reservationsBody?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;
    if (action !== 'view-details') return;
    openReservationDetailsModal(btn.dataset.reservationId);
  });
}

function wireReservationDetailsModal() {
  reservationDetailsClose?.addEventListener('click', closeReservationDetailsModal);
  reservationDetailsDismiss?.addEventListener('click', closeReservationDetailsModal);
  reservationDetailsModal?.addEventListener('click', async (event) => {
    if (event.target === reservationDetailsModal) {
      closeReservationDetailsModal();
      return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    if (!action || action === 'view-details') return;

    try {
      setReservationDetailsMessage('Updating reservation...');
      const result = await performReservationAction(action, button);
      if (result?.shouldReload) {
        reservationDetailsFlash = { message: result.message || 'Updated.', isError: false };
        await loadData();
        setMessage(tableMessage, result.message || 'Updated.', false);
      } else if (result?.message) {
        reservationDetailsFlash = { message: result.message, isError: false };
      }
    } catch (error) {
      setReservationDetailsMessage(error.message, true);
      setMessage(tableMessage, `Failed to update: ${error.message}`, true);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeDetailsReservationId) closeReservationDetailsModal();
  });
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

function renderCalendar(approvedDates = []) {
  if (!calendarGrid) return;
  const start = startOfMonth(currentMonth);
  const approvedSet = new Set(approvedDates.map(d => d.split('T')[0]));
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
    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    const booked = approvedSet.has(iso);
    const closed = closedSet.has(iso);
    const formattedDate = formatBlackoutDate(iso);
    let statusKey = 'open';
    let statusLabel = 'Open';
    let titleText = `${formattedDate} is open. Click to close this date.`;

    if (!isCurrentMonth) {
      cell.classList.add('outside-month');
      titleText = `${formattedDate} is outside the current month.`;
    } else if (isPast) {
      cell.classList.add('past');
      titleText = `${formattedDate} is in the past.`;
    } else if (closed) {
      cell.classList.add('closed');
      statusKey = 'closed';
      statusLabel = 'Closed';
      titleText = `${formattedDate} is closed. Click to reopen it.`;
    } else if (booked) {
      cell.classList.add('booked');
      statusKey = 'booked';
      statusLabel = 'Booked';
      titleText = `${formattedDate} is fully booked.`;
    } else {
      cell.classList.add('available');
    }

    if (isToday && isCurrentMonth) {
      cell.classList.add('today');
    }

    cell.dataset.status = statusKey;
    cell.title = titleText;
    cell.setAttribute('aria-label', titleText);
    cell.innerHTML = `
      <div class="calendar-cell-body">
        <div class="calendar-day-row">
          <span class="calendar-day-number">${dateObj.getDate()}</span>
          ${isToday && isCurrentMonth ? '<span class="calendar-day-marker">Today</span>' : ''}
        </div>
        <div class="calendar-cell-footer">
          ${statusKey !== 'open' && isCurrentMonth ? `<span class="calendar-status-pill ${statusKey}">${statusLabel}</span>` : ''}
        </div>
      </div>
    `;

    if (isCurrentMonth && !isPast && !booked && !closed) {
      cell.classList.add('is-actionable');
      bindCalendarAction(cell, () => openBlackoutModal(iso));
    } else if (isCurrentMonth && !isPast && closed) {
      cell.classList.add('is-actionable');
      bindCalendarAction(cell, () => openBlackoutModal(iso, 'reopen'));
    } else {
      cell.setAttribute('aria-disabled', 'true');
    }
    calendarGrid.appendChild(cell);
  }
  calendarMonthLabel.textContent = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
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

async function toggleBlackout(dateIso) {
  const dateColumn = await resolveBlackoutDateColumn();

  if (blackouts.has(dateIso)) {
    const { error } = await supabase
      .from('calendar_blackouts')
      .delete()
      .eq(dateColumn, dateIso);
    if (error) {
      setMessage(calendarMessage, `Failed to open date: ${getBlackoutSchemaHint(error)}`, true);
      return;
    }
    blackouts.delete(dateIso);
  } else {
    const { error } = await supabase
      .from('calendar_blackouts')
      .upsert({
        [dateColumn]: dateIso,
        created_by: adminSession?.user?.id || null
      }, { onConflict: dateColumn });
    if (error) {
      setMessage(calendarMessage, `Failed to close date: ${getBlackoutSchemaHint(error)}`, true);
      return;
    }
    blackouts.add(dateIso);
  }
  renderCalendar(approvedDatesFromCache());
}

function approvedDatesFromCache() {
  return reservationsCache
    .filter(r => (r.status || '').toLowerCase() === 'approved' && r.event_date)
    .map(r => r.event_date);
}

async function loadCalendar() {
  await fetchBlackouts();
  renderCalendar(approvedDatesFromCache());
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
      staffDirectory = await fetchStaffProfiles();
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

    renderStats(reservationsCache);
    filterAndRender();
    await loadCalendar();
    if (activeDetailsReservationId) {
      if (getReservationById(activeDetailsReservationId)) {
        renderReservationDetailsModal();
      } else {
        closeReservationDetailsModal();
      }
    }
    if (!assignmentFeatureReady) {
      setMessage(tableMessage, `Loaded reservations. Staff assignment note: ${assignmentFeatureMessage}`, true);
    }
  } catch (err) {
    setMessage(tableMessage, `Failed to load: ${err.message}`, true);
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

function wireAssignmentModal() {
  assignmentCancelBtn?.addEventListener('click', closeAssignmentModal);
  assignmentModalClose?.addEventListener('click', closeAssignmentModal);
  assignmentSaveBtn?.addEventListener('click', saveAssignmentSelection);
  assignmentModal?.addEventListener('click', (event) => {
    if (event.target === assignmentModal) closeAssignmentModal();
  });
  assignmentSearchInput?.addEventListener('input', (event) => {
    assignmentSearchTerm = String(event.target?.value || '').trim().toLowerCase();
    renderAssignmentStaffList();
  });
  assignmentStaffList?.addEventListener('change', (event) => {
    const checkbox = event.target.closest('input[type="checkbox"]');
    if (!checkbox) return;
    if (checkbox.checked) {
      assignmentSelection.add(checkbox.value);
    } else {
      assignmentSelection.delete(checkbox.value);
    }
    renderAssignmentSelectionCount();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeAssignmentReservationId) closeAssignmentModal();
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

logoutBtn?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  redirectLogin();
});

refreshBtn?.addEventListener('click', loadData);

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') redirectLogin();
});

(async function init() {
  await validateAdmin();
  setCalendarExpanded(false);
  wireFilters();
  wireTableActions();
  wireReservationDetailsModal();
  wireCalendarToggle();
  wireCalendarNav();
  wireBlackoutModal();
  wireAssignmentModal();
  await loadData();
})();
