import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';
import { refreshAdminSidebarCounts, setBadgeCount } from './admin_sidebar_counts.js';

const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const refreshBtn = document.getElementById('refreshBtn');
const tableMessage = document.getElementById('tableMessage');
const paymentsBody = document.getElementById('paymentsBody');
const navReservationCount = document.getElementById('navReservationCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navContractCount = document.getElementById('navContractCount');
const navReviewCount = document.getElementById('navReviewCount');
const paymentDetailsModal = document.getElementById('paymentDetailsModal');
const paymentDetailsClose = document.getElementById('paymentDetailsClose');
const paymentDetailsDismiss = document.getElementById('paymentDetailsDismiss');
const paymentDetailsGrid = document.getElementById('paymentDetailsGrid');
const paymentProofPreview = document.getElementById('paymentProofPreview');
const paymentProofActions = document.getElementById('paymentProofActions');
const paymentDetailsMessage = document.getElementById('paymentDetailsMessage');
const paymentReviewActions = document.getElementById('paymentReviewActions');
const receiptModal = document.getElementById('receiptModal');
const receiptModalClose = document.getElementById('receiptModalClose');
const receiptModalDismiss = document.getElementById('receiptModalDismiss');
const receiptDetailsGrid = document.getElementById('receiptDetailsGrid');

const PAYMENT_METHOD_LABELS = {
  card: 'Debit / Credit Card',
  bancnet: 'Bank Transfer',
  gcash_maya: 'E-Wallet',
  cash: 'Cash'
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
  reschedule_fee: 'Reschedule Fee'
};
const PAYMENT_BALANCE_DUE_DAYS = 7;

let adminSession = null;
let paymentsCache = [];
let reservationMap = {};
let receiptMap = {};
let rescheduleRequestMap = {};
const reservationFilterParam = new URLSearchParams(window.location.search).get('reservation') || '';
let activePaymentReviewId = null;
let paymentReviewFlash = null;
let paymentProofZoomPercent = 100;
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
  window.location.replace('./admin_login.html');
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

function getPaymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || 'Method';
}

function getPaymentChannelLabel(method) {
  return PAYMENT_CHANNEL_LABELS[method] || getPaymentMethodLabel(method);
}

function getPaymentTypeLabel(type) {
  return PAYMENT_TYPE_LABELS[type] || type || 'Payment';
}

