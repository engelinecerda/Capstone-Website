import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { refreshAdminSidebarCounts } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { fetchDateAvailability, getBookingScope as getSharedBookingScope } from './reservation_availability.js';

const breadcrumbBack = document.getElementById('breadcrumbBack');
const breadcrumbCurrent = document.getElementById('breadcrumbCurrent');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');
const logoutBtn = document.getElementById('logoutBtn');

const detailsLoading = document.getElementById('detailsLoading');
const detailsError = document.getElementById('detailsError');
const detailsErrorMessage = document.getElementById('detailsErrorMessage');
const detailsContent = document.getElementById('detailsContent');

const reservationStickyHeader = document.getElementById('reservationStickyHeader');
const detailsAvatar = document.getElementById('detailsAvatar');
const detailsName = document.getElementById('detailsName');
const detailsStatusPill = document.getElementById('detailsStatusPill');
const detailsMeta = document.getElementById('detailsMeta');
const detailsHeaderActions = document.getElementById('detailsHeaderActions');
const detailsFlashMessage = document.getElementById('detailsFlashMessage');

const rescheduleReviewPanel = document.getElementById('rescheduleReviewPanel');
const rescheduleReviewRows = document.getElementById('rescheduleReviewRows');
const rescheduleApproveBtn = document.getElementById('rescheduleApproveBtn');
const rescheduleRejectBtn = document.getElementById('rescheduleRejectBtn');

const bookingDetailsGrid = document.getElementById('bookingDetailsGrid');
const bookingDetailsRows = document.getElementById('bookingDetailsRows');

const paymentStatusPill = document.getElementById('paymentStatusPill');
const openPaymentsLink = document.getElementById('openPaymentsLink');
const paymentDetailsGrid = document.getElementById('paymentDetailsGrid');
const paymentDetailsRows = document.getElementById('paymentDetailsRows');

const contractStatusPill = document.getElementById('contractStatusPill');
const viewContractLink = document.getElementById('viewContractLink');
const signatureCheckPanel = document.getElementById('signatureCheckPanel');
const contractDetailsRows = document.getElementById('contractDetailsRows');

const staffAssignedList = document.getElementById('staffAssignedList');
const assignStaffBtn = document.getElementById('assignStaffBtn');
const staffAssignHelper = document.getElementById('staffAssignHelper');

const assignmentModal = document.getElementById('assignmentModal');
const assignmentModalClose = document.getElementById('assignmentModalClose');
const assignmentCancelBtn = document.getElementById('assignmentCancelBtn');
const assignmentSaveBtn = document.getElementById('assignmentSaveBtn');
const assignmentModalMessage = document.getElementById('assignmentModalMessage');
const assignmentSearchInput = document.getElementById('assignmentSearchInput');
const assignmentStaffList = document.getElementById('assignmentStaffList');
const assignmentReservationSummary = document.getElementById('assignmentReservationSummary');
const assignmentReservationMeta = document.getElementById('assignmentReservationMeta');
const assignmentSelectionRow = document.getElementById('assignmentSelectionRow');

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
  reschedule_fee: 'Reschedule Fee',
  cancellation_fee: 'Cancellation Fee'
};
const PAYMENT_BALANCE_DUE_DAYS = 7;
const CAPACITY_BLOCKING_STATUSES = new Set([
  'pending', 'pending_review', 'for_finalization', 'for_contract_signing',
  'approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled'
]);

let adminSession = null;
let currentRole = null;
let currentReservation = null;
let staffDirectory = [];
let assignedStaffForReservation = [];
let assignmentFeatureReady = true;
let assignmentFeatureMessage = '';
let assignmentSelection = new Set();
let assignmentSearchTerm = '';

