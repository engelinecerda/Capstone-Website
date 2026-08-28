import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges  } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { PAGE_SIZE, paginate, renderPagination, getTotalPages } from './pagination.js';
import { getPaymentStatusPillMeta, resolvePaymentEvidenceSource, getCancellationFee, getRescheduleFee } from './reservation_shared.js';
import { recordInCafePayment, uploadPaymentReceipt, ensureReceiptForPayment, fetchCafeIssuedPaymentMethods } from './admin_record_payment.js';
import { paymentMethodIconSvg } from './admin_payment_method_icons.js';
import { loadPaymentRules } from './customer_payments.js';

const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const tableMessage = document.getElementById('tableMessage');
const paymentsBody = document.getElementById('paymentsBody');
const paymentsPagination = document.getElementById('paymentsPagination');

const paymentDetailsModal = document.getElementById('paymentDetailsModal');
const paymentDetailsClose = document.getElementById('paymentDetailsClose');
const paymentDetailsDismiss = document.getElementById('paymentDetailsDismiss');
const paymentAmountRow = document.getElementById('paymentAmountRow');
const paymentAmountStatus = document.getElementById('paymentAmountStatus');
const paymentDetailsRows = document.getElementById('paymentDetailsRows');
const paymentProofPreview = document.getElementById('paymentProofPreview');
const paymentProofActions = document.getElementById('paymentProofActions');
const paymentDetailsMessage = document.getElementById('paymentDetailsMessage');
const paymentReviewActions = document.getElementById('paymentReviewActions');
const receiptModal = document.getElementById('receiptModal');
const receiptModalClose = document.getElementById('receiptModalClose');
const receiptModalDismiss = document.getElementById('receiptModalDismiss');
const receiptDetailsGrid = document.getElementById('receiptDetailsGrid');

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

// Covers both the coarse payment.payment_method enum (card/bancnet/
// gcash_maya/cash) and the older per-provider values some rows still carry
// (gcash/maya/bpi/bank/ewallet — see the backfill CASE statement in
// 20260729_payment_method_evidence_and_snapshot.sql, the source of truth
// for what values actually exist in the column). Rows normally display
// payment.payment_method_label instead (a proper-cased snapshot written at
// submission time — see getPaymentMethodLabel below), so this map is really
// only reached for old rows from before that column existed.
const PAYMENT_METHOD_LABELS = {
  card: 'Debit / Credit Card',
  bancnet: 'Bank Transfer',
  gcash_maya: 'E-Wallet',
  cash: 'Cash',
  gcash: 'GCash',
  maya: 'Maya',
  bpi: 'BPI',
  bank: 'Bank Transfer',
  ewallet: 'E-Wallet'
};

