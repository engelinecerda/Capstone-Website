import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { refreshAdminSidebarCounts } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { fetchDateAvailability, getBookingScope as getSharedBookingScope } from './reservation_availability.js';
import { getPaymentStatusPillMeta, getCancellationFee } from './reservation_shared.js';
import { recordInCafePayment, uploadPaymentReceipt, fetchCafeIssuedPaymentMethods } from './admin_record_payment.js';
import { paymentMethodIconSvg } from './admin_payment_method_icons.js';
import { loadPaymentRules } from './customer_payments.js';
import { logAudit } from './audit_logger.js';

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
const cancellationReviewPanel = document.getElementById('cancellationReviewPanel');
const cancellationReviewRows = document.getElementById('cancellationReviewRows');
const rescheduleApproveBtn = document.getElementById('rescheduleApproveBtn');
const rescheduleRejectBtn = document.getElementById('rescheduleRejectBtn');
const rescheduleReviewActions = document.getElementById('rescheduleReviewActions');
const rescheduleRejectReasonBlock = document.getElementById('rescheduleRejectReasonBlock');
const rescheduleRejectReasonInput = document.getElementById('rescheduleRejectReasonInput');
const rescheduleRejectCancelBtn = document.getElementById('rescheduleRejectCancelBtn');
const rescheduleRejectConfirmBtn = document.getElementById('rescheduleRejectConfirmBtn');

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

const approvalPromptModal = document.getElementById('approvalPromptModal');
const approvalPromptMeta = document.getElementById('approvalPromptMeta');
const approvalPromptLaterBtn = document.getElementById('approvalPromptLaterBtn');
const approvalPromptAssignBtn = document.getElementById('approvalPromptAssignBtn');

const recordPaymentBtn = document.getElementById('recordPaymentBtn');
const paymentHistoryBody = document.getElementById('paymentHistoryBody');

const recordPaymentModal = document.getElementById('recordPaymentModal');
const recordPaymentModalClose = document.getElementById('recordPaymentModalClose');
const recordPaymentCancelBtn = document.getElementById('recordPaymentCancelBtn');
const recordPaymentSaveBtn = document.getElementById('recordPaymentSaveBtn');
const recordPaymentMessage = document.getElementById('recordPaymentMessage');
const recordPaymentContextName = document.getElementById('recordPaymentContextName');
const recordPaymentContextDate = document.getElementById('recordPaymentContextDate');
const recordPaymentContextBalance = document.getElementById('recordPaymentContextBalance');
const recordPaymentMethodSelect = document.getElementById('recordPaymentMethodSelect');
const recordPaymentMethodIcon = document.getElementById('recordPaymentMethodIcon');
const recordPaymentAmountInput = document.getElementById('recordPaymentAmountInput');
const recordPaymentAmountWarning = document.getElementById('recordPaymentAmountWarning');
const recordPaymentDateInput = document.getElementById('recordPaymentDateInput');
const recordPaymentPlannedNote = document.getElementById('recordPaymentPlannedNote');
const recordPaymentReferenceInput = document.getElementById('recordPaymentReferenceInput');
const recordPaymentFileInput = document.getElementById('recordPaymentFileInput');
const recordPaymentFilePreviewWrap = document.getElementById('recordPaymentFilePreviewWrap');
const recordPaymentFilePreviewImg = document.getElementById('recordPaymentFilePreviewImg');
const recordPaymentFileName = document.getElementById('recordPaymentFileName');
const recordPaymentFileRemoveBtn = document.getElementById('recordPaymentFileRemoveBtn');
const recordPaymentNotesInput = document.getElementById('recordPaymentNotesInput');

const receiptViewerModal = document.getElementById('receiptViewerModal');
const receiptViewerClose = document.getElementById('receiptViewerClose');
const receiptViewerBody = document.getElementById('receiptViewerBody');
const receiptViewerActions = document.getElementById('receiptViewerActions');

const PAYMENT_METHOD_LABELS = {
  gcash: 'GCash',
  maya: 'Maya',
  bpi: 'BPI',
  card: 'Card (POS)',
  bank: 'Bank Transfer',
  ewallet: 'E-Wallet',
  bancnet: 'BancNet',
  gcash_maya: 'GCash/Maya',
  cash: 'Cash'
};
const PAYMENT_TYPE_LABELS = {
  reservation_fee: 'Reservation Fee',
  down_payment: 'Down Payment',
  full_payment: 'Full Payment',
  partial_payment: 'Custom Amount',
  reschedule_fee: 'Reschedule Fee',
  cancellation_fee: 'Cancellation Fee'
};
const CAPACITY_BLOCKING_STATUSES = new Set([
  'pending', 'pending_review', 'for_finalization', 'for_contract_signing',
  'approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled'
]);

let adminSession = null;
let currentRole = null;
let currentReservation = null;
let currentPaymentSummary = null;
let staffDirectory = [];
let assignedStaffForReservation = [];
let assignmentFeatureReady = true;
let assignmentFeatureMessage = '';
let assignmentSelection = new Set();
let assignmentSearchTerm = '';
let recordPaymentMethods = [];
let recordPaymentFile = null;
let receiptViewerZoom = 100;
let currentPaymentRules = null;

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

function getPaymentTypeLabel(type) {
  return PAYMENT_TYPE_LABELS[type] || type || 'Payment';
}

function getPaymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || 'Not yet submitted';
}

function getLatestOpenRescheduleRequest(reservation) {
  return getReservationRescheduleRequests(reservation)
    .find((request) => ['pending', 'approved_pending_payment'].includes(String(request.status || '').toLowerCase())) || null;
}

function getReservationCancellationFeePayment(reservation) {
  return getReservationPayments(reservation)
    .filter((payment) => payment.payment_type === 'cancellation_fee')
    .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

// Reads what the reservation's status was right before the customer's
// cancellation request (logged by js/account.js at request time) so
// rejecting a request restores the exact prior state instead of guessing.
async function findReservationCancellationRevertStatus(reservationId) {
  const { data, error } = await supabase
    .from('reservation_status')
    .select('previous_status, changed_at')
    .eq('reservation_id', reservationId)
    .eq('new_status', 'cancellation_requested')
    .order('changed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.previous_status || 'approved';
}

// The customer's chosen pay-at-café arrival date lives on the payment row
// itself (cash_payment_date on a pending online cash/card submission), not
// on the reservation — and is never touched by recording an in-café
// payment, since that always inserts a new row rather than updating this
// one.
function getPlannedArrivalDate(reservation) {
  const pending = getReservationPayments(reservation)
    .filter((payment) => (
      ['cash', 'card'].includes(payment.payment_method)
      && String(payment.payment_status || '').toLowerCase() === 'pending_review'
      && payment.cash_payment_date
    ))
    .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0];
  return pending ? pending.cash_payment_date : null;
}

function getContractReviewMeta(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  const reviewStatus = String(contract?.review_status || '').toLowerCase();

  if (!contract) {
    return { key: 'default', label: 'Contract missing', verification: 'No contract file uploaded yet', note: '', reviewedAt: '', hasFile: false, contract };
  }
  if (reviewStatus === 'verified' || contract?.verified_date) {
    return {
      key: 'approved',
      label: 'Verified contract',
      verification: contract?.verified_date ? formatDateTime(contract.verified_date) : 'Verified',
      note: '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
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
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }
  return { key: 'default', label: 'Contract missing', verification: 'No contract file uploaded yet', note: '', reviewedAt: '', hasFile: false, contract };
}

function contractStatus(res) {
  return getContractReviewMeta(res);
}

function getReservationApprovalState(reservation) {
  const contract = getContractReviewMeta(reservation);
  if (!contract.hasFile) {
    return { canApprove: false, reason: 'The reservation cannot be approved until the customer uploads a signed contract.' };
  }
  if (contract.key !== 'approved') {
    return { canApprove: false, reason: 'The reservation cannot be approved until the contract has been verified.' };
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
  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at';
  const fallbackSelect = 'reservation_id, contract_url, verified_date, template_id';
  const { data, error } = await supabase.from('reservation_contracts').select(extendedSelect).in('reservation_id', reservationIds);
  if (!error) return data || [];

  if (
    isMissingColumnError(error, 'review_status')
    || isMissingColumnError(error, 'review_notes')
    || isMissingColumnError(error, 'reviewed_at')
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

// Deliberately unfiltered (unlike fetchStaffRoster, which is active-only
// and feeds the "assign someone new" picker) — a deactivated employee must
// still resolve to a name on reservations they're already assigned to,
// not silently vanish from the list.
async function fetchAllStaffRosterForNames() {
  const { data, error } = await supabase
    .from('staff_roster')
    .select('staff_id, first_name, last_name, staff_role, is_active');
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
    user_id,
    cancellation_reason,
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
      .select('payment_id, reservation_id, reschedule_request_id, payment_type, payment_method, payment_method_id, payment_method_label, amount, payment_status, reference_number, payment_date, notes, proof_url, cash_payment_date, submitted_at, verified_at, payment_source, actual_payment_date, actual_payment_time, recorded_by')
      .eq('reservation_id', data.reservation_id)
      .order('submitted_at', { ascending: false }),
    supabase
      .from('reschedule_requests')
      .select('reschedule_request_id, reservation_id, original_date, original_time, requested_date, requested_time, status, requested_at, reviewed_at, rejection_reason')
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

// reservation_payment_summary is a Postgres view — the one place total_paid/
// outstanding_balance/computed_status are calculated, excluding
// cancellation_fee/reschedule_fee from the paid-toward-total sum. Every
// surface that shows payment status reads from this same view.
async function fetchPaymentSummary(reservationId) {
  const { data, error } = await supabase
    .from('reservation_payment_summary')
    .select('reservation_total, total_paid, outstanding_balance, latest_payment_date, computed_status')
    .eq('reservation_id', reservationId)
    .maybeSingle();
  if (error) throw error;
  return data;
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

async function handleRescheduleReview(requestId, nextStatus, rejectionReason = '') {
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

  const updatePayload = { status: nextStatus, reviewed_at: new Date().toISOString() };
  if (nextStatus === 'rejected') {
    updatePayload.rejection_reason = rejectionReason;
  }

  const { error } = await supabase
    .from('reschedule_requests')
    .update(updatePayload)
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

  renderCancellationReviewPanel(reservation, status);

  if (currentRole === 'admin') {
    detailsHeaderActions.innerHTML = '';
    rescheduleReviewPanel.classList.add('hidden');
    return;
  }

  const buttons = [];

  if (status === 'pending') {
    buttons.push(`
      <button type="button" class="header-action-btn primary" data-action="approve" ${approvalState.canApprove ? '' : 'disabled'} title="${escapeHtml(approvalState.reason || 'Approve reservation')}">Approve</button>
      <button type="button" class="header-action-btn decline" data-action="decline">Decline</button>
    `);
  } else if (status === 'approved') {
    buttons.push(`<button type="button" class="header-action-btn primary" data-action="mark-completed">Mark completed</button>`);
  } else if (status === 'cancellation_requested') {
    buttons.push(`
      <button type="button" class="header-action-btn primary" data-action="approve-cancellation">Approve request</button>
      <button type="button" class="header-action-btn decline" data-action="reject-cancellation">Reject request</button>
    `);
  } else if (status === 'cancellation_approved') {
    const feePayment = getReservationCancellationFeePayment(reservation);
    const feeStatus = String(feePayment?.payment_status || '').toLowerCase();
    if (feeStatus === 'approved') {
      buttons.push(`<button type="button" class="header-action-btn primary" data-action="finalize-cancellation">Finalize cancellation</button>`);
    } else if (feePayment) {
      buttons.push(`<span class="header-action-note">Cancellation fee ${escapeHtml(feeStatus === 'rejected' ? 'was rejected — awaiting resubmission' : 'is pending review')}</span>`);
    } else {
      buttons.push(`<span class="header-action-note">Waiting for the customer to pay the cancellation fee</span>`);
    }
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
    dlRow('Original date', formatReservationDate(request.original_date)),
    dlRow('Original time', request.original_time || 'No time selected'),
    dlRow('Requested date', formatReservationDate(request.requested_date)),
    dlRow('Requested time', request.requested_time || 'No time selected')
  ].join('');
  rescheduleApproveBtn.dataset.requestId = request.reschedule_request_id;
  rescheduleRejectBtn.dataset.requestId = request.reschedule_request_id;
  rescheduleRejectConfirmBtn.dataset.requestId = request.reschedule_request_id;
  // renderRescheduleReviewPanel only ever runs for the currently-open
  // (pending) request — see its caller, renderHeaderActions — so any
  // reason-input state left open from a previous render belongs to a
  // request that's no longer active. Reset it here rather than carrying
  // stale open/closed state across re-renders.
  closeRescheduleRejectReason();
}

// Visible for both roles (unlike the reschedule panel) since this is
// read-only context, not an action — Admin still can't approve/reject the
// request itself, but seeing why the customer wants to cancel shouldn't
// require Manager access. Stays visible through cancellation_approved too,
// since the reason is still relevant context while the fee is outstanding.
function renderCancellationReviewPanel(reservation, status) {
  const isCancellationInProgress = ['cancellation_requested', 'cancellation_approved'].includes(status);
  if (!isCancellationInProgress) {
    cancellationReviewPanel.classList.add('hidden');
    return;
  }
  cancellationReviewRows.innerHTML = dlRow(
    'Cancellation reason',
    reservation.cancellation_reason || 'No reason provided',
    { full: true, muted: !reservation.cancellation_reason }
  );
  cancellationReviewPanel.classList.remove('hidden');
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
  const summary = currentPaymentSummary || {
    reservation_total: Number(reservation.total_price || 0),
    total_paid: 0,
    outstanding_balance: Number(reservation.total_price || 0),
    latest_payment_date: null,
    computed_status: 'unpaid'
  };
  const statusMeta = getPaymentStatusPillMeta(summary.computed_status);

  paymentStatusPill.textContent = statusMeta.label;
  paymentStatusPill.className = `status-pill ${escapeHtml(statusMeta.key)}`;
  openPaymentsLink.href = `/admin/payments.html?reservation=${encodeURIComponent(reservation.reservation_id)}`;

  paymentDetailsGrid.innerHTML = [
    dlRow('Reservation total', formatCurrency(summary.reservation_total)),
    dlRow('Total paid', formatCurrency(summary.total_paid)),
    dlRow('Outstanding balance', Number(summary.outstanding_balance) <= 0 ? 'None' : formatCurrency(summary.outstanding_balance)),
    dlRow('Latest payment date', summary.latest_payment_date ? formatReservationDate(summary.latest_payment_date) : 'No payments yet')
  ].join('');

  const extraRows = [];
  const plannedArrival = getPlannedArrivalDate(reservation);
  if (plannedArrival) {
    extraRows.push(dlRow('Planned arrival date', formatReservationDate(plannedArrival)));
  }
  if (String(summary.computed_status).toLowerCase() === 'overpaid') {
    extraRows.push('<p class="payment-overpaid-note">Paid amount exceeds the reservation total — please review.</p>');
  }
  paymentDetailsRows.innerHTML = extraRows.join('');

  renderPaymentHistory();
  renderRecordPaymentAvailability();
}

/* ---------------------------------------------------------------- */
/* Payment history                                                    */
/* ---------------------------------------------------------------- */

function getPaymentChronoValue(payment) {
  const dateKey = payment.actual_payment_date || formatDateKey(payment.payment_date || payment.cash_payment_date || payment.submitted_at);
  const timeValue = payment.actual_payment_time || '00:00:00';
  const parsed = new Date(`${dateKey}T${timeValue}`);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  return new Date(payment.submitted_at || 0).getTime();
}

function renderPaymentHistory() {
  if (!paymentHistoryBody) return;
  const reservation = currentReservation;
  const rows = getReservationPayments(reservation)
    .slice()
    .sort((left, right) => getPaymentChronoValue(left) - getPaymentChronoValue(right));

  if (!rows.length) {
    paymentHistoryBody.innerHTML = '<tr class="payment-history-empty-row"><td colspan="7">No payments recorded yet</td></tr>';
    return;
  }

  paymentHistoryBody.innerHTML = rows.map((payment) => {
    const statusMeta = formatStatusPill(payment.payment_status);
    const dateLabel = formatReservationDate(payment.actual_payment_date || payment.payment_date || payment.cash_payment_date || payment.submitted_at);
    const methodLabel = payment.payment_method_label || getPaymentMethodLabel(payment.payment_method);
    const recordedBy = payment.recorded_by ? 'Manager' : 'Customer';
    const receiptCell = payment.proof_url
      ? `<a href="#" class="payment-history-view-link" data-receipt-url="${escapeHtml(payment.proof_url)}">View</a>`
      : '<span class="payment-history-no-receipt">&mdash;</span>';

    return `
      <tr>
        <td class="payment-history-date">${escapeHtml(dateLabel)}</td>
        <td>${escapeHtml(methodLabel)}</td>
        <td class="payment-history-amount">${escapeHtml(formatCurrency(payment.amount))}</td>
        <td>${escapeHtml(payment.reference_number || '—')}</td>
        <td>${escapeHtml(recordedBy)}</td>
        <td><span class="status-pill ${escapeHtml(statusMeta.key)}">${escapeHtml(statusMeta.label)}</span></td>
        <td>${receiptCell}</td>
      </tr>
    `;
  }).join('');
}

/* ---------------------------------------------------------------- */
/* Receipt viewer — reuses the same zoom-capable image pattern as the  */
/* Payments module's proof viewer; PDFs open via "Open original" only  */
/* (no embedded PDF viewer exists anywhere in this codebase).          */
/* ---------------------------------------------------------------- */

function isPdfReceiptUrl(url) {
  return /\.pdf(\?|$)/i.test(String(url || ''));
}

function renderReceiptViewerImage(url) {
  receiptViewerBody.innerHTML = `
    <div class="proof-preview-stage ${receiptViewerZoom > 100 ? 'zoomed' : ''}">
      <div class="proof-preview-canvas">
        <img class="proof-preview-image" src="${escapeHtml(url)}" alt="Receipt preview" style="width: ${receiptViewerZoom}%;">
      </div>
    </div>
  `;
  receiptViewerActions.innerHTML = `
    <button type="button" class="modal-btn modal-btn-secondary" data-action="receipt-zoom-out" ${receiptViewerZoom <= 50 ? 'disabled' : ''}>-</button>
    <span class="proof-zoom-indicator">${receiptViewerZoom}%</span>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="receipt-zoom-in" ${receiptViewerZoom >= 300 ? 'disabled' : ''}>+</button>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="receipt-zoom-reset" ${receiptViewerZoom === 100 ? 'disabled' : ''}>Fit</button>
    <a class="modal-btn modal-btn-secondary proof-link-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open original</a>
  `;
}

function openReceiptViewer(url) {
  receiptViewerZoom = 100;
  if (isPdfReceiptUrl(url)) {
    receiptViewerBody.innerHTML = '<div class="proof-empty">PDF receipts open in a new tab.</div>';
    receiptViewerActions.innerHTML = `<a class="modal-btn modal-btn-secondary proof-link-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open original</a>`;
  } else {
    renderReceiptViewerImage(url);
  }
  receiptViewerModal?.classList.remove('hidden');
  receiptViewerModal?.setAttribute('aria-hidden', 'false');
}

function closeReceiptViewer() {
  receiptViewerModal?.classList.add('hidden');
  receiptViewerModal?.setAttribute('aria-hidden', 'true');
}

function wireReceiptViewer() {
  paymentHistoryBody?.addEventListener('click', (event) => {
    const link = event.target.closest('.payment-history-view-link');
    if (!link) return;
    event.preventDefault();
    openReceiptViewer(link.dataset.receiptUrl);
  });
  receiptViewerClose?.addEventListener('click', closeReceiptViewer);
  receiptViewerModal?.addEventListener('click', (event) => {
    if (event.target === receiptViewerModal) closeReceiptViewer();
  });
  receiptViewerActions?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const currentImg = receiptViewerBody.querySelector('.proof-preview-image');
    const url = currentImg?.getAttribute('src');
    if (btn.dataset.action === 'receipt-zoom-in') receiptViewerZoom = Math.min(300, receiptViewerZoom + 25);
    else if (btn.dataset.action === 'receipt-zoom-out') receiptViewerZoom = Math.max(50, receiptViewerZoom - 25);
    else if (btn.dataset.action === 'receipt-zoom-reset') receiptViewerZoom = 100;
    if (url) renderReceiptViewerImage(url);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !receiptViewerModal.classList.contains('hidden')) closeReceiptViewer();
  });
}

/* ---------------------------------------------------------------- */
/* Record payment modal                                               */
/* ---------------------------------------------------------------- */

function renderRecordPaymentAvailability() {
  if (!recordPaymentBtn) return;
  if (currentRole === 'admin') {
    recordPaymentBtn.classList.add('hidden');
    return;
  }
  recordPaymentBtn.classList.remove('hidden');
  const isSettled = currentPaymentSummary && ['paid_in_full', 'overpaid'].includes(String(currentPaymentSummary.computed_status).toLowerCase());
  recordPaymentBtn.toggleAttribute('disabled', Boolean(isSettled));
  recordPaymentBtn.title = isSettled ? 'This reservation is already fully paid.' : '';
}

function setRecordPaymentMessage(message, isError = false) {
  if (!recordPaymentMessage) return;
  recordPaymentMessage.textContent = message || '';
  recordPaymentMessage.classList.toggle('error', isError);
}

function renderRecordPaymentMethodOptions() {
  if (!recordPaymentMethodSelect) return;
  if (!recordPaymentMethods.length) {
    recordPaymentMethodSelect.innerHTML = '<option value="">No active café methods configured</option>';
    if (recordPaymentMethodIcon) recordPaymentMethodIcon.innerHTML = '';
    return;
  }
  recordPaymentMethodSelect.innerHTML = recordPaymentMethods.map((method) => `
    <option value="${escapeHtml(method.payment_method_id)}">${escapeHtml(method.label)}</option>
  `).join('');
  recordPaymentMethodSelect.value = recordPaymentMethods[0].payment_method_id;
  updateRecordPaymentMethodIcon();
}

function updateRecordPaymentMethodIcon() {
  if (!recordPaymentMethodIcon) return;
  const method = recordPaymentMethods.find((m) => String(m.payment_method_id) === String(recordPaymentMethodSelect?.value));
  recordPaymentMethodIcon.innerHTML = method ? paymentMethodIconSvg(method.icon_key) : '';
}

function clearRecordPaymentFile() {
  recordPaymentFile = null;
  if (recordPaymentFileInput) recordPaymentFileInput.value = '';
  recordPaymentFilePreviewWrap?.classList.add('hidden');
  if (recordPaymentFilePreviewImg) {
    recordPaymentFilePreviewImg.src = '';
    recordPaymentFilePreviewImg.classList.remove('hidden');
  }
  if (recordPaymentFileName) recordPaymentFileName.textContent = '';
}

function handleRecordPaymentFileChange(event) {
  const file = event.target.files?.[0] || null;
  setRecordPaymentMessage('');
  if (!file) {
    clearRecordPaymentFile();
    return;
  }

  const maxSize = 5 * 1024 * 1024;
  const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']);
  const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.pdf']);
  const mimeType = String(file.type || '').toLowerCase();
  const extension = `.${String(file.name || '').toLowerCase().split('.').pop()}`;

  if (file.size > maxSize) {
    setRecordPaymentMessage('Receipt file must be 5MB or smaller.', true);
    clearRecordPaymentFile();
    return;
  }
  if (!allowedMimeTypes.has(mimeType) && !allowedExtensions.has(extension)) {
    setRecordPaymentMessage('Please upload the receipt as a JPG, JPEG, PNG, or PDF file.', true);
    clearRecordPaymentFile();
    return;
  }

  recordPaymentFile = file;
  if (recordPaymentFileName) recordPaymentFileName.textContent = file.name;
  recordPaymentFilePreviewWrap?.classList.remove('hidden');

  const isPdf = mimeType === 'application/pdf' || extension === '.pdf';
  if (isPdf || !recordPaymentFilePreviewImg) {
    recordPaymentFilePreviewImg?.classList.add('hidden');
  } else {
    recordPaymentFilePreviewImg.classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = () => { recordPaymentFilePreviewImg.src = reader.result; };
    reader.readAsDataURL(file);
  }
}

function checkRecordPaymentAmountWarning() {
  if (!recordPaymentAmountWarning) return;
  const amount = Number(recordPaymentAmountInput?.value || 0);
  const outstanding = Number(currentPaymentSummary?.outstanding_balance ?? currentReservation?.total_price ?? 0);
  if (amount > 0 && outstanding > 0 && amount > outstanding) {
    recordPaymentAmountWarning.textContent = `This is more than the outstanding balance of ${formatCurrency(outstanding)}`;
    recordPaymentAmountWarning.classList.remove('hidden');
  } else {
    recordPaymentAmountWarning.classList.add('hidden');
  }
}

// This page's modal always INSERTs a brand-new payment (an "unplanned"
// payment the customer never pre-submitted) — there's no queue-row context
// here, unlike the Payments module's modal, which only ever confirms an
// existing pending row.
async function openRecordPaymentModal() {
  if (currentRole === 'admin') return;
  const reservation = currentReservation;

  if (recordPaymentAmountInput) recordPaymentAmountInput.value = '';
  if (recordPaymentDateInput) {
    const todayKey = getTodayDateKey();
    recordPaymentDateInput.value = todayKey;
    recordPaymentDateInput.max = todayKey;
  }
  if (recordPaymentReferenceInput) recordPaymentReferenceInput.value = '';
  if (recordPaymentNotesInput) recordPaymentNotesInput.value = '';
  clearRecordPaymentFile();
  recordPaymentAmountWarning?.classList.add('hidden');
  setRecordPaymentMessage('');

  const outstanding = Number(currentPaymentSummary?.outstanding_balance ?? reservation.total_price ?? 0);
  if (recordPaymentContextName) {
    recordPaymentContextName.textContent = `${reservation.contact_name || 'Customer'} · ${reservation.package?.package_name || 'Reservation'}`;
  }
  if (recordPaymentContextDate) {
    recordPaymentContextDate.textContent = `${formatReservationDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;
  }
  if (recordPaymentContextBalance) {
    recordPaymentContextBalance.textContent = formatCurrency(outstanding);
  }
  if (recordPaymentAmountInput) recordPaymentAmountInput.value = outstanding > 0 ? outstanding : '';

  const plannedArrival = getPlannedArrivalDate(reservation);
  if (plannedArrival && recordPaymentPlannedNote) {
    recordPaymentPlannedNote.textContent = `Customer planned to arrive ${formatReservationDate(plannedArrival)} — the planned date is kept on the reservation.`;
    recordPaymentPlannedNote.classList.remove('hidden');
  } else {
    recordPaymentPlannedNote?.classList.add('hidden');
  }

  setRecordPaymentMessage('Loading payment methods...');
  try {
    recordPaymentMethods = await fetchCafeIssuedPaymentMethods(supabase);
    renderRecordPaymentMethodOptions();
    setRecordPaymentMessage(recordPaymentMethods.length ? '' : 'No active café payment methods are configured — add one in Payment Settings first.', !recordPaymentMethods.length);
  } catch (error) {
    setRecordPaymentMessage(`Failed to load payment methods: ${error.message}`, true);
  }

  recordPaymentModal?.classList.remove('hidden');
  recordPaymentModal?.setAttribute('aria-hidden', 'false');
}

function closeRecordPaymentModal() {
  recordPaymentModal?.classList.add('hidden');
  recordPaymentModal?.setAttribute('aria-hidden', 'true');
  recordPaymentSaveBtn?.removeAttribute('disabled');
}

async function saveRecordPayment() {
  if (currentRole === 'admin') return;
  const reservation = currentReservation;

  const selectedMethod = recordPaymentMethods.find((m) => String(m.payment_method_id) === String(recordPaymentMethodSelect?.value));
  if (!selectedMethod) {
    setRecordPaymentMessage('Select a payment method.', true);
    return;
  }

  recordPaymentSaveBtn?.setAttribute('disabled', 'true');
  setRecordPaymentMessage('Saving payment...');

  try {
    let receiptUrl = '';
    if (recordPaymentFile) {
      setRecordPaymentMessage('Uploading receipt...');
      receiptUrl = await uploadPaymentReceipt(recordPaymentFile);
    }

    await recordInCafePayment(supabase, {
      reservationId: reservation.reservation_id,
      amount: recordPaymentAmountInput?.value,
      paymentMethodId: selectedMethod.payment_method_id,
      paymentMethodLabel: selectedMethod.label,
      paymentMethodType: selectedMethod.type,
      actualPaymentDate: recordPaymentDateInput?.value,
      referenceNumber: recordPaymentReferenceInput?.value.trim(),
      notes: recordPaymentNotesInput?.value.trim(),
      receiptUrl,
      recordedByUserId: adminSession?.user?.id
    });

    closeRecordPaymentModal();
    await reloadPaymentSection('Payment recorded.');
  } catch (error) {
    recordPaymentSaveBtn?.removeAttribute('disabled');
    setRecordPaymentMessage(error.message || 'Failed to record payment.', true);
  }
}

function wireRecordPaymentModal() {
  recordPaymentBtn?.addEventListener('click', openRecordPaymentModal);
  recordPaymentModalClose?.addEventListener('click', closeRecordPaymentModal);
  recordPaymentCancelBtn?.addEventListener('click', closeRecordPaymentModal);
  recordPaymentSaveBtn?.addEventListener('click', saveRecordPayment);
  recordPaymentModal?.addEventListener('click', (event) => {
    if (event.target === recordPaymentModal) closeRecordPaymentModal();
  });
  recordPaymentMethodSelect?.addEventListener('change', updateRecordPaymentMethodIcon);
  recordPaymentAmountInput?.addEventListener('input', checkRecordPaymentAmountWarning);
  recordPaymentFileInput?.addEventListener('change', handleRecordPaymentFileChange);
  recordPaymentFileRemoveBtn?.addEventListener('click', clearRecordPaymentFile);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !recordPaymentModal.classList.contains('hidden')) closeRecordPaymentModal();
  });
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
  // Manual override for whenever the automatic scan can't (or hasn't yet)
  // confirmed a signature — approval is otherwise permanently blocked with
  // no way for a Manager to unblock it after visually checking the PDF
  // themselves (see getReservationApprovalState's canApprove gate). Manager-
  // only, matching every other operational mutation on this page.
  const showManualVerifyBtn = state !== 'detected' && currentRole === 'manager';
  signatureCheckPanel.innerHTML = `
    <span class="signature-check-icon">${copy.icon}</span>
    <span class="signature-check-copy">
      <span class="signature-check-title">${escapeHtml(copy.title)}</span>
      <span class="signature-check-sub">${escapeHtml(copy.sub)}</span>
      ${showManualVerifyBtn ? `
        <button type="button" class="signature-manual-verify-btn" data-action="manual-verify-contract">
          I checked the contract — signature confirmed
        </button>
      ` : ''}
    </span>
  `;
}

async function handleManualVerifyContract() {
  const reservation = currentReservation;
  if (!reservation) return;

  const confirmed = window.confirm(
    'Confirm you have opened the contract PDF and visually verified the signature is present and matches the client name.\n\n' +
    'This will mark the contract as verified, bypassing the automatic scan, and allow the reservation to be approved.'
  );
  if (!confirmed) return;

  const button = signatureCheckPanel.querySelector('[data-action="manual-verify-contract"]');
  if (button) button.setAttribute('disabled', 'true');

  try {
    setFlashMessage('Verifying contract...');

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('reservation_contracts')
      .update({
        review_status: 'verified',
        verified_date: now,
        reviewed_at: now,
        review_notes: 'Manually verified: signature confirmed by staff visual review (automatic scan did not detect it).'
      })
      .eq('reservation_id', reservation.reservation_id);

    if (error) throw error;

    await logAudit({
      action: 'Manually Verified Contract Signature',
      category: 'contracts',
      details: 'Automatic signature scan did not confirm a signature; verified manually after visual review.',
      entityId: reservation.reservation_id
    });

    await reloadAndRender('Contract manually verified. The reservation can now be approved.');
  } catch (error) {
    setFlashMessage(error.message || 'Failed to verify contract.', true);
    if (button) button.removeAttribute('disabled');
  }
}

function wireSignatureCheckPanel() {
  signatureCheckPanel.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="manual-verify-contract"]')) {
      handleManualVerifyContract();
    }
  });
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
  currentPaymentSummary = await fetchPaymentSummary(reservation.reservation_id).catch(() => null);
  await loadStaffData();
  renderAll();
  setFlashMessage(flashText || '', isError);
}

// Lighter-weight refresh for the Record payment flow — only the Payment
// card + history need updating, not staff assignment data.
async function reloadPaymentSection(flashText) {
  const reservation = await fetchReservationDetail(currentReservation.reservation_id);
  if (!reservation) return;
  currentReservation = reservation;
  currentPaymentSummary = await fetchPaymentSummary(reservation.reservation_id).catch(() => null);
  renderPayment();
  setFlashMessage(flashText || '', false);
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
    const allRoster = await fetchAllStaffRosterForNames();
    const map = await fetchReservationAssignments([currentReservation.reservation_id], allRoster);
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

    // Defense-in-depth — renderHeaderActions() already empties this
    // container entirely for currentRole === 'admin', so this branch is
    // unreachable in normal use, but it matches the same double-guard
    // pattern already used elsewhere in this file (see
    // openRecordPaymentModal/saveRecordPayment).
    if (currentRole === 'admin') return;

    if (action === 'toggle-reschedule') {
      rescheduleReviewPanel.classList.toggle('hidden');
      // Reset any in-progress reject-reason state so reopening the panel
      // later doesn't resurface a stale open textarea from an earlier
      // visit that was never confirmed or cancelled.
      if (rescheduleReviewPanel.classList.contains('hidden')) {
        closeRescheduleRejectReason();
      }
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
        maybeShowApprovalPrompt();
      } else if (action === 'decline') {
        await updateReservationStatus(reservation.reservation_id, 'declined', previousStatus);
        await reloadAndRender('Reservation declined.');
      } else if (action === 'mark-completed') {
        await updateReservationStatus(reservation.reservation_id, 'completed', previousStatus);
        await reloadAndRender('Reservation marked completed.');

      } else if (action === 'approve-cancellation') {
        await updateReservationStatus(reservation.reservation_id, 'cancellation_approved', previousStatus);

        // Fee amount now respects whatever an admin configured in the
        // Payment Rules panel (system_settings.payment_rules), loaded once
        // at init() into module-level `currentPaymentRules`. The original
        // hardcoded-default call is kept below, commented, so this is a
        // one-line revert if the configured-amount behavior ever needs to
        // be rolled back.
        // const cancellationFeeAmount = getCancellationFee(reservation);
        const cancellationFeeAmount = getCancellationFee(reservation, currentPaymentRules);

        const { error: feeError } = await supabase.from('payment').insert({
          reservation_id: reservation.reservation_id,
          payment_type: 'cancellation_fee',
          amount: cancellationFeeAmount,
          payment_status: 'pending_review',
          submitted_at: new Date().toISOString()
        });
        if (feeError) throw feeError;

        await reloadAndRender('Cancellation request approved. The customer can now pay the cancellation fee.');

      } else if (action === 'reject-cancellation') {
        const revertStatus = await findReservationCancellationRevertStatus(reservation.reservation_id);
        await updateReservationStatus(reservation.reservation_id, revertStatus, previousStatus);

        // Explicit insert rather than relying on the reservation-status DB
        // trigger — NEW.status after a revert (e.g. 'approved') is
        // indistinguishable at the trigger level from a normal transition
        // into that same status, so the trigger's existing 'approved'
        // branch would fire its own "Reservation confirmed" notification
        // instead of a rejection-specific one. This mirrors the plain
        // (non-templated) insert pattern already used for the reschedule
        // "rejected" case in notify_customer_on_reschedule_review().
        if (reservation.user_id) {
          await supabase.from('notifications').insert({
            user_id: reservation.user_id,
            type: 'reservation_status',
            title: 'Cancellation Request Declined',
            body: 'Your cancellation request was not approved. Your reservation remains active — contact us if you have any questions.',
            link: '/account.html'
          });
        }

        await reloadAndRender('Cancellation request rejected. Reservation restored.');

      } else if (action === 'finalize-cancellation') {
        const feePayment = getReservationCancellationFeePayment(reservation);
        const feeStatus = String(feePayment?.payment_status || '').toLowerCase();
        if (!feePayment || feeStatus !== 'approved') {
          throw new Error('The cancellation fee must be approved on the Payments page before finalizing.');
        }

        await updateReservationStatus(reservation.reservation_id, 'cancelled', previousStatus);

        const { error: cancellationError } = await supabase.from('reservation_cancellations').insert({
          reservation_id: reservation.reservation_id,
          user_id: reservation.user_id,
          previous_status: previousStatus,
          reason: reservation.cancellation_reason || null,
          cancelled_at: new Date().toISOString()
        });
        if (cancellationError) throw cancellationError;

        await reloadAndRender('Reservation has been cancelled.');
      }
    } catch (error) {
      setFlashMessage(error.message, true);
      button.removeAttribute('disabled');
    }
  });
}

// Shows the mandatory reason textarea in place of the Approve/Reject
// buttons — mirrors the same click-to-reveal pattern the Payments review
// modal uses for "Reject payment" (js/admin_payments.js), reusing this
// page's own .record-payment-field-label/.record-payment-textarea
// styles rather than pulling in payment-specific classes.
function openRescheduleRejectReason() {
  if (!rescheduleRejectReasonBlock) return;
  rescheduleReviewActions?.classList.add('hidden');
  rescheduleRejectReasonBlock.classList.remove('hidden');
  if (rescheduleRejectReasonInput) rescheduleRejectReasonInput.value = '';
  rescheduleRejectReasonInput?.focus();
}

function closeRescheduleRejectReason() {
  if (!rescheduleRejectReasonBlock) return;
  rescheduleRejectReasonBlock.classList.add('hidden');
  rescheduleReviewActions?.classList.remove('hidden');
  if (rescheduleRejectReasonInput) rescheduleRejectReasonInput.value = '';
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

  // Reject is now a two-step confirmation: this click only reveals the
  // required reason field, it doesn't reject anything by itself.
  rescheduleRejectBtn.addEventListener('click', () => {
    openRescheduleRejectReason();
  });

  rescheduleRejectCancelBtn?.addEventListener('click', () => {
    closeRescheduleRejectReason();
  });

  rescheduleRejectConfirmBtn?.addEventListener('click', async () => {
    const reason = rescheduleRejectReasonInput?.value.trim() || '';
    if (!reason) {
      setFlashMessage('Enter a reason for rejecting this reschedule request.', true);
      rescheduleRejectReasonInput?.focus();
      return;
    }

    try {
      rescheduleRejectConfirmBtn.setAttribute('disabled', 'true');
      setFlashMessage('Updating reschedule request...');
      await handleRescheduleReview(rescheduleRejectConfirmBtn.dataset.requestId, 'rejected', reason);
      await reloadAndRender('Reschedule request rejected.');
    } catch (error) {
      setFlashMessage(error.message, true);
      rescheduleRejectConfirmBtn.removeAttribute('disabled');
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
/* Post-approval staff assignment prompt                             */
/* ---------------------------------------------------------------- */

function closeApprovalPrompt() {
  approvalPromptModal?.classList.add('hidden');
  approvalPromptModal?.setAttribute('aria-hidden', 'true');
}

function openApprovalPrompt() {
  const reservation = currentReservation;
  const metaParts = [
    reservation.contact_name || 'Customer',
    reservation.package?.package_name || 'No package selected',
    formatReservationDate(reservation.event_date)
  ];
  approvalPromptMeta.textContent = metaParts.join(' · ');
  approvalPromptModal.classList.remove('hidden');
  approvalPromptModal.setAttribute('aria-hidden', 'false');
}

// Approval is already committed by the time this runs, so any failure here
// must never surface as an approval error — it only decides whether a
// follow-up prompt appears.
function maybeShowApprovalPrompt() {
  try {
    if (currentRole === 'admin') return;
    if (assignedStaffForReservation.length > 0) return;
    openApprovalPrompt();
  } catch (err) {
    /* prompt is best-effort; approval already stands */
  }
}

function wireApprovalPrompt() {
  approvalPromptLaterBtn?.addEventListener('click', closeApprovalPrompt);
  approvalPromptAssignBtn?.addEventListener('click', () => {
    closeApprovalPrompt();
    openAssignmentModal();
  });
  approvalPromptModal?.addEventListener('click', (event) => {
    if (event.target === approvalPromptModal) closeApprovalPrompt();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !approvalPromptModal.classList.contains('hidden')) closeApprovalPrompt();
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
    currentPaymentRules = await loadPaymentRules(supabase).catch(() => null);
    const reservation = await fetchReservationDetail(idParam);
    if (!reservation) {
      showError('This reservation could not be found.');
      return;
    }
    currentReservation = reservation;
    currentPaymentSummary = await fetchPaymentSummary(reservation.reservation_id).catch(() => null);
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
wireApprovalPrompt();
wireReceiptViewer();
wireRecordPaymentModal();
wireSignatureCheckPanel();
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
    window.__ADMIN_ACTIVE_NAV__ = 'reservations';
    initAdminNav({ role: profile.role });
    await init();
  }
});