/* ---------------------------------------------------------------- */
/* Formatters (mirrors js/admin_reservations.js)                     */
/* ---------------------------------------------------------------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function formatDateKey(value) {
  return String(value || '').split('T')[0];
}

function formatReservationDate(dateIso) {
  if (!dateIso) return 'No date selected';
  return new Date(`${formatDateKey(dateIso)}T00:00:00`).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

function formatDateTime(value) {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function buildLocalDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function getTodayDateKey() {
  return buildLocalDateKey(new Date());
}

function parseReservationTimeParts(timeValue) {
  const value = String(timeValue || '').trim();
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) return { hours: Number(match[1]), minutes: Number(match[2]) };
  const parsed = new Date(`1970-01-01 ${value}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return { hours: parsed.getHours(), minutes: parsed.getMinutes() };
}

function getReservationEventDateTime(reservation) {
  const dateKey = formatDateKey(reservation?.event_date);
  if (!dateKey) return null;
  const timeParts = parseReservationTimeParts(reservation?.event_time);
  const eventDate = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(eventDate.getTime())) return null;
  if (timeParts) eventDate.setHours(timeParts.hours, timeParts.minutes, 0, 0);
  return eventDate;
}

function formatEventDateTime(reservation) {
  const eventDate = getReservationEventDateTime(reservation);
  if (!eventDate) return 'No date selected';
  return eventDate.toLocaleString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function getEffectiveReservationStatus(reservation) {
  const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) return normalizedStatus;
  const eventDateTime = getReservationEventDateTime(reservation);
  if (eventDateTime && eventDateTime.getTime() < Date.now() && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
    return 'completed';
  }
  if (normalizedStatus === 'confirmed') return 'approved';
  return normalizedStatus;
}

function formatStatusPill(status) {
  const key = (status || 'pending').toLowerCase();
  const label = key.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return { key, label };
}

function capitalize(value) {
  const str = String(value || '').trim();
  return str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';
}

function getCustomerInitials(name, email = '') {
  const initials = String(name || '').split(' ').filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
  return initials || String(email || 'R').charAt(0).toUpperCase();
}

function getStaffDisplayName(profile) {
  const nameParts = [profile?.first_name, profile?.middle_name, profile?.last_name].filter(Boolean);
  return nameParts.join(' ') || profile?.email || 'Unnamed staff';
}

function formatStaffRole(staffRole) {
  const normalized = String(staffRole || '').trim().toLowerCase();
  if (!normalized) return 'Staff';
  return normalized.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function isMissingColumnError(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column reservation_contracts.${columnName} does not exist`)
    || message.includes(`column reservation_staff_assignments.${columnName} does not exist`);
}

function getReservationDurationHours(reservation) {
  const storedDuration = Number(reservation?.duration_hours || 0);
  if (storedDuration > 0) return storedDuration;
  const packageDuration = Number(reservation?.package?.duration_hours || 0);
  if (packageDuration > 0) return packageDuration;
  const packageName = String(reservation?.package?.package_name || '').toLowerCase();
  if (packageName.includes('vip lite')) return 2;
  if (packageName.includes('vip plus')) return 3;
  if (packageName.includes('vip max')) return 4;
  if (packageName.includes('main hall basic')) return 2;
  if (packageName.includes('main hall plus')) return 3;
  if (packageName.includes('catering')) return 4;
  return 3;
}

function getBookingScope(reservation) {
  return getSharedBookingScope(
    reservation?.location_type,
    reservation?.package?.package_name || reservation?.package_name || '',
    reservation?.booking_scope || reservation?.package?.booking_scope || null
  );
}

function getAssignmentSchemaHint(error) {
  const message = error?.message || '';
  if (
    message.includes('relation "public.reservation_staff_assignments" does not exist')
    || message.includes("Could not find the table 'reservation_staff_assignments' in the schema cache")
  ) {
    return 'Create the reservation_staff_assignments table in Supabase before using employee assignment.';
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

/* ---------------------------------------------------------------- */
/* Business logic (mirrors js/admin_reservations.js)                 */
/* ---------------------------------------------------------------- */

function getReservationPayments(reservation) {
  return reservation.payments || [];
}

function getReservationRescheduleRequests(reservation) {
  return reservation.reschedule_requests || [];
}