const PAYMENT_CHANNEL_LABELS = {
  card: 'Credit Card',
  bancnet: 'BancNet',
  gcash_maya: 'GCash / Maya',
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
const PAYMENT_BALANCE_DUE_DAYS = 7;

let adminSession = null;
let refreshSidebarBadges = () => {};
let currentRole = null;
let paymentsCache = [];
let paymentsFiltered = [];
let paymentsCurrentPage = 1;
let reservationMap = {};
let receiptMap = {};
let rescheduleRequestMap = {};
let paymentSummaryMap = {};
let paymentMethodMap = {};
let recordPaymentTargetPayment = null;
let recordPaymentMethods = [];
let recordPaymentFile = null;
const reservationFilterParam = new URLSearchParams(window.location.search).get('reservation') || '';
let activePaymentReviewId = null;
let paymentReviewFlash = null;
let rejectReasonPaymentId = null;
let paymentProofZoomPercent = 100;
let currentPaymentRules = null;
const PAYMENT_PROOF_MIN_ZOOM = 50;
const PAYMENT_PROOF_MAX_ZOOM = 300;
const PAYMENT_PROOF_ZOOM_STEP = 25;

function setMessage(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function redirectLogin() {
  window.location.replace('/admin/index.html');
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

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

function formatDate(value) {
  if (!value) return 'No date';
  return new Date(value).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatCompactDate(value) {
  if (!value) return 'No date';
  return new Date(value).toLocaleDateString('en-PH', {
    month: 'short',
    day: 'numeric'
  });
}

function formatDateTime(value) {
  if (!value) return 'Not submitted';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDateKey(value) {
  return String(value || '').split('T')[0];
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

// Falls back to a capitalized version of the raw value (never the raw
// lowercase enum text) for any method string this map doesn't know about,
// so a gap here reads as "Some_method" rather than "some_method" — never
// literally raw-cased like "gcash".
function getPaymentMethodLabel(method) {
  if (PAYMENT_METHOD_LABELS[method]) return PAYMENT_METHOD_LABELS[method];
  if (!method) return 'No method recorded';
  return String(method).charAt(0).toUpperCase() + String(method).slice(1);
}

function getPaymentChannelLabel(method) {
  return PAYMENT_CHANNEL_LABELS[method] || getPaymentMethodLabel(method);
}

function getPaymentTypeLabel(type) {
  return PAYMENT_TYPE_LABELS[type] || type || 'Payment';
}

function getPaymentInfoSummary(payment) {
  const methodLabel = payment.payment_method_label || getPaymentMethodLabel(payment.payment_method);
  const channelLabel = getPaymentChannelLabel(payment.payment_method);
  const evidenceSource = resolvePaymentEvidenceSource(payment, paymentMethodMap);
  const isCafeIssued = evidenceSource === 'cafe_issued';
  const infoLabel = isCafeIssued || methodLabel === channelLabel
    ? methodLabel
    : `${methodLabel} (${channelLabel})`;

  const arrivalDate = payment.cash_payment_date || payment.actual_payment_date;

  return {
    main: infoLabel,
    // formatCompactDate(null) returns the string 'No date' — feeding that
    // straight into `Paid ${...}` produced the "Paid No date" empty state;
    // check the raw value first instead.
    sub: isCafeIssued
      ? (arrivalDate ? `Arrival ${formatCompactDate(arrivalDate)}` : 'No arrival date set')
      : (payment.payment_date ? `Paid ${formatCompactDate(payment.payment_date)}` : 'No payment date recorded')
  };
}

function getStatusMeta(status) {
  const key = String(status || 'pending_review').toLowerCase();
  const map = {
    pending_review: { label: 'Pending Review', key: 'pending' },
    approved: { label: 'Paid', key: 'approved' },
    rejected: { label: 'Rejected', key: 'declined' }
  };
  return map[key] || { label: key, key: 'default' };
}

function getMethodClass(method) {
  return method === 'cash' ? 'cash' : '';
}

function getReservation(reservationId) {
  return reservationMap[reservationId] || null;
}

// Sourced from reservation_payment_summary (the one server-side computed-
// status view every surface reads) instead of re-deriving from paymentsCache
// — that old derivation didn't exclude cancellation_fee/reschedule_fee from
// the paid-toward-total sum. Due-date/overdue framing is a separate, local
// concern (proximity to the event date) not part of the ledger's computed
// status, so it stays computed here.
function getReservationBalanceSummary(reservationId) {
  const reservation = getReservation(reservationId);
  const summary = paymentSummaryMap[reservationId];
  const totalAmount = Number(summary?.reservation_total ?? reservation?.total_price ?? 0);
  const approvedTotal = Number(summary?.total_paid ?? 0);
  const remainingBalance = Number(summary?.outstanding_balance ?? Math.max(totalAmount - approvedTotal, 0));
  const eventDateKey = formatDateKey(reservation?.event_date);

  let dueDateKey = '';
  let dueDateLabel = 'No due date';
  if (eventDateKey) {
    const dueDate = new Date(`${eventDateKey}T00:00:00`);
    if (!Number.isNaN(dueDate.getTime())) {
      dueDate.setDate(dueDate.getDate() - PAYMENT_BALANCE_DUE_DAYS);
      dueDateKey = buildLocalDateKey(dueDate);
      dueDateLabel = formatDate(dueDateKey);
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
    computedStatus: summary?.computed_status || 'unpaid',
    toneKey: remainingBalance <= 0 ? 'approved' : isPastDue ? 'unpaid' : 'pending',
    statusLabel: remainingBalance <= 0 ? 'Paid in Full' : isPastDue ? 'Overdue' : hasPartialPayment ? 'Remaining Balance' : 'Initial Payment'
  };
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

function getReceipt(paymentId) {
  return receiptMap[paymentId] || null;
}

function getRescheduleRequest(requestId) {
  return rescheduleRequestMap[requestId] || null;
}

function countPendingReservations(list) {
  return list.filter((reservation) => String(reservation?.status || '').toLowerCase() === 'pending').length;
}

function getReservationSummary(payment) {
  const reservation = getReservation(payment.reservation_id);
  const packageName = reservation?.package?.package_name || 'Package pending';
  const eventDate = reservation?.event_date ? formatDate(reservation.event_date) : 'No event date';
  const eventTime = reservation?.event_time || 'No time selected';
  return {
    main: packageName,
    sub: `${eventDate} at ${eventTime}`
  };
}

function getCustomerSummary(payment) {
  const reservation = getReservation(payment.reservation_id);
  return {
    main: reservation?.contact_name || 'Unknown customer',
    sub: reservation?.contact_email || ''
  };
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

// Definition-list row — same .dl-row pattern used on the reservation-
// details page and the redesigned contract review modal (see
// css/admin_reservation_details.css / css/admin_contracts.css for the
// source; copied locally here for the same reason those files did: this
// one isn't shared across pages, so a cross-file CSS dependency isn't
// worth it for a handful of rules). options.sub renders a second, muted
// line stacked under the main value (for two-line facts like "package
// name" + "event date"); options.raw skips HTML-escaping the value for
// pre-built markup (e.g. an inline status pill).
function dlRow(label, value, options = {}) {
  const valueMarkup = options.sub
    ? `<span class="dl-value-stack"><span class="dl-value-main">${options.raw ? value : escapeHtml(value)}</span><span class="dl-value-sub">${escapeHtml(options.sub)}</span></span>`
    : (options.raw ? value : escapeHtml(value));
  return `
    <div class="dl-row">
      <span class="dl-label">${escapeHtml(label)}</span>
      <span class="dl-value">${valueMarkup}</span>
    </div>
  `;
}

function setPaymentReviewMessage(message = '', isError = false) {
  if (!paymentDetailsMessage) return;
  paymentDetailsMessage.textContent = message;
  paymentDetailsMessage.classList.toggle('error', isError);
}

function clampPaymentProofZoom(nextZoom) {
  return Math.max(PAYMENT_PROOF_MIN_ZOOM, Math.min(PAYMENT_PROOF_MAX_ZOOM, nextZoom));
}

function renderStats(list) {
  const counts = {
    pending_review: 0,
    approved: 0,
    rejected: 0,
    total: list.length
  };

  list.forEach((payment) => {
    const key = String(payment.payment_status || '').toLowerCase();
    if (counts[key] !== undefined) counts[key] += 1;
  });

  document.getElementById('stat-pending').textContent = counts.pending_review;
  document.getElementById('stat-approved').textContent = counts.approved;
  document.getElementById('stat-rejected').textContent = counts.rejected;
  document.getElementById('stat-total').textContent = counts.total;
  
}

function matchesSearch(payment, term) {
  if (!term) return true;
  const reservation = getReservation(payment.reservation_id);
  const haystacks = [
    reservation?.contact_name,
    reservation?.contact_email,
    reservation?.package?.package_name,
    reservation?.event_time,
    payment.payment_method,
    payment.payment_method_label,
    getPaymentMethodLabel(payment.payment_method),
    getPaymentTypeLabel(payment.payment_type),
    payment.reference_number
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  return haystacks.some((value) => value.includes(term));
}

function matchesStatus(payment, status) {
  if (status === 'all') return true;
  return String(payment.payment_status || '').toLowerCase() === status;
}

function matchesReservationFilter(payment) {
  if (!reservationFilterParam) return true;
  return String(payment.reservation_id) === String(reservationFilterParam);
}

function renderTable(list) {
  if (!paymentsBody) return;
  if (!list.length) {
    paymentsBody.innerHTML = '<tr class="empty-row"><td colspan="6">No payment submissions found.</td></tr>';
    return;
  }

  paymentsBody.innerHTML = list.map((payment) => {
    const reservationSummary = getReservationSummary(payment);
    const customerSummary = getCustomerSummary(payment);
    const statusMeta = getStatusMeta(payment.payment_status);
    const paymentInfo = getPaymentInfoSummary(payment);
    const balance = getReservationBalanceSummary(payment.reservation_id);

    const evidenceSource = resolvePaymentEvidenceSource(payment, paymentMethodMap);
    const isPending = String(payment.payment_status || '').toLowerCase() === 'pending_review';
    const actionCell = (evidenceSource === 'cafe_issued' && isPending && currentRole !== 'admin')
      ? `<button class="action-btn view record-payment-btn" data-action="record-payment" data-payment-id="${payment.payment_id}">Record payment</button>`
      : `<button class="action-btn view review-payment-btn" data-action="review-payment" data-payment-id="${payment.payment_id}">Review Payment</button>`;

    return `
      <tr class="payment-row">
        <td data-label="Reservation">
          <div class="payment-cell-stack">
            <span class="payment-cell-main">${escapeHtml(reservationSummary.main)}</span>
            <span class="payment-cell-sub">${escapeHtml(reservationSummary.sub)}</span>
          </div>
        </td>
        <td data-label="Customer">
          <div class="payment-cell-stack">
            <span class="payment-cell-main">${escapeHtml(customerSummary.main)}</span>
            <span class="payment-cell-sub">${escapeHtml(customerSummary.sub)}</span>
          </div>
        </td>
        <td class="payment-amount-cell" data-label="Amount">
          <span class="payment-cell-main">${escapeHtml(formatCurrency(payment.amount))}</span>
          <span class="payment-cell-sub">Submitted ${escapeHtml(formatDate(payment.submitted_at))}</span>
          <div class="payment-balance-block ${escapeHtml(balance.toneKey)}">
            <span class="payment-balance-amount">${balance.remainingBalance <= 0 ? 'Paid' : `Remaining ${escapeHtml(formatCurrency(balance.remainingBalance))}`}</span>
            <span class="payment-balance-due">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : `Pay by ${balance.dueDateLabel}`)}</span>
          </div>
        </td>
        <td data-label="Payment Info">
          <div class="payment-mode-stack compact">
            <span class="payment-cell-main">${escapeHtml(paymentInfo.main)}</span>
            <span class="payment-cell-sub">${escapeHtml(paymentInfo.sub)}</span>
          </div>
        </td>
        <td data-label="Status">
          <div class="payment-status-stack">
            <span class="status-pill ${escapeHtml(statusMeta.key)}">${escapeHtml(statusMeta.label)}</span>
          </div>
        </td>
        <td class="actions actions-single" data-label="Action">
          ${actionCell}
        </td>
      </tr>
    `;
  }).join('');
}

// resetPage=false is used after an auto-refresh so a Manager mid-way
// through the list isn't yanked back to page 1 every time; the page is
// clamped instead, in case the refreshed data has fewer pages than before.
function filterAndRender({ resetPage = true } = {}) {
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const status = statusDropdown?.value || 'all';
  const filtered = paymentsCache.filter((payment) => (
    matchesReservationFilter(payment)
    && matchesStatus(payment, status)
    && matchesSearch(payment, term)
  ));
  renderStats(paymentsCache);
  paymentsFiltered = filtered;
  if (resetPage) {
    paymentsCurrentPage = 1;
  } else {
    paymentsCurrentPage = Math.min(paymentsCurrentPage, getTotalPages(filtered.length, PAGE_SIZE));
  }
  renderPaymentsPage();
  if (!filtered.length) {
    setMessage(tableMessage, 'No payment submissions match the current filter.');
  } else if (reservationFilterParam) {
    setMessage(tableMessage, 'Showing payment submissions for the selected reservation.');
  } else {
    setMessage(tableMessage, '');
  }
}

function renderPaymentsPage() {
  renderTable(paginate(paymentsFiltered, paymentsCurrentPage, PAGE_SIZE));
  renderPagination(paymentsPagination, {
    totalItems: paymentsFiltered.length,
    currentPage: paymentsCurrentPage,
    pageSize: PAGE_SIZE,
    onPageChange: (page) => {
      paymentsCurrentPage = page;
      renderPaymentsPage();
    }
  });
}

async function fetchReservationsForPayments(reservationIds) {
  if (!reservationIds.length) return {};
  const { data, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      contact_name,
      contact_email,
      event_date,
      event_time,
      status,
      total_price,
      package:package_id ( package_name )
    `)
    .in('reservation_id', reservationIds);

  if (error) throw error;
  return (data || []).reduce((map, reservation) => {
    map[reservation.reservation_id] = reservation;
    return map;
  }, {});
}

async function fetchReceipts(paymentIds) {
  if (!paymentIds.length) return {};
  const { data, error } = await supabase
    .from('receipts')
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .in('payment_id', paymentIds);

  if (error) throw error;
  return (data || []).reduce((map, receipt) => {
    map[receipt.payment_id] = receipt;
    return map;
  }, {});
}

async function fetchRescheduleRequests(requestIds) {
  if (!requestIds.length) return {};
  const { data, error } = await supabase
    .from('reschedule_requests')
    .select(`
      reschedule_request_id,
      reservation_id,
      requested_date,
      requested_time,
      status
    `)
    .in('reschedule_request_id', requestIds);

  if (error) throw error;
  return (data || []).reduce((map, request) => {
    map[request.reschedule_request_id] = request;
    return map;
  }, {});
}

async function fetchPayments() {
  const { data, error } = await supabase
    .from('payment')
    .select(`
      payment_id,
      reservation_id,
      reschedule_request_id,
      payment_type,
      payment_method,
      payment_method_id,
      payment_method_label,
      payment_source,
      amount,
      payment_status,
      reference_number,
      payment_date,
      notes,
      proof_url,
      cash_payment_date,
      actual_payment_date,
      submitted_at,
      verified_at,
      ocr_extracted
    `)
    .order('submitted_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function fetchPaymentMethodsById(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase
    .from('payment_method')
    .select('payment_method_id, label, type, icon_key, evidence_source, is_active')
    .in('payment_method_id', ids);
  if (error) throw error;
  return (data || []).reduce((map, method) => {
    map[method.payment_method_id] = method;
    return map;
  }, {});
}

function getPaymentById(paymentId) {
  return paymentsCache.find((payment) => String(payment.payment_id) === String(paymentId)) || null;
}

// ── OCR helpers ─────────────────────────────────────────────────────────────
const OCR_HINT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

// No confidence badge here on purpose: Cloud Vision's confidence score
// measures character legibility, not whether the parser picked the right
// field out of the receipt text — a badge next to a wrong value tells a
// manager "trust this" when the real risk is field selection, not OCR
// accuracy. These values are demoted to a hint block the manager verifies
// against the image, never a claim of correctness.
function buildOcrPanel(payment) {
  // Café-issued payments (cash/card confirmed at the counter) don't have a
  // proof image to OCR — skip the panel.
  if (resolvePaymentEvidenceSource(payment, paymentMethodMap) === 'cafe_issued') return '';

  // No proof uploaded
  if (!payment.proof_url) return '';

  const ocr = payment.ocr_extracted;
  const panelHead = `
    <div class="ocr-panel-head">
      <span class="ocr-panel-icon">${OCR_HINT_ICON}</span>
      <span class="ocr-panel-title">Read automatically from the proof</span>
    </div>
  `;

  // OCR not yet run
  if (!ocr) {
    return `
      <div class="ocr-panel ocr-panel-none">
        ${panelHead}
        <p class="ocr-panel-note">OCR has not run for this payment yet.</p>
      </div>
    `;
  }

  // OCR attempted but failed
  if (ocr.error) {
    return `
      <div class="ocr-panel ocr-panel-failed">
        ${panelHead}
        <p class="ocr-panel-note">We couldn't read this image automatically: ${escapeHtml(ocr.error)}</p>
      </div>
    `;
  }

  // ocr.amount/ocr.reference_number/ocr.raw_text all come from the same
  // stored ocr_extracted JSON (see supabase/functions/ocr-payment), so the
  // summary fields below and the raw text in the <details> are guaranteed
  // to agree — neither is independently re-derived here.
  const amountDisplay = ocr.amount ? formatCurrency(ocr.amount) : 'Not detected';

  return `
    <div class="ocr-panel">
      ${panelHead}
      <div class="ocr-fields">
        <div class="ocr-field">
          <span class="ocr-field-label">Amount</span>
          <span class="ocr-field-value ${ocr.amount ? '' : 'ocr-not-found'}">${escapeHtml(amountDisplay)}</span>
        </div>
        <div class="ocr-field">
          <span class="ocr-field-label">Reference</span>
          <span class="ocr-field-value ${ocr.reference_number ? '' : 'ocr-not-found'}">${escapeHtml(ocr.reference_number || 'Not detected')}</span>
        </div>
        <div class="ocr-field">
          <span class="ocr-field-label">Date</span>
          <span class="ocr-field-value ${ocr.payment_date ? '' : 'ocr-not-found'}">${escapeHtml(ocr.payment_date || 'Not detected')}</span>
        </div>
      </div>
      <p class="ocr-panel-warning">Best guess only — always confirm against the receipt image.</p>
      ${ocr.raw_text ? `
        <details class="ocr-raw-details">
          <summary>View full extracted text</summary>
          <pre class="ocr-raw-text">${escapeHtml(ocr.raw_text)}</pre>
        </details>
      ` : ''}
    </div>
  `;
}
// ───────────────────────────────────────────────────────────────────────────────
async function handlePaymentReview(paymentId, nextStatus, rejectionReason = '') {
  if (currentRole === 'admin') {
    throw new Error('This action requires the Manager role.');
  }

  const payment = getPaymentById(paymentId);
  if (!payment) throw new Error('Payment record could not be found.');

  const updatePayload = {
    payment_status: nextStatus,
    verified_at: new Date().toISOString()
  };

  if (nextStatus === 'rejected') {
    updatePayload.rejection_reason = rejectionReason;
  }

  const { error: paymentError } = await supabase
    .from('payment')
    .update(updatePayload)
    .eq('payment_id', paymentId);

  if (paymentError) throw paymentError;

  if (nextStatus === 'approved') {
    await ensureReceiptForPayment(supabase, paymentId, getReceipt(paymentId));

    if (payment.payment_type === 'reschedule_fee' && payment.reschedule_request_id) {
      const request = getRescheduleRequest(payment.reschedule_request_id);
      if (!request) {
        throw new Error('Linked reschedule request could not be found.');
      }

      const { error: reservationError } = await supabase
        .from('reservations')
        .update({
          event_date: request.requested_date,
          event_time: request.requested_time,
          status: 'rescheduled'
        })
        .eq('reservation_id', payment.reservation_id);

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

function closeDetailsModal() {
  activePaymentReviewId = null;
  paymentReviewFlash = null;
  rejectReasonPaymentId = null;
  paymentProofZoomPercent = 100;
  paymentDetailsModal?.classList.add('hidden');
  paymentDetailsModal?.setAttribute('aria-hidden', 'true');
  setPaymentReviewMessage('');
}

function closeReceiptModal() {
  receiptModal?.classList.add('hidden');
  receiptModal?.setAttribute('aria-hidden', 'true');
}

// "Expected this payment" only has a well-defined, system-configured value
// for the two flat-fee payment types — cancellation_fee and reschedule_fee
// both come from system_settings.payment_rules via the same
// getCancellationFee/getRescheduleFee helpers the cancellation/reschedule
// flows themselves use (js/reservation_shared.js), so the comparison here
// can never disagree with what the customer was actually charged.
// Everything else (reservation_fee/down_payment/full_payment/
// partial_payment) is a variable amount negotiated per booking — there's
// no fixed figure to compare against, so this returns null rather than
// fabricating one.
function getExpectedPaymentAmount(payment, reservation, paymentRules) {
  if (payment.payment_type === 'cancellation_fee') {
    return { amount: getCancellationFee(reservation, paymentRules), label: 'Cancellation fee' };
  }
  if (payment.payment_type === 'reschedule_fee') {
    return { amount: getRescheduleFee(paymentRules), label: 'Reschedule fee' };
  }
  return { amount: null, label: 'No fixed amount for this payment type' };
}

const AMOUNT_MISMATCH_TOLERANCE_PHP = 1; // guards against float/rounding noise only, not a real allowance
const AMOUNT_MISMATCH_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

function buildAmountComparison(payment, reservation, paymentRules) {
  const expected = getExpectedPaymentAmount(payment, reservation, paymentRules);
  const entered = Number(payment.amount) || 0;
  const read = payment.ocr_extracted?.amount != null ? Number(payment.ocr_extracted.amount) : null;

  const expectedMismatch = expected.amount != null && Math.abs(entered - expected.amount) > AMOUNT_MISMATCH_TOLERANCE_PHP;
  const ocrMismatch = read != null && Math.abs(read - entered) > AMOUNT_MISMATCH_TOLERANCE_PHP;

  return {
    expected,
    entered,
    read,
    expectedMismatch,
    ocrMismatch,
    hasMismatch: expectedMismatch || ocrMismatch,
    hasAnyComparison: expected.amount != null || read != null
  };
}

function renderAmountCards(comparison) {
  const { expected, entered, read, expectedMismatch, ocrMismatch } = comparison;
  return `
    <div class="stat-card${expectedMismatch ? ' mismatch' : ''}">
      <span class="stat-label">Expected this payment</span>
      <div class="stat-value${expected.amount == null ? ' stat-value-muted' : ''}">${expected.amount != null ? escapeHtml(formatCurrency(expected.amount)) : 'No fixed amount'}</div>
      <span class="stat-sub">${escapeHtml(expected.label)}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Customer entered</span>
      <div class="stat-value">${escapeHtml(formatCurrency(entered))}</div>
    </div>
    <div class="stat-card${ocrMismatch ? ' mismatch' : ''}">
      <span class="stat-label">Read from proof</span>
      <div class="stat-value${read == null ? ' stat-value-muted' : ''}">${read != null ? escapeHtml(formatCurrency(read)) : 'Not detected'}</div>
    </div>
  `;
}

function renderAmountStatusLine(comparison) {
  if (!comparison.hasAnyComparison) {
    return '<p class="payment-review-amount-note">No reference amount to check this payment against.</p>';
  }
  if (comparison.hasMismatch) {
    return `
      <div class="payment-review-mismatch-banner">
        ${AMOUNT_MISMATCH_ICON}
        <span>Amounts don't match — check the proof carefully.</span>
      </div>
    `;
  }
  return '<p class="payment-review-match-note">Amounts match.</p>';
}

function renderPaymentReviewModal(paymentId = activePaymentReviewId) {
  const payment = getPaymentById(paymentId);
  if (!payment) return;
  activePaymentReviewId = paymentId;
  const reservation = getReservation(payment.reservation_id);
  const balance = getReservationBalanceSummary(payment.reservation_id);
  const paymentInfo = getPaymentInfoSummary(payment);
  const paymentTypeSub = payment.reschedule_request_id ? 'Linked to reschedule fee' : 'Reservation payment';
  const proofExists = Boolean(payment.proof_url);
  const isCafeIssued = resolvePaymentEvidenceSource(payment, paymentMethodMap) === 'cafe_issued';
  const reviewActions = [];
  const receipt = getReceipt(payment.payment_id);
  const proofIsZoomed = paymentProofZoomPercent > 100;

  // ── Amount comparison strip ───────────────────────────────────────
  const comparison = buildAmountComparison(payment, reservation, currentPaymentRules);
  paymentAmountRow.innerHTML = renderAmountCards(comparison);
  paymentAmountStatus.innerHTML = renderAmountStatusLine(comparison);

  // ── Submission details (definition rows) ──────────────────────────
  const balanceValue = balance.remainingBalance <= 0 ? 'Paid in full' : formatCurrency(balance.remainingBalance);
  const balanceRaw = `${escapeHtml(balanceValue)}${balance.isPastDue ? ' <span class="status-pill overdue">Overdue</span>' : ''}`;

  const detailRows = [
    dlRow('Reservation', reservation?.package?.package_name || 'Package pending', { sub: `${formatDate(reservation?.event_date)} at ${reservation?.event_time || 'No time selected'}` }),
    dlRow('Customer', reservation?.contact_name || 'Unknown customer', { sub: reservation?.contact_email || 'No email on file' }),
    dlRow('Payment type', getPaymentTypeLabel(payment.payment_type), { sub: paymentTypeSub }),
    dlRow('Method', paymentInfo.main, { sub: paymentInfo.sub }),
    dlRow('Reference number', isCafeIssued ? 'Not required for café-issued payments' : (payment.reference_number || 'Not provided')),
    dlRow('Submitted', formatDateTime(payment.submitted_at)),
    dlRow('Balance', balanceRaw, { raw: true })
  ];
  // Only shown when there's actually a note to read — an always-present
  // "No notes provided." row was exactly the kind of empty-state clutter
  // this redesign is meant to remove.
  if (payment.notes) {
    detailRows.push(dlRow('Notes', payment.notes));
  }
  paymentDetailsRows.innerHTML = detailRows.join('');

  paymentProofPreview.innerHTML = proofExists ? `
    <div class="proof-preview-stage ${proofIsZoomed ? 'zoomed' : ''}">
      <div class="proof-preview-canvas">
        <img
          class="proof-preview-image"
          src="${payment.proof_url}"
          alt="Payment proof preview"
          style="width: ${paymentProofZoomPercent}%;"
        >
      </div>
    </div>
  ` : `
    <div class="proof-empty">${isCafeIssued ? 'Café-issued payments do not require a proof image.' : 'No proof image was submitted.'}</div>
  `;

  paymentProofActions.innerHTML = proofExists ? `
    <button type="button" class="modal-btn modal-btn-secondary" data-action="zoom-out" ${paymentProofZoomPercent <= PAYMENT_PROOF_MIN_ZOOM ? 'disabled' : ''}>-</button>
    <span class="proof-zoom-indicator">${paymentProofZoomPercent}%</span>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="zoom-in" ${paymentProofZoomPercent >= PAYMENT_PROOF_MAX_ZOOM ? 'disabled' : ''}>+</button>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="reset-proof-zoom" ${paymentProofZoomPercent === 100 ? 'disabled' : ''}>Fit</button>
    <a class="modal-btn modal-btn-secondary proof-link-btn" href="${payment.proof_url}" target="_blank" rel="noopener noreferrer">Open original &rarr;</a>
  ` : '';

  // Render the demoted OCR hint panel below the proof image
  const ocrPanelEl = document.getElementById('paymentOcrPanel');
  if (ocrPanelEl) {
    ocrPanelEl.innerHTML = buildOcrPanel(payment);
  }

  reviewActions.push('<button type="button" class="modal-btn modal-btn-secondary" id="paymentDetailsDismiss">Close</button>');

  if (currentRole !== 'admin' && String(payment.payment_status || '').toLowerCase() === 'pending_review') {
    // Pending café-issued rows never reach this modal — the queue shows
    // "Record payment" for those instead (see renderTable), so a pending
    // row that gets here for review/approve is always customer_submitted.
    if (rejectReasonPaymentId === payment.payment_id) {
      reviewActions.push(`
        <div class="reject-reason-inline">
          <label class="record-payment-field-label" for="rejectReasonInput">Reason for rejection <span class="record-payment-optional">(required)</span></label>
          <textarea id="rejectReasonInput" class="record-payment-textarea" rows="2" placeholder="e.g. Receipt image was unreadable">${escapeHtml(payment.rejection_reason || '')}</textarea>
        </div>
        <button type="button" class="modal-btn modal-btn-secondary" data-action="cancel-reject-payment" data-payment-id="${payment.payment_id}">Cancel</button>
        <button type="button" class="modal-btn modal-btn-outline-danger" data-action="confirm-reject-payment" data-payment-id="${payment.payment_id}">Confirm rejection</button>
      `);
    } else {
      reviewActions.push(`<button type="button" class="modal-btn modal-btn-outline-danger" data-action="reject-payment" data-payment-id="${payment.payment_id}">Reject payment</button>`);
      reviewActions.push(`<button type="button" class="modal-btn modal-btn-primary" data-action="approve-payment" data-payment-id="${payment.payment_id}">Approve payment</button>`);
    }
  } else if (receipt) {
    reviewActions.push(`<button type="button" class="modal-btn modal-btn-secondary" data-action="view-receipt" data-payment-id="${payment.payment_id}">View receipt</button>`);
  }

  paymentReviewActions.innerHTML = reviewActions.join('');

  if (paymentReviewFlash) {
    setPaymentReviewMessage(paymentReviewFlash.message, paymentReviewFlash.isError);
    paymentReviewFlash = null;
  } else {
    setPaymentReviewMessage('');
  }
}

function openDetailsModal(paymentId) {
  paymentProofZoomPercent = 100;
  renderPaymentReviewModal(paymentId);
  paymentDetailsModal?.classList.remove('hidden');
  paymentDetailsModal?.setAttribute('aria-hidden', 'false');
}

function openReceiptModalForPayment(paymentId) {
  const payment = getPaymentById(paymentId);
  const reservation = payment ? getReservation(payment.reservation_id) : null;
  const receipt = getReceipt(paymentId);
  if (!payment || !receipt) return;

  receiptDetailsGrid.innerHTML = [
    buildDetailCard('Receipt Number', receipt.receipt_number),
    buildDetailCard('Issued', formatDateTime(receipt.issued_at)),
    buildDetailCard('Customer', reservation?.contact_name || 'Unknown customer'),
    buildDetailCard('Reservation', reservation?.package?.package_name || 'Package pending'),
    buildDetailCard('Amount', formatCurrency(payment.amount)),
    buildDetailCard('Method', payment.payment_method_label || getPaymentMethodLabel(payment.payment_method)),
    buildDetailCard('Payment Type', getPaymentTypeLabel(payment.payment_type)),
    buildDetailCard('Event Schedule', `${formatDate(reservation?.event_date)} at ${reservation?.event_time || 'No time selected'}`, { full: true })
  ].join('');

  receiptModal?.classList.remove('hidden');
  receiptModal?.setAttribute('aria-hidden', 'false');
}

/* ---------------------------------------------------------------- */
/* Record payment modal — always attaches to a known queue row        */
/* (payment_id); recording confirms it in place (see decision in     */
/* admin_record_payment.js's recordInCafePayment). There is no        */
/* search-for-a-reservation flow here — that requirement is met by    */
/* the reservation always being known already (the row you clicked).  */
/* ---------------------------------------------------------------- */

function setRecordPaymentMessage(message, isError = false) {
  if (!recordPaymentMessage) return;
  recordPaymentMessage.textContent = message || '';
  recordPaymentMessage.classList.toggle('error', isError);
}

function renderRecordPaymentMethodOptions(selectedMethodId) {
  if (!recordPaymentMethodSelect) return;
  if (!recordPaymentMethods.length) {
    recordPaymentMethodSelect.innerHTML = '<option value="">No active café methods configured</option>';
    recordPaymentMethodIcon.innerHTML = '';
    return;
  }
  recordPaymentMethodSelect.innerHTML = recordPaymentMethods.map((method) => `
    <option value="${escapeHtml(method.payment_method_id)}">${escapeHtml(method.label)}</option>
  `).join('');

  const matchExists = recordPaymentMethods.some((m) => String(m.payment_method_id) === String(selectedMethodId));
  recordPaymentMethodSelect.value = matchExists ? selectedMethodId : recordPaymentMethods[0].payment_method_id;
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
  if (!recordPaymentAmountWarning || !recordPaymentTargetPayment) return;
  const amount = Number(recordPaymentAmountInput?.value || 0);
  const summary = paymentSummaryMap[recordPaymentTargetPayment.reservation_id];
  const reservation = getReservation(recordPaymentTargetPayment.reservation_id);
  const outstanding = Number(summary?.outstanding_balance ?? reservation?.total_price ?? 0);
  if (amount > 0 && outstanding > 0 && amount > outstanding) {
    recordPaymentAmountWarning.textContent = `This is more than the outstanding balance of ${formatCurrency(outstanding)}`;
    recordPaymentAmountWarning.classList.remove('hidden');
  } else {
    recordPaymentAmountWarning.classList.add('hidden');
  }
}

async function openRecordPaymentModalForPayment(paymentId) {
  if (currentRole === 'admin') return;
  const payment = getPaymentById(paymentId);
  if (!payment) return;
  const reservation = getReservation(payment.reservation_id);
  if (!reservation) return;

  recordPaymentTargetPayment = payment;
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

  const summary = paymentSummaryMap[payment.reservation_id];
  const outstanding = Number(summary?.outstanding_balance ?? reservation.total_price ?? 0);
  recordPaymentContextName.textContent = `${reservation.contact_name || 'Customer'} · ${reservation.package?.package_name || 'Reservation'}`;
  recordPaymentContextDate.textContent = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;
  recordPaymentContextBalance.textContent = formatCurrency(outstanding);
  if (recordPaymentAmountInput) recordPaymentAmountInput.value = outstanding > 0 ? outstanding : '';

  const plannedArrival = payment.cash_payment_date;
  if (plannedArrival) {
    recordPaymentPlannedNote.textContent = `Customer planned to arrive ${formatDate(plannedArrival)} — the planned date is kept on the reservation.`;
    recordPaymentPlannedNote.classList.remove('hidden');
  } else {
    recordPaymentPlannedNote.classList.add('hidden');
  }

  setRecordPaymentMessage('Loading payment methods...');
  try {
    recordPaymentMethods = await fetchCafeIssuedPaymentMethods(supabase);
    renderRecordPaymentMethodOptions(payment.payment_method_id);
    setRecordPaymentMessage(recordPaymentMethods.length ? '' : 'No active café payment methods are configured — add one in Payment Settings first.', !recordPaymentMethods.length);
  } catch (error) {
    setRecordPaymentMessage(`Failed to load payment methods: ${error.message}`, true);
  }

  recordPaymentModal?.classList.remove('hidden');
  recordPaymentModal?.setAttribute('aria-hidden', 'false');
}

function closeRecordPaymentModal() {
  recordPaymentTargetPayment = null;
  recordPaymentModal?.classList.add('hidden');
  recordPaymentModal?.setAttribute('aria-hidden', 'true');
  recordPaymentSaveBtn?.removeAttribute('disabled');
}

async function saveRecordPayment() {
  if (currentRole === 'admin') return;
  if (!recordPaymentTargetPayment) {
    setRecordPaymentMessage('No payment selected.', true);
    return;
  }

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
      reservationId: recordPaymentTargetPayment.reservation_id,
      existingPaymentId: recordPaymentTargetPayment.payment_id,
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
    setMessage(tableMessage, 'Payment recorded.');
    await loadData();
  } catch (error) {
    recordPaymentSaveBtn?.removeAttribute('disabled');
    setRecordPaymentMessage(error.message || 'Failed to record payment.', true);
  }
}

function wireRecordPaymentModal() {
  recordPaymentModalClose?.addEventListener('click', closeRecordPaymentModal);
  recordPaymentCancelBtn?.addEventListener('click', closeRecordPaymentModal);
  recordPaymentSaveBtn?.addEventListener('click', saveRecordPayment);
  recordPaymentModal?.addEventListener('click', (event) => {
    if (event.target === recordPaymentModal) closeRecordPaymentModal();
  });
  recordPaymentMethodSelect?.addEventListener('change', () => {
    updateRecordPaymentMethodIcon();
  });
  recordPaymentAmountInput?.addEventListener('input', checkRecordPaymentAmountWarning);
  recordPaymentFileInput?.addEventListener('change', handleRecordPaymentFileChange);
  recordPaymentFileRemoveBtn?.addEventListener('click', clearRecordPaymentFile);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !recordPaymentModal.classList.contains('hidden')) closeRecordPaymentModal();
  });
}

// silent=true is used by the auto-refresh triggers: it skips the
// "Loading..." message so existing rows stay on screen, never re-renders an
// open payment review modal (a background refresh must not disturb a
// Manager mid-review, e.g. typing a rejection reason), and on failure keeps
// the last-good data and fails quietly instead of blanking the table.
async function loadData({ silent = false } = {}) {
  if (!silent) {
    setMessage(tableMessage, 'Loading payment submissions...');
  }
  try {
    paymentsCache = await fetchPayments();
    reservationMap = await fetchReservationsForPayments(
      Array.from(new Set(paymentsCache.map((payment) => payment.reservation_id).filter(Boolean)))
    );
    receiptMap = await fetchReceipts(
      Array.from(new Set(paymentsCache.map((payment) => payment.payment_id).filter(Boolean)))
    );
    rescheduleRequestMap = await fetchRescheduleRequests(
      Array.from(new Set(paymentsCache.map((payment) => payment.reschedule_request_id).filter(Boolean)))
    );
    paymentSummaryMap = await fetchPaymentSummaries(
      Array.from(new Set(paymentsCache.map((payment) => payment.reservation_id).filter(Boolean)))
    );
    paymentMethodMap = await fetchPaymentMethodsById(
      Array.from(new Set(paymentsCache.map((payment) => payment.payment_method_id).filter(Boolean)))
    );

    await refreshSidebarBadges();

    filterAndRender({ resetPage: !silent });
    if (!silent && activePaymentReviewId) {
      if (getPaymentById(activePaymentReviewId)) {
        renderPaymentReviewModal(activePaymentReviewId);
      } else {
        closeDetailsModal();
      }
    }
  } catch (error) {
    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded payments:', error.message);
      return;
    }
    setMessage(tableMessage, `Failed to load payments: ${error.message}`, true);
    await refreshSidebarBadges();
    renderTable([]);
  }
}

function wireFilters() {
  searchInput?.addEventListener('input', filterAndRender);
  statusDropdown?.addEventListener('change', filterAndRender);
}

function wireTableActions() {
  paymentsBody?.addEventListener('click', async (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    const paymentId = actionTarget.dataset.paymentId;
    if (!action || !paymentId) return;

    if (action === 'review-payment') {
      openDetailsModal(paymentId);
    } else if (action === 'record-payment') {
      openRecordPaymentModalForPayment(paymentId);
    }
  });
}

function wireModals() {
  paymentDetailsClose?.addEventListener('click', closeDetailsModal);
  paymentDetailsModal?.addEventListener('click', (event) => {
    if (event.target === paymentDetailsModal) {
      closeDetailsModal();
      return;
    }

    const dismissBtn = event.target.closest('#paymentDetailsDismiss');
    if (dismissBtn) {
      closeDetailsModal();
      return;
    }

    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;

    const action = actionTarget.dataset.action;
    const paymentId = actionTarget.dataset.paymentId || activePaymentReviewId;
    if (!action || !paymentId) return;

    if (action === 'zoom-in') {
      paymentProofZoomPercent = clampPaymentProofZoom(paymentProofZoomPercent + PAYMENT_PROOF_ZOOM_STEP);
      renderPaymentReviewModal(paymentId);
      return;
    }

    if (action === 'zoom-out') {
      paymentProofZoomPercent = clampPaymentProofZoom(paymentProofZoomPercent - PAYMENT_PROOF_ZOOM_STEP);
      renderPaymentReviewModal(paymentId);
      return;
    }

    if (action === 'reset-proof-zoom') {
      paymentProofZoomPercent = 100;
      renderPaymentReviewModal(paymentId);
      return;
    }

    if (action === 'view-receipt') {
      openReceiptModalForPayment(paymentId);
      return;
    }

    if (action === 'reject-payment') {
      rejectReasonPaymentId = paymentId;
      renderPaymentReviewModal(paymentId);
      return;
    }

    if (action === 'cancel-reject-payment') {
      rejectReasonPaymentId = null;
      renderPaymentReviewModal(paymentId);
      return;
    }

    let rejectionReason = '';
    if (action === 'confirm-reject-payment') {
      rejectionReason = document.getElementById('rejectReasonInput')?.value.trim() || '';
      if (!rejectionReason) {
        setPaymentReviewMessage('Please enter a reason for rejecting this payment.', true);
        return;
      }
    }

    (async () => {
      try {
        setPaymentReviewMessage('Updating payment status...');
        if (action === 'approve-payment') await handlePaymentReview(paymentId, 'approved');
        if (action === 'confirm-reject-payment') await handlePaymentReview(paymentId, 'rejected', rejectionReason);
        rejectReasonPaymentId = null;
        paymentReviewFlash = { message: 'Payment updated.', isError: false };
        await loadData();
        setMessage(tableMessage, 'Payment updated.');
      } catch (error) {
        setPaymentReviewMessage(`Failed to update payment: ${error.message}`, true);
        setMessage(tableMessage, `Failed to update payment: ${error.message}`, true);
      }
    })();
  });

  receiptModalClose?.addEventListener('click', closeReceiptModal);
  receiptModalDismiss?.addEventListener('click', closeReceiptModal);
  receiptModal?.addEventListener('click', (event) => {
    if (event.target === receiptModal) closeReceiptModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDetailsModal();
      closeReceiptModal();
    }
  });
}

// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
let lastAutoRefreshAt = 0;
const AUTO_REFRESH_DEBOUNCE_MS = 3000;
const AUTO_REFRESH_POLL_MS = 60000;

function triggerAutoRefresh() {
  const now = Date.now();
  if (now - lastAutoRefreshAt < AUTO_REFRESH_DEBOUNCE_MS) return;
  lastAutoRefreshAt = now;
  loadData({ silent: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') triggerAutoRefresh();
});
window.addEventListener('focus', triggerAutoRefresh);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) triggerAutoRefresh();
});
setInterval(triggerAutoRefresh, AUTO_REFRESH_POLL_MS);

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {

    adminSession = session;
    currentRole = profile.role;

    // Setup inactivity (same as homepage)
    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    refreshSidebarBadges = initAdminSidebarBadges(supabase);
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });

    if (profile.role === 'admin') {
      document.body.classList.add('is-super-admin');
    } else {
      document.body.classList.remove('is-super-admin');
    }

    // Attach UI event listeners
    wireFilters();
    wireTableActions();
    wireModals();
    wireRecordPaymentModal();

    // Loaded once — used by the review modal's "Expected this payment"
    // card for cancellation_fee/reschedule_fee payments (see
    // getExpectedPaymentAmount). Rules change rarely enough that it's not
    // worth re-fetching on every loadData()/auto-refresh call.
    currentPaymentRules = await loadPaymentRules(supabase).catch(() => null);

    // Load data ONCE
    await loadData();
  }
});