function getPaymentInfoSummary(payment) {
  const methodLabel = getPaymentMethodLabel(payment.payment_method);
  const channelLabel = getPaymentChannelLabel(payment.payment_method);
  const infoLabel = payment.payment_method === 'cash' || methodLabel === channelLabel
    ? methodLabel
    : `${methodLabel} (${channelLabel})`;

  return {
    main: infoLabel,
    sub: payment.payment_method === 'cash'
      ? `Arrival ${formatCompactDate(payment.cash_payment_date)}`
      : `Paid ${formatCompactDate(payment.payment_date)}`
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

function getApprovedBasePaymentsTotal(reservationId) {
  return paymentsCache
    .filter((payment) => (
      String(payment.reservation_id) === String(reservationId)
      && !payment.reschedule_request_id
      && String(payment.payment_status || '').toLowerCase() === 'approved'
    ))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function getReservationBalanceSummary(reservationId) {
  const reservation = getReservation(reservationId);
  const totalAmount = Number(reservation?.total_price || 0);
  const approvedTotal = getApprovedBasePaymentsTotal(reservationId);
  const remainingBalance = Math.max(totalAmount - approvedTotal, 0);
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
    toneKey: remainingBalance <= 0 ? 'approved' : isPastDue ? 'unpaid' : 'pending',
    statusLabel: remainingBalance <= 0 ? 'Paid in Full' : isPastDue ? 'Overdue' : hasPartialPayment ? 'Remaining Balance' : 'Initial Payment'
  };
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

function buildReviewSummaryItem(label, value, subvalue = '') {
  return `
    <div class="review-summary-item">
      <div class="review-summary-label">${escapeHtml(label)}</div>
      <div class="review-summary-copy">
        <div class="review-summary-value">${escapeHtml(value)}</div>
        ${subvalue ? `<div class="review-summary-sub">${escapeHtml(subvalue)}</div>` : ''}
      </div>
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
  setBadgeCount(navPaymentCount, counts.pending_review);
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
          <span class="payment-cell-sub payment-balance-sub ${escapeHtml(balance.toneKey)}">Remaining ${escapeHtml(balance.remainingBalance <= 0 ? 'Paid' : formatCurrency(balance.remainingBalance))}</span>
          <span class="payment-cell-sub payment-balance-sub ${escapeHtml(balance.toneKey)}">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : `Pay by ${balance.dueDateLabel}`)}</span>
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
          <button class="action-btn view review-payment-btn" data-action="review-payment" data-payment-id="${payment.payment_id}">Review Payment</button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAndRender() {
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const status = statusDropdown?.value || 'all';
  const filtered = paymentsCache.filter((payment) => (
    matchesReservationFilter(payment)
    && matchesStatus(payment, status)
    && matchesSearch(payment, term)
  ));
  renderStats(paymentsCache);
  renderTable(filtered);
  if (!filtered.length) {
    setMessage(tableMessage, 'No payment submissions match the current filter.');
  } else if (reservationFilterParam) {
    setMessage(tableMessage, 'Showing payment submissions for the selected reservation.');
  } else {
    setMessage(tableMessage, '');
  }
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
      amount,
      payment_status,
      reference_number,
      payment_date,
      notes,
      proof_url,
      cash_payment_date,
      submitted_at,
      verified_at,
      ocr_extracted
    `)
    .order('submitted_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

function generateReceiptNumber(paymentId) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AR-${stamp}-${String(paymentId || '').slice(0, 6).toUpperCase()}`;
}

async function ensureReceiptForPayment(paymentId) {
  const existingReceipt = getReceipt(paymentId);
  if (existingReceipt) return existingReceipt;

  const { data: lookedUpReceipt, error: lookupError } = await supabase
    .from('receipts')
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (lookedUpReceipt) return lookedUpReceipt;

  const payload = {
    payment_id: paymentId,
    receipt_number: generateReceiptNumber(paymentId),
    issued_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('receipts')
    .insert(payload)
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .single();

  if (error) throw error;
  return data;
}

function getPaymentById(paymentId) {
  return paymentsCache.find((payment) => String(payment.payment_id) === String(paymentId)) || null;
}

// ── OCR helpers ─────────────────────────────────────────────────────────────
function getOcrConfidenceMeta(confidence) {
  const map = {
    high:   { label: 'High confidence',   cls: 'ocr-badge-high' },
    medium: { label: 'Medium confidence', cls: 'ocr-badge-medium' },
    low:    { label: 'Low confidence',    cls: 'ocr-badge-low' },
    failed: { label: 'OCR failed',        cls: 'ocr-badge-failed' }
  };
  return map[confidence] || { label: 'Not processed', cls: 'ocr-badge-none' };
}

function buildOcrPanel(payment) {
  // Cash payments don't have a proof image — skip OCR panel
  if (payment.payment_method === 'cash') return '';

  // No proof uploaded
  if (!payment.proof_url) return '';

  const ocr = payment.ocr_extracted;

  // OCR not yet run
  if (!ocr) {
    return `
      <div class="ocr-panel ocr-panel-none">
        <div class="ocr-panel-head">
          <span class="ocr-panel-title">OCR Extraction</span>
          <span class="ocr-badge ocr-badge-none">Not processed</span>
        </div>
        <p class="ocr-panel-note">OCR has not run for this payment yet.</p>
      </div>
    `;
  }

  // OCR attempted but failed
  if (ocr.error) {
    return `
      <div class="ocr-panel ocr-panel-failed">
        <div class="ocr-panel-head">
          <span class="ocr-panel-title">OCR Extraction</span>
          <span class="ocr-badge ocr-badge-failed">Failed</span>
        </div>
        <p class="ocr-panel-note">Cloud Vision could not read this image: ${escapeHtml(ocr.error)}</p>
      </div>
    `;
  }

  const confidence = getOcrConfidenceMeta(ocr.confidence);
  const amountDisplay = ocr.amount
    ? `\u20B1${Number(ocr.amount).toLocaleString()}`
    : 'Not found';

  return `
    <div class="ocr-panel">
      <div class="ocr-panel-head">
        <span class="ocr-panel-title">\uD83D\uDD0D OCR Extraction</span>
        <span class="ocr-badge ${escapeHtml(confidence.cls)}">${escapeHtml(confidence.label)}</span>
      </div>
      <p class="ocr-panel-note">Automatically read from the uploaded proof. Cross-check with the payment details above before approving.</p>
      <div class="ocr-fields">
        <div class="ocr-field">
          <span class="ocr-field-label">Extracted Amount</span>
          <span class="ocr-field-value ${ocr.amount ? '' : 'ocr-not-found'}">${escapeHtml(amountDisplay)}</span>
        </div>
        <div class="ocr-field">
          <span class="ocr-field-label">Reference Number</span>
          <span class="ocr-field-value ${ocr.reference_number ? '' : 'ocr-not-found'}">${escapeHtml(ocr.reference_number || 'Not found')}</span>
        </div>
        <div class="ocr-field">
          <span class="ocr-field-label">Payment Date</span>
          <span class="ocr-field-value ${ocr.payment_date ? '' : 'ocr-not-found'}">${escapeHtml(ocr.payment_date || 'Not found')}</span>
        </div>
      </div>
      ${ocr.raw_text ? `
        <details class="ocr-raw-details">
          <summary>View full extracted text</summary>
          <pre class="ocr-raw-text">${escapeHtml(ocr.raw_text)}</pre>
        </details>
      ` : ''}
    </div>
  `;
}
// ────────────────────────────────────────────────────────────────────────────

async function handlePaymentReview(paymentId, nextStatus) {
  const payment = getPaymentById(paymentId);
  if (!payment) throw new Error('Payment record could not be found.');

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
  paymentProofZoomPercent = 100;
  paymentDetailsModal?.classList.add('hidden');
  paymentDetailsModal?.setAttribute('aria-hidden', 'true');
  setPaymentReviewMessage('');
}

function closeReceiptModal() {
  receiptModal?.classList.add('hidden');
  receiptModal?.setAttribute('aria-hidden', 'true');
}

function renderPaymentReviewModal(paymentId = activePaymentReviewId) {
  const payment = getPaymentById(paymentId);
  if (!payment) return;
  activePaymentReviewId = paymentId;
  const reservation = getReservation(payment.reservation_id);
  const balance = getReservationBalanceSummary(payment.reservation_id);
  const statusMeta = getStatusMeta(payment.payment_status);
  const paymentInfo = getPaymentInfoSummary(payment);
  const paymentTypeSubvalue = payment.reschedule_request_id ? 'Linked to reschedule fee' : 'Reservation payment';
  const proofExists = Boolean(payment.proof_url);
  const reviewActions = [];
  const receipt = getReceipt(payment.payment_id);
  const proofIsZoomed = paymentProofZoomPercent > 100;

  paymentDetailsGrid.innerHTML = [
    buildReviewSummaryItem('Reservation', reservation?.package?.package_name || 'Package pending', `${formatDate(reservation?.event_date)} at ${reservation?.event_time || 'No time selected'}`),
    buildReviewSummaryItem('Customer', reservation?.contact_name || 'Unknown customer', reservation?.contact_email || 'No email on file'),
    buildReviewSummaryItem('Total Amount', formatCurrency(balance.totalAmount)),
    buildReviewSummaryItem('Approved Payments', formatCurrency(balance.approvedTotal)),
    buildReviewSummaryItem(
      'Remaining Balance',
      balance.remainingBalance <= 0 ? 'Paid in Full' : formatCurrency(balance.remainingBalance),
      balance.statusLabel
    ),
    buildReviewSummaryItem(
      'Pay By',
      balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel,
      balance.remainingBalance <= 0
        ? 'All required reservation payments are already cleared.'
        : (balance.isPastDue ? 'The reservation balance is already overdue.' : 'Final balance is due one week before the event.')
    ),
    buildReviewSummaryItem('Amount', formatCurrency(payment.amount)),
    buildReviewSummaryItem('Payment Type', getPaymentTypeLabel(payment.payment_type), paymentTypeSubvalue),
    buildReviewSummaryItem('Payment Method', paymentInfo.main, paymentInfo.sub),
    buildReviewSummaryItem('Submitted On', formatDateTime(payment.submitted_at)),
    buildReviewSummaryItem(
      payment.payment_method === 'cash' ? 'Arrival Date' : 'Paid On',
      payment.payment_method === 'cash' ? formatDate(payment.cash_payment_date) : formatDate(payment.payment_date)
    ),
    buildReviewSummaryItem(
      'Reference Number',
      payment.payment_method === 'cash' ? 'Not required for cash payments' : (payment.reference_number || 'Not provided')
    ),
    buildReviewSummaryItem('Status', statusMeta.label),
    buildReviewSummaryItem('Notes', payment.notes || 'No notes provided.')
  ].join('');

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
    <div class="proof-empty">${payment.payment_method === 'cash' ? 'Cash payments do not require a proof image.' : 'No proof image was submitted.'}</div>
  `;

  paymentProofActions.innerHTML = proofExists ? `
    <button type="button" class="modal-btn modal-btn-secondary" data-action="zoom-out" ${paymentProofZoomPercent <= PAYMENT_PROOF_MIN_ZOOM ? 'disabled' : ''}>-</button>
    <span class="proof-zoom-indicator">${paymentProofZoomPercent}%</span>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="zoom-in" ${paymentProofZoomPercent >= PAYMENT_PROOF_MAX_ZOOM ? 'disabled' : ''}>+</button>
    <button type="button" class="modal-btn modal-btn-secondary" data-action="reset-proof-zoom" ${paymentProofZoomPercent === 100 ? 'disabled' : ''}>Fit</button>
    <a class="modal-btn modal-btn-secondary proof-link-btn" href="${payment.proof_url}" target="_blank" rel="noopener noreferrer">Open Original</a>
  ` : '';

  // Render OCR panel below the proof image
  const ocrPanelEl = document.getElementById('paymentOcrPanel');
  if (ocrPanelEl) {
    ocrPanelEl.innerHTML = buildOcrPanel(payment);
  }

  reviewActions.push('<button type="button" class="modal-btn modal-btn-secondary" id="paymentDetailsDismiss">Close</button>');

  if (String(payment.payment_status || '').toLowerCase() === 'pending_review') {
    reviewActions.push(`<button type="button" class="modal-btn modal-btn-danger" data-action="reject-payment" data-payment-id="${payment.payment_id}">Reject Payment</button>`);
    reviewActions.push(`<button type="button" class="modal-btn modal-btn-success" data-action="approve-payment" data-payment-id="${payment.payment_id}">${escapeHtml(payment.payment_method === 'cash' ? 'Approve Cash Payment' : 'Approve Payment')}</button>`);
  } else if (receipt) {
    reviewActions.push(`<button type="button" class="modal-btn modal-btn-secondary" data-action="view-receipt" data-payment-id="${payment.payment_id}">View Receipt</button>`);
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
    buildDetailCard('Method', getPaymentMethodLabel(payment.payment_method)),
    buildDetailCard('Payment Type', getPaymentTypeLabel(payment.payment_type)),
    buildDetailCard('Event Schedule', `${formatDate(reservation?.event_date)} at ${reservation?.event_time || 'No time selected'}`, { full: true })
  ].join('');

  receiptModal?.classList.remove('hidden');
  receiptModal?.setAttribute('aria-hidden', 'false');
}

async function loadData() {
  setMessage(tableMessage, 'Loading payment submissions...');
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

    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });

    filterAndRender();
    if (activePaymentReviewId) {
      if (getPaymentById(activePaymentReviewId)) {
        renderPaymentReviewModal(activePaymentReviewId);
      } else {
        closeDetailsModal();
      }
    }
  } catch (error) {
    setMessage(tableMessage, `Failed to load payments: ${error.message}`, true);
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

    (async () => {
      try {
        setPaymentReviewMessage('Updating payment status...');
        if (action === 'approve-payment') await handlePaymentReview(paymentId, 'approved');
        if (action === 'reject-payment') await handlePaymentReview(paymentId, 'rejected');
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
  wireFilters();
  wireTableActions();
  wireModals();
  await loadData();
})();