function getApprovedBasePaymentsTotal(reservation) {
  return getReservationPayments(reservation)
    .filter((payment) => !payment.reschedule_request_id && String(payment.payment_status || '').toLowerCase() === 'approved')
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
    totalAmount, approvedTotal, remainingBalance, dueDateKey, dueDateLabel, isPastDue, hasPartialPayment,
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

function getPendingPayment(reservation) {
  return getReservationPayments(reservation)
    .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
    .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

function getLatestOpenRescheduleRequest(reservation) {
  return getReservationRescheduleRequests(reservation)
    .find((request) => ['pending', 'approved_pending_payment'].includes(String(request.status || '').toLowerCase())) || null;
}

function getLatestPaymentEntry(reservation) {
  return getReservationPayments(reservation)
    .slice()
    .sort((left, right) => new Date(right.submitted_at || right.verified_at || 0) - new Date(left.submitted_at || left.verified_at || 0))[0] || null;
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

function getContractReviewMeta(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  const reviewStatus = String(contract?.review_status || '').toLowerCase();
  const reservationStatus = String(reservation?.status || '').toLowerCase();
  const resubmittedAt = contract?.resubmitted_at ? formatDateTime(contract.resubmitted_at) : '';

  if (!contract) {
    return { key: 'default', label: 'Contract missing', verification: 'No contract file uploaded yet', note: '', reviewedAt: '', resubmittedAt: '', hasFile: false, contract };
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
  return { key: 'default', label: 'Contract missing', verification: 'No contract file uploaded yet', note: '', reviewedAt: '', resubmittedAt: '', hasFile: false, contract };
}

function contractStatus(res) {
  return getContractReviewMeta(res);
}

function getReservationApprovalState(reservation) {
  const contract = getContractReviewMeta(reservation);
  if (!contract.hasFile) {
    return { canApprove: false, reason: 'The reservation cannot be approved until the customer uploads a signed contract.' };
  }
  return { canApprove: true, reason: '' };
}

async function getApprovalLimitMessage(reservation) {
  const dateKey = formatDateKey(reservation.event_date);
  if (!dateKey) return 'Cannot approve this reservation because it has no event date.';

  const { data, error } = await supabase
    .from('reservations')
    .select('reservation_id, status')
    .eq('event_date', dateKey)
    .neq('reservation_id', reservation.reservation_id);
  if (error) throw error;

  const count = (data || []).filter((r) => CAPACITY_BLOCKING_STATUSES.has(String(r.status || '').toLowerCase())).length;
  if (count < 2) return '';

  const formattedDate = new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  return `Cannot approve this reservation. ${formattedDate} is already fully booked (maximum 2 reservations per day).`;
}

/* ---------------------------------------------------------------- */
/* Data fetching                                                     */
/* ---------------------------------------------------------------- */

async function fetchReservationContracts(reservationIds) {
  if (!reservationIds.length) return [];
  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at, resubmitted_at';
  const fallbackSelect = 'reservation_id, contract_url, verified_date, template_id';
  const { data, error } = await supabase.from('reservation_contracts').select(extendedSelect).in('reservation_id', reservationIds);
  if (!error) return data || [];

  if (
    isMissingColumnError(error, 'review_status')
    || isMissingColumnError(error, 'review_notes')
    || isMissingColumnError(error, 'reviewed_at')
    || isMissingColumnError(error, 'resubmitted_at')
  ) {
    const fallback = await supabase.from('reservation_contracts').select(fallbackSelect).in('reservation_id', reservationIds);
    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }
  throw error;
}

async function fetchStaffRoster() {
  const { data, error } = await supabase
    .from('staff_roster')
    .select('staff_id, first_name, last_name, staff_role')
    .eq('is_active', true)
    .order('first_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchReservationAssignments(reservationIds, knownStaffRoster) {
  if (!reservationIds.length) return {};

  const { data, error } = await supabase
    .from('reservation_staff_assignments')
    .select('reservation_id, roster_staff_id, assigned_at')
    .in('reservation_id', reservationIds);
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
        assigned_at: assignment.assigned_at || null
      });
    }
    return map;
  }, {});
}

async function fetchReservationDetail(idParam) {
  const baseSelect = `
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
  `;

  let { data, error } = await supabase.from('reservations').select(baseSelect).eq('reservation_id', idParam).maybeSingle();

  if (error || !data) {
    const fallback = await supabase.from('reservations').select(baseSelect).eq('reservation_number', idParam).maybeSingle();
    if (fallback.error) throw fallback.error;
    data = fallback.data;
  }

  if (!data) return null;

  const [contracts, paymentsRes, requestsRes] = await Promise.all([
    fetchReservationContracts([data.reservation_id]),
    supabase
      .from('payment')
      .select('payment_id, reservation_id, reschedule_request_id, payment_type, payment_method, amount, payment_status, reference_number, payment_date, notes, proof_url, cash_payment_date, submitted_at, verified_at')
      .eq('reservation_id', data.reservation_id)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('reschedule_requests')
      .select('reschedule_request_id, reservation_id, original_date, original_time, requested_date, requested_time, status, requested_at, reviewed_at')
      .eq('reservation_id', data.reservation_id)
      .order('requested_at', { ascending: false })
  ]);

  if (paymentsRes.error) throw paymentsRes.error;
  if (requestsRes.error) throw requestsRes.error;

  return {
    ...data,
    contracts: contracts.length ? [contracts[0]] : [],
    payments: paymentsRes.data || [],
    reschedule_requests: requestsRes.data || []
  };
}

/* ---------------------------------------------------------------- */
/* Mutations                                                          */
/* ---------------------------------------------------------------- */

async function logReservationStatusChange(reservationId, previousStatus, newStatus) {
  const { error } = await supabase.from('reservation_status').insert({
    reservation_id: reservationId,
    previous_status: previousStatus || null,
    new_status: newStatus,
    changed_at: new Date().toISOString()
  });
  if (error) throw error;
}

async function updateReservationStatus(reservationId, status, previousStatus = null) {
  const normalizedPreviousStatus = String(previousStatus || '').toLowerCase();
  const normalizedNextStatus = String(status || '').toLowerCase();
  if (normalizedPreviousStatus && normalizedPreviousStatus === normalizedNextStatus) return;

  const { error } = await supabase.from('reservations').update({ status }).eq('reservation_id', reservationId);
  if (error) throw error;

  await logReservationStatusChange(reservationId, previousStatus, status);
}

async function handleRescheduleReview(requestId, nextStatus) {
  const reservation = currentReservation;
  const request = getReservationRescheduleRequests(reservation).find((entry) => String(entry.reschedule_request_id) === String(requestId));

  if (nextStatus === 'approved_pending_payment' && reservation && request) {
    const availability = await fetchDateAvailability(supabase, {
      eventDate: request.requested_date,
      scope: getBookingScope(reservation),
      durationHours: getReservationDurationHours(reservation),
      excludeReservationId: reservation.reservation_id
    });
    if (availability.scopeTaken) {
      throw new Error('This date is fully booked. A maximum of 2 reservations are accepted per day.');
    }
  }

  const { error } = await supabase
    .from('reschedule_requests')
    .update({ status: nextStatus, reviewed_at: new Date().toISOString() })
    .eq('reschedule_request_id', requestId);
  if (error) throw error;
}

/* ---------------------------------------------------------------- */
/* Rendering                                                          */
/* ---------------------------------------------------------------- */

function dlRow(label, value, options = {}) {
  const classes = ['dl-row'];
  if (options.full) classes.push('full');
  const valueClass = options.muted ? 'dl-value muted' : 'dl-value';
  return `
    <div class="${classes.join(' ')}">
      <span class="dl-label">${escapeHtml(label)}</span>
      <div class="${valueClass}">${options.raw ? value : escapeHtml(value)}</div>
    </div>
  `;
}

function setFlashMessage(message, isError = false) {
  detailsFlashMessage.textContent = message || '';
  detailsFlashMessage.classList.toggle('error', Boolean(isError));
}

function renderStickyHeader() {
  const reservation = currentReservation;
  const name = reservation.contact_name || 'Unknown customer';
  const status = formatStatusPill(getEffectiveReservationStatus(reservation));

  detailsAvatar.textContent = getCustomerInitials(name, reservation.contact_email);
  detailsName.textContent = name;
  detailsStatusPill.textContent = status.label;
  detailsStatusPill.className = `status-pill ${escapeHtml(status.key)}`;

  const metaParts = [
    reservation.reservation_number || 'No reservation number',
    reservation.event_type || 'Event',
    formatEventDateTime(reservation),
    reservation.contact_email || 'No email on file'
  ];
  detailsMeta.textContent = metaParts.join(' · ');

  breadcrumbCurrent.textContent = reservation.reservation_number || reservation.reservation_id;

  renderHeaderActions();
}

function renderHeaderActions() {
  const reservation = currentReservation;
  const status = getEffectiveReservationStatus(reservation);
  const approvalState = getReservationApprovalState(reservation);
  const activeRescheduleRequest = getLatestOpenRescheduleRequest(reservation);
  const hasOpenReschedule = Boolean(activeRescheduleRequest && String(activeRescheduleRequest.status || '').toLowerCase() === 'pending');

  if (currentRole === 'admin') {
    detailsHeaderActions.innerHTML = '';
    rescheduleReviewPanel.classList.add('hidden');
    return;
  }

  const buttons = [];

  if (['pending', 'resubmission_requested'].includes(status)) {
    buttons.push(`
      <button type="button" class="header-action-btn primary" data-action="approve" ${approvalState.canApprove ? '' : 'disabled'} title="${escapeHtml(approvalState.reason || 'Approve reservation')}">Approve</button>
      <button type="button" class="header-action-btn decline" data-action="decline">Decline</button>
    `);
  } else if (status === 'approved') {
    buttons.push(`<button type="button" class="header-action-btn primary" data-action="mark-completed">Mark completed</button>`);
  } else if (status === 'cancellation_requested') {
    buttons.push(`<button type="button" class="header-action-btn primary" data-action="confirm-cancellation">Process cancellation</button>`);
  }

  if (hasOpenReschedule) {
    buttons.push(`<button type="button" class="header-action-btn" data-action="toggle-reschedule">Reschedule</button>`);
  }

  detailsHeaderActions.innerHTML = buttons.join('');

  if (hasOpenReschedule) {
    renderRescheduleReviewPanel(activeRescheduleRequest);
  } else {
    rescheduleReviewPanel.classList.add('hidden');
  }
}

function renderRescheduleReviewPanel(request) {
  rescheduleReviewRows.innerHTML = [
    dlRow('Requested date', formatReservationDate(request.requested_date)),
    dlRow('Requested time', request.requested_time || 'No time selected')
  ].join('');
  rescheduleApproveBtn.dataset.requestId = request.reschedule_request_id;
  rescheduleRejectBtn.dataset.requestId = request.reschedule_request_id;
}

function renderBookingDetails() {
  const reservation = currentReservation;
  bookingDetailsGrid.innerHTML = [
    dlRow('Package', reservation.package?.package_name || 'No package selected'),
    dlRow('Guests', reservation.guest_count ? `${reservation.guest_count} pax` : 'Not specified'),
    dlRow('Location type', capitalize(reservation.location_type) || 'Not specified'),
    dlRow('Contact number', reservation.contact_phone || 'No phone on file')
  ].join('');

  bookingDetailsRows.innerHTML = [
    dlRow('Address', reservation.venue_location || 'No address provided', { full: true, muted: !reservation.venue_location }),
    dlRow('Special requests', reservation.special_requests || 'None provided', { full: true, muted: !reservation.special_requests }),
    dlRow('Created', formatDateTime(reservation.created_at))
  ].join('');
}

function renderPayment() {
  const reservation = currentReservation;
  const status = paymentStatus(reservation);
  const balance = getReservationBalanceSummary(reservation);
  const latestPayment = getLatestPaymentEntry(reservation);

  paymentStatusPill.textContent = status.label;
  paymentStatusPill.className = `status-pill ${escapeHtml(status.key)}`;
  openPaymentsLink.href = `/admin/payments.html?reservation=${encodeURIComponent(reservation.reservation_id)}`;

  paymentDetailsGrid.innerHTML = [
    dlRow('Total amount', formatCurrency(balance.totalAmount)),
    dlRow('Paid so far', formatCurrency(balance.approvedTotal)),
    dlRow('Remaining balance', balance.remainingBalance <= 0 ? 'Paid in full' : formatCurrency(balance.remainingBalance)),
    dlRow('Pay by', balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)
  ].join('');

  paymentDetailsRows.innerHTML = latestPayment
    ? dlRow('Latest submission', `${getPaymentTypeLabel(latestPayment.payment_type)} · ${getPaymentMethodLabel(latestPayment.payment_method)} · ${formatCurrency(latestPayment.amount)} · ${formatDateTime(latestPayment.submitted_at)}`)
    : '';
}

function renderSignatureCheckPanel(contract) {
  const note = String(contract.contract?.review_notes || '');
  let state = 'not-scanned';
  if (/signature detected/i.test(note)) {
    state = 'detected';
  } else if (/no .*signature detected|not detected/i.test(note)) {
    state = 'not-detected';
  }

  const copy = {
    detected: {
      icon: '✓',
      title: 'Signature check: detected',
      sub: 'Automatic scan found a signature in the signature area. Open the contract to confirm it matches before approving.'
    },
    'not-detected': {
      icon: '✕',
      title: 'Signature check: not detected',
      sub: 'Automatic scan did not find a signature. Open the contract to check it manually before approving.'
    },
    'not-scanned': {
      icon: '•',
      title: 'Signature check: not yet scanned',
      sub: 'This contract has not been through the automatic signature scan yet. Open the contract to check it manually.'
    }
  }[state];

  signatureCheckPanel.className = `signature-check-panel state-${state}`;
  signatureCheckPanel.innerHTML = `
    <span class="signature-check-icon">${copy.icon}</span>
    <span class="signature-check-copy">
      <span class="signature-check-title">${escapeHtml(copy.title)}</span>
      <span class="signature-check-sub">${escapeHtml(copy.sub)}</span>
    </span>
  `;
}

function renderContract() {
  const reservation = currentReservation;
  const contract = getContractReviewMeta(reservation);

  contractStatusPill.textContent = contract.label;
  contractStatusPill.className = `status-pill ${escapeHtml(contract.key)}`;

  if (contract.hasFile) {
    viewContractLink.href = contract.contract.contract_url;
    viewContractLink.classList.remove('hidden');
  } else {
    viewContractLink.classList.add('hidden');
  }

  if (contract.hasFile) {
    renderSignatureCheckPanel(contract);
    signatureCheckPanel.classList.remove('hidden');
  } else {
    signatureCheckPanel.classList.add('hidden');
  }

  const rows = [dlRow(contract.key === 'approved' ? 'Verified' : 'Verification', contract.verification, { muted: contract.key !== 'approved' })];
  if (contract.reviewedAt && contract.reviewedAt !== contract.verification) rows.push(dlRow('Reviewed', contract.reviewedAt));
  if (contract.resubmittedAt) rows.push(dlRow('Replacement submitted', contract.resubmittedAt));
  if (contract.note) rows.push(dlRow('Admin note', contract.note, { full: true }));
  if (!contract.hasFile) rows.push(dlRow('Status', 'No contract file uploaded yet.', { full: true, muted: true }));
  contractDetailsRows.innerHTML = rows.join('');
}

function renderStaffAssignment() {
  const reservation = currentReservation;
  const status = getEffectiveReservationStatus(reservation);
  const canAssign = status === 'approved';

  staffAssignedList.innerHTML = assignedStaffForReservation.length
    ? assignedStaffForReservation.map((staff) => `<span class="staff-pill">${escapeHtml(getStaffDisplayName(staff))} · ${escapeHtml(formatStaffRole(staff.staff_role))}</span>`).join('')
    : '<span class="staff-pill unassigned">Not assigned yet</span>';

  if (currentRole === 'admin') {
    assignStaffBtn.classList.add('hidden');
    staffAssignHelper.classList.add('hidden');
    return;
  }
  assignStaffBtn.classList.remove('hidden');

  if (!canAssign) {
    assignStaffBtn.setAttribute('disabled', 'true');
    staffAssignHelper.textContent = 'Available after the reservation is approved';
    staffAssignHelper.classList.remove('hidden');
    return;
  }

  if (!assignmentFeatureReady) {
    assignStaffBtn.setAttribute('disabled', 'true');
    staffAssignHelper.textContent = assignmentFeatureMessage;
    staffAssignHelper.classList.remove('hidden');
    return;
  }

  assignStaffBtn.removeAttribute('disabled');
  staffAssignHelper.classList.add('hidden');
}

function renderAll() {
  renderStickyHeader();
  renderBookingDetails();
  renderPayment();
  renderContract();
  renderStaffAssignment();
}

function showLoading() {
  detailsLoading.classList.remove('hidden');
  detailsError.classList.add('hidden');
  detailsContent.classList.add('hidden');
}

function showError(message) {
  detailsErrorMessage.textContent = message;
  detailsLoading.classList.add('hidden');
  detailsError.classList.remove('hidden');
  detailsContent.classList.add('hidden');
}

function showContent() {
  detailsLoading.classList.add('hidden');
  detailsError.classList.add('hidden');
  detailsContent.classList.remove('hidden');
}

/* ---------------------------------------------------------------- */
/* Reload-in-place                                                    */
/* ---------------------------------------------------------------- */

async function reloadAndRender(flashText, isError = false) {
  const reservation = await fetchReservationDetail(currentReservation.reservation_id);
  if (!reservation) {
    showError('This reservation could not be found.');
    return;
  }
  currentReservation = reservation;
  await loadStaffData();
  renderAll();
  setFlashMessage(flashText || '', isError);
}

async function loadStaffData() {
  assignmentFeatureReady = true;
  assignmentFeatureMessage = '';
  staffDirectory = [];
  assignedStaffForReservation = [];

  try {
    staffDirectory = await fetchStaffRoster();
  } catch (err) {
    assignmentFeatureReady = false;
    assignmentFeatureMessage = getStaffDirectoryHint(err);
    return;
  }

  try {
    const map = await fetchReservationAssignments([currentReservation.reservation_id], staffDirectory);
    assignedStaffForReservation = map[currentReservation.reservation_id] || [];
  } catch (err) {
    assignmentFeatureReady = false;
    assignmentFeatureMessage = getAssignmentSchemaHint(err);
  }
}

/* ---------------------------------------------------------------- */
/* Action wiring                                                      */
/* ---------------------------------------------------------------- */

function wireHeaderActions() {
  detailsHeaderActions.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'toggle-reschedule') {
      rescheduleReviewPanel.classList.toggle('hidden');
      return;
    }

    const reservation = currentReservation;
    const previousStatus = reservation.status;

    try {
      button.setAttribute('disabled', 'true');
      setFlashMessage('Updating reservation...');

      if (action === 'approve') {
        const limitMessage = await getApprovalLimitMessage(reservation);
        if (limitMessage) throw new Error(limitMessage);
        const approvalState = getReservationApprovalState(reservation);
        if (!approvalState.canApprove) throw new Error(approvalState.reason);
        await updateReservationStatus(reservation.reservation_id, 'approved', previousStatus);
        await reloadAndRender('Reservation approved.');
      } else if (action === 'decline') {
        await updateReservationStatus(reservation.reservation_id, 'declined', previousStatus);
        await reloadAndRender('Reservation declined.');
      } else if (action === 'mark-completed') {
        await updateReservationStatus(reservation.reservation_id, 'completed', previousStatus);
        await reloadAndRender('Reservation marked completed.');
      } else if (action === 'confirm-cancellation') {
        await updateReservationStatus(reservation.reservation_id, 'cancelled', previousStatus);
        await reloadAndRender('Reservation has been cancelled.');
      }
    } catch (error) {
      setFlashMessage(error.message, true);
      button.removeAttribute('disabled');
    }
  });
}

function wireRescheduleReviewPanel() {
  rescheduleApproveBtn.addEventListener('click', async () => {
    try {
      rescheduleApproveBtn.setAttribute('disabled', 'true');
      setFlashMessage('Updating reschedule request...');
      await handleRescheduleReview(rescheduleApproveBtn.dataset.requestId, 'approved_pending_payment');
      await reloadAndRender('Reschedule request approved.');
    } catch (error) {
      setFlashMessage(error.message, true);
      rescheduleApproveBtn.removeAttribute('disabled');
    }
  });

  rescheduleRejectBtn.addEventListener('click', async () => {
    try {
      rescheduleRejectBtn.setAttribute('disabled', 'true');
      setFlashMessage('Updating reschedule request...');
      await handleRescheduleReview(rescheduleRejectBtn.dataset.requestId, 'rejected');
      await reloadAndRender('Reschedule request rejected.');
    } catch (error) {
      setFlashMessage(error.message, true);
      rescheduleRejectBtn.removeAttribute('disabled');
    }
  });
}

/* ---------------------------------------------------------------- */
/* Staff assignment modal                                             */
/* ---------------------------------------------------------------- */

function setAssignmentModalMessage(message, isError = false) {
  if (!assignmentModalMessage) return;
  assignmentModalMessage.textContent = message;
  assignmentModalMessage.classList.toggle('error', isError);
}

function renderAssignmentSelectionRow() {
  const selectedIds = Array.from(assignmentSelection);
  const count = selectedIds.length;
  const staffById = new Map(staffDirectory.map((staff) => [String(staff.staff_id), staff]));

  const chips = selectedIds.map((staffId) => {
    const staff = staffById.get(staffId);
    const name = staff ? getStaffDisplayName(staff) : 'Unknown staff';
    return `
      <span class="assignment-chip">
        ${escapeHtml(name)}
        <button type="button" class="assignment-chip-remove" data-staff-id="${escapeHtml(staffId)}" aria-label="Remove ${escapeHtml(name)}">&times;</button>
      </span>
    `;
  }).join('');

  assignmentSelectionRow.innerHTML = `<span class="assignment-selection-label">${count} selected${count ? ':' : ''}</span>${chips}`;
}

function syncAssignmentSelectionUI() {
  renderAssignmentSelectionRow();
  assignmentStaffList.querySelectorAll('.assignment-staff-option').forEach((row) => {
    const checkbox = row.querySelector('input[type="checkbox"]');
    row.classList.toggle('selected', Boolean(checkbox?.checked));
  });
}

function renderAssignmentStaffList() {
  const filteredStaff = staffDirectory.filter((staff) => {
    if (!assignmentSearchTerm) return true;
    const haystacks = [getStaffDisplayName(staff), formatStaffRole(staff.staff_role)].filter(Boolean).map((value) => value.toLowerCase());
    return haystacks.some((value) => value.includes(assignmentSearchTerm));
  });

  if (!staffDirectory.length) {
    assignmentStaffList.innerHTML = '<div class="assignment-staff-empty">No staff profiles are available yet.</div>';
    renderAssignmentSelectionRow();
    return;
  }
  if (!filteredStaff.length) {
    assignmentStaffList.innerHTML = '<div class="assignment-staff-empty">No staff match your search.</div>';
    renderAssignmentSelectionRow();
    return;
  }

  assignmentStaffList.innerHTML = filteredStaff.map((staff) => {
    const staffId = String(staff.staff_id);
    const isSelected = assignmentSelection.has(staffId);
    const name = getStaffDisplayName(staff);
    return `
      <label class="assignment-staff-option${isSelected ? ' selected' : ''}">
        <input type="checkbox" value="${escapeHtml(staffId)}" ${isSelected ? 'checked' : ''} />
        <span class="avatar avatar-sm">${escapeHtml(getCustomerInitials(name))}</span>
        <span class="assignment-staff-copy">
          <span class="assignment-staff-name">${escapeHtml(name)}</span>
          <span class="assignment-staff-role">${escapeHtml(formatStaffRole(staff.staff_role))}</span>
        </span>
      </label>
    `;
  }).join('');

  renderAssignmentSelectionRow();
}

function closeAssignmentModal() {
  assignmentSelection = new Set();
  assignmentSearchTerm = '';
  assignmentModal?.classList.add('hidden');
  assignmentModal?.setAttribute('aria-hidden', 'true');
  if (assignmentSearchInput) assignmentSearchInput.value = '';
  assignmentSaveBtn?.removeAttribute('disabled');
  setAssignmentModalMessage('');
}

function openAssignmentModal() {
  if (!assignmentFeatureReady) {
    setFlashMessage(assignmentFeatureMessage, true);
    return;
  }

  const reservation = currentReservation;
  assignmentSelection = new Set(assignedStaffForReservation.map((staff) => String(staff.staff_id)));
  assignmentSearchTerm = '';

  assignmentReservationSummary.textContent = `${reservation.contact_name || 'Customer'} - ${reservation.package?.package_name || 'Reservation'}`;
  assignmentReservationMeta.textContent = `${formatReservationDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;

  assignmentModal.classList.remove('hidden');
  assignmentModal.setAttribute('aria-hidden', 'false');
  renderAssignmentStaffList();
  setAssignmentModalMessage(staffDirectory.length ? '' : 'No staff profiles are available yet.', !staffDirectory.length);
  assignmentSearchInput?.focus();
}

async function saveAssignmentSelection() {
  const reservationId = currentReservation.reservation_id;
  assignmentSaveBtn.setAttribute('disabled', 'true');
  setAssignmentModalMessage('Saving staff assignment...');

  const selectedStaffIds = Array.from(assignmentSelection);
  const existingStaffIds = new Set(assignedStaffForReservation.map((staff) => String(staff.staff_id)));
  const selectedStaffIdSet = new Set(selectedStaffIds);
  const staffIdsToDelete = Array.from(existingStaffIds).filter((staffId) => !selectedStaffIdSet.has(staffId));
  const staffIdsToInsert = selectedStaffIds.filter((staffId) => !existingStaffIds.has(staffId));

  try {
    if (staffIdsToDelete.length) {
      const { error: deleteError } = await supabase
        .from('reservation_staff_assignments')
        .delete()
        .eq('reservation_id', reservationId)
        .in('roster_staff_id', staffIdsToDelete.map(Number));
      if (deleteError) throw deleteError;
    }

    if (staffIdsToInsert.length) {
      const payload = staffIdsToInsert.map((staffId) => ({
        reservation_id: reservationId,
        roster_staff_id: Number(staffId),
        assigned_by: adminSession?.user?.id || null
      }));
      const { error: insertError } = await supabase.from('reservation_staff_assignments').insert(payload);
      if (insertError) throw insertError;
    }

    closeAssignmentModal();
    await reloadAndRender('Staff assignment updated.');
  } catch (error) {
    assignmentFeatureReady = false;
    assignmentFeatureMessage = getAssignmentSchemaHint(error);
    assignmentSaveBtn.removeAttribute('disabled');
    setAssignmentModalMessage(`Failed to save assignment: ${assignmentFeatureMessage}`, true);
  }
}

function wireAssignmentModal() {
  assignStaffBtn?.addEventListener('click', openAssignmentModal);
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
    syncAssignmentSelectionUI();
  });
  assignmentSelectionRow?.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('.assignment-chip-remove');
    if (!removeBtn) return;
    assignmentSelection.delete(removeBtn.dataset.staffId);
    const checkbox = assignmentStaffList.querySelector(`input[type="checkbox"][value="${removeBtn.dataset.staffId}"]`);
    if (checkbox) checkbox.checked = false;
    syncAssignmentSelectionUI();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !assignmentModal.classList.contains('hidden')) closeAssignmentModal();
  });
}

/* ---------------------------------------------------------------- */
/* Sticky header scroll state                                        */
/* ---------------------------------------------------------------- */

function wireStickyHeaderScroll() {
  window.addEventListener('scroll', () => {
    reservationStickyHeader.classList.toggle('is-stuck', window.scrollY > 4);
  }, { passive: true });
}

/* ---------------------------------------------------------------- */
/* Breadcrumb                                                         */
/* ---------------------------------------------------------------- */

function wireBreadcrumb() {
  breadcrumbBack.addEventListener('click', (event) => {
    if (document.referrer && document.referrer.includes('/admin/reservations') && window.history.length > 1) {
      event.preventDefault();
      window.history.back();
    }
  });
}

/* ---------------------------------------------------------------- */
/* Boot                                                                */
/* ---------------------------------------------------------------- */

async function init() {
  showLoading();
  const params = new URLSearchParams(window.location.search);
  const idParam = params.get('id') || params.get('reservation');

  if (!idParam) {
    showError('No reservation was specified.');
    return;
  }

  try {
    const reservation = await fetchReservationDetail(idParam);
    if (!reservation) {
      showError('This reservation could not be found.');
      return;
    }
    currentReservation = reservation;
    await loadStaffData();
    renderAll();
    showContent();
  } catch (error) {
    showError(error.message || 'Failed to load this reservation.');
  }
}

wireHeaderActions();
wireRescheduleReviewPanel();
wireAssignmentModal();
wireStickyHeaderScroll();
wireBreadcrumb();
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
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });
    await init();
  }
});
