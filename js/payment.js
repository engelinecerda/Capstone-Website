import { customerSupabase as supabase } from './supabase.js';
import { initAutoRefresh } from './auto_refresh.js';
import {
    REFERENCE_NUMBER_PATTERNS,
    buildCustomerAccountUrl,
    getAvailablePaymentOptions,
    getLatestApprovedReservationPayment,
    getLatestReservationPayment,
    getPaymentLabel,
    getPaymentStatusMeta,
    getPaymentSummary,
    getReservationBalanceDetails,
    getReservationPayments,
    getReservationReceipts,
    isCompletedPaymentOverview,
    isPendingPaymentOverview,
    loadCustomerPaymentBundle,
    loadPaymentMethods,
    loadPaymentRules,
    loadPaymentTypes,
    loadReservationRules,
    submitCustomerPayment,
    validateReferenceNumber
} from './customer_payments.js';

// Small display-only map for historical payment records whose stored
// payment_method free-text happens to match a legacy brand key — used only
// to show a nicer label on already-submitted payments, never to drive the
// live method selector (that's fully DB-driven, see loadPaymentMethods()).
const LEGACY_METHOD_DISPLAY_LABELS = {
    gcash: 'GCash',
    maya: 'Maya',
    bpi: 'Bank Transfer',
    bank: 'Bank Transfer',
    ewallet: 'E-wallet',
    cash: 'Cash',
    card: 'Card'
};

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
}

const user = session.user;
const paymentApp = document.getElementById('payment-page-app');
const paymentBackLink = document.getElementById('payment-back-link');
const receiptModalBackdrop = document.getElementById('receipt-modal-backdrop');
const receiptModalClose = document.getElementById('receipt-modal-close');
const receiptModalDismiss = document.getElementById('receipt-modal-dismiss');
const receiptView = document.getElementById('receipt-view');

const state = {
    bundle: {
        reservations: [],
        paymentsByReservationId: {},
        receiptsByPaymentId: {},
        reschedulesByReservationId: {}
    },
    reservationId: new URLSearchParams(window.location.search).get('reservation_id') || '',
    reservationRules: null,
    paymentRules: null,
    paymentTypes: null,
    paymentMethods: [],
    cancellationInfo: null,
    activeTab: 'current',
    selectedMethod: '',
    selectedOptionKey: '',
    isSubmitting: false,
    flashMessage: '',
    flashType: '',
    form: {
        customAmount: '',
        referenceNumber: '',
        paymentDate: '',
        cashPaymentDate: '',
        notes: '',
        proofFile: null
    }
};

if (paymentBackLink) {
    paymentBackLink.href = buildCustomerAccountUrl('reservations');
    paymentBackLink.addEventListener('click', (event) => {
        event.preventDefault();
        window.location.href = buildCustomerAccountUrl('reservations');
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCurrency(value) {
    return `₱${Number(value || 0).toLocaleString()}`;
}

function formatDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function formatShortDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function formatDateTime(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not available';
    return date.toLocaleString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

function getTodayDateKey() {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

function getCustomerDisplayName() {
    const firstName = user.user_metadata?.first_name || '';
    const middleName = user.user_metadata?.middle_name || '';
    const lastName = user.user_metadata?.last_name || '';
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ').trim();
    return fullName || user.email || 'Customer';
}

function getReservation() {
    return state.bundle.reservations.find((entry) => String(entry.reservation_id) === String(state.reservationId)) || null;
}

function getReservationPackageName(reservation) {
    return reservation?.package?.package_name || reservation?.package_id || 'No package selected';
}

function getActivePaymentSummary(reservation) {
    return getPaymentSummary(
        reservation,
        state.bundle.paymentsByReservationId,
        state.bundle.reschedulesByReservationId,
        { formatDate }
    );
}

function getActiveBalance(reservation) {
    return getReservationBalanceDetails(reservation, state.bundle.paymentsByReservationId, {
        formatDate,
        reservationRules: state.reservationRules
    });
}

function getActivePaymentOptions(reservation) {
    return getAvailablePaymentOptions(
        reservation,
        state.bundle.paymentsByReservationId,
        state.bundle.reschedulesByReservationId,
        { formatDate, reservationRules: state.reservationRules, paymentTypes: state.paymentTypes, paymentRules: state.paymentRules }
    );
}

function getSelectedMethodObject() {
    return state.paymentMethods.find((m) => m.id === state.selectedMethod) || null;
}

function getPaymentOptionKey(option) {
    return `${option.paymentType}:${option.rescheduleRequestId || ''}`;
}

function getVisibleOptions(reservation) {
    const options = getActivePaymentOptions(reservation);
    if (getSelectedMethodObject()?.type === 'onsite') {
        return options.filter((option) => option.paymentType === 'full_payment');
    }
    return options;
}

function getSelectedOption(reservation) {
    const visibleOptions = getVisibleOptions(reservation);
    return visibleOptions.find((option) => getPaymentOptionKey(option) === state.selectedOptionKey) || visibleOptions[0] || null;
}

function syncSelections(reservation) {
    const allOptions = getActivePaymentOptions(reservation);
    const cashAllowed = allOptions.some((option) => option.paymentType === 'full_payment');

    if (getSelectedMethodObject()?.type === 'onsite' && !cashAllowed) {
        const fallback = state.paymentMethods.find((m) => m.type !== 'onsite');
        state.selectedMethod = fallback?.id || state.paymentMethods[0]?.id || '';
    }

    const visibleOptions = getVisibleOptions(reservation);
    if (!visibleOptions.length) {
        state.selectedOptionKey = '';
        return;
    }

    const selectedStillVisible = visibleOptions.some((option) => getPaymentOptionKey(option) === state.selectedOptionKey);
    if (!selectedStillVisible) {
        state.selectedOptionKey = getPaymentOptionKey(visibleOptions[0]);
    }
}

function getTopSummary(reservation) {
    const paymentSummary = getActivePaymentSummary(reservation);
    const balance = getActiveBalance(reservation);
    const availableOptions = getActivePaymentOptions(reservation);
    const latestPayment = getLatestReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);
    const highlightedAmount = paymentSummary.key === 'pending'
        ? Number(latestPayment?.amount || 0)
        : availableOptions[0]?.amount || 0;

    return {
        paymentSummary,
        balance,
        highlightedAmount
    };
}

// One pill component reused everywhere on this page (also used on the
// account and reservation-details pages) — icon + label, soft tint per
// state. Payment-summary "key" values (pending/approved/info/rejected) get
// mapped onto that same 4-tone system here.
function getHeaderStatusMeta(reservation, paymentSummary, balance) {
    if (String(reservation.status || '').toLowerCase() === 'cancelled') {
        return { cssKey: 'cancelled', icon: 'ban', label: 'Cancelled' };
    }
    if (balance.remainingBalance <= 0) {
        return { cssKey: 'approved', icon: 'check', label: 'Paid in Full' };
    }
    if (paymentSummary.key === 'pending') {
        return { cssKey: 'pending', icon: 'clock', label: 'Pending Review' };
    }
    if (balance.isPastDue) {
        return { cssKey: 'overdue', icon: 'triangle-exclamation', label: 'Overdue' };
    }
    if (balance.hasPartialPayment) {
        return { cssKey: 'pending', icon: 'clock', label: 'Partially Paid' };
    }
    return { cssKey: 'pending', icon: 'clock', label: 'Payment Needed' };
}

function renderSummaryStrip(reservation) {
    const { paymentSummary, balance, highlightedAmount } = getTopSummary(reservation);
    const statusMeta = getHeaderStatusMeta(reservation, paymentSummary, balance);

    return `
        <section class="payment-hero-card">
            <div class="payment-hero-left">
                <h1 class="payment-hero-title">${escapeHtml(reservation.event_type || 'Reservation Payment')}</h1>
                <div class="payment-hero-meta">
                    ${escapeHtml(getReservationPackageName(reservation))} &middot; ${escapeHtml(String(reservation.guest_count || 0))} pax &middot; ${escapeHtml(formatDate(reservation.event_date))} &middot; ${escapeHtml(reservation.event_time || 'No time selected')}
                </div>
            </div>
            <div class="payment-hero-right">
                <span class="res-status ${escapeHtml(statusMeta.cssKey)}"><i class="fa-solid fa-${escapeHtml(statusMeta.icon)}" aria-hidden="true"></i> ${escapeHtml(statusMeta.label)}</span>
                <div>
                    <div class="payment-hero-pay-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Paid' : formatCurrency(highlightedAmount || balance.remainingBalance))}</div>
                </div>
                <div class="payment-hero-pay-meta">
                    ${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : `Due ${balance.dueDateLabel}`)}
                </div>
            </div>
        </section>
    `;
}

// Shown under the header once the required payment is both overdue AND
// unsubmitted — no pending review in flight. Purely informational; the
// actual cancellation happens server-side (see auto_cancel_overdue_reservations
// in supabase/migrations/20260716_payment_overhaul.sql).
function renderOverdueStrip(reservation) {
    const balance = getActiveBalance(reservation);
    const pendingPayment = getLatestReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);
    const hasPendingReview = pendingPayment && String(pendingPayment.payment_status || '').toLowerCase() === 'pending_review';

    if (String(reservation.status || '').toLowerCase() === 'cancelled') return '';
    if (!balance.isPastDue || balance.remainingBalance <= 0 || hasPendingReview) return '';

    return `
        <div class="payment-overdue-strip">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
            <p>
                Payment was due ${escapeHtml(balance.dueDateLabel)}. Unpaid reservations are automatically
                cancelled after ${escapeHtml(balance.graceDeadlineLabel || 'the grace period')}, and the
                cancellation fee applies per the service agreement.
            </p>
        </div>
    `;
}

function getCancellationReasonText(reservation) {
    if (reservation.cancellation_reason === 'auto_cancelled_overdue') {
        return state.cancellationInfo?.reason
            || 'Automatically cancelled: payment was not received within the grace period.';
    }
    return state.cancellationInfo?.reason || 'This reservation has been cancelled.';
}

// Replaces the whole payment form once a reservation is cancelled — there is
// nothing left to pay toward, so the actionable/pending/complete cards never
// render in this state.
function renderCancellationCard(reservation) {
    const feePayment = getReservationPayments(state.bundle.paymentsByReservationId, reservation.reservation_id)
        .find((payment) => payment.payment_type === 'cancellation_fee') || null;
    const contractUrl = `/reservation-details.html?reservation_id=${encodeURIComponent(reservation.reservation_id)}`;

    return `
        <section class="payment-focus-card">
            <div class="payment-cancellation-card">
                <span class="res-status cancelled"><i class="fa-solid fa-ban" aria-hidden="true"></i> Cancelled</span>
                <h2 class="payment-readonly-title">This reservation has been cancelled</h2>
                <p class="payment-readonly-copy">${escapeHtml(getCancellationReasonText(reservation))}</p>
                ${feePayment ? `
                    <div class="payment-dl">
                        <div class="payment-dl-row">
                            <span>Cancellation fee</span>
                            <strong>${escapeHtml(formatCurrency(feePayment.amount))}</strong>
                        </div>
                        <div class="payment-dl-row">
                            <span>Fee status</span>
                            <strong>${escapeHtml(getPaymentStatusMeta(feePayment.payment_status).label)}</strong>
                        </div>
                    </div>
                ` : ''}
                <a class="res-link-btn" href="${escapeHtml(contractUrl)}">
                    <i class="fa-solid fa-file-lines" aria-hidden="true"></i> View service agreement
                </a>
            </div>
        </section>
    `;
}

function renderPaymentMethodButtons(reservation) {
    if (!state.paymentMethods.length) {
        return `<p class="payment-empty-methods">No payment methods are available right now — please contact us.</p>`;
    }

    const allOptions = getActivePaymentOptions(reservation);
    const cashAllowed = allOptions.some((option) => option.paymentType === 'full_payment');

    return state.paymentMethods.map((method) => {
        const isDisabled = method.type === 'onsite' && !cashAllowed;
        return `
            <button
                type="button"
                class="payment-select-chip ${state.selectedMethod === method.id ? 'active' : ''}"
                data-payment-method="${escapeHtml(method.id)}"
                ${isDisabled ? 'disabled' : ''}
            >
                ${escapeHtml(method.shortLabel || method.label)}
            </button>
        `;
    }).join('');
}

// Custom amount used to be <input type="number">, which lets mouse-wheel
// scroll and ArrowUp/ArrowDown silently increment/decrement the value while
// focused (the browser's native spinner behavior) — the single most common
// cause of a typed value coming out wrong with no visible error. Switched to
// a plain text input (see renderCustomAmountPanel) with this function doing
// the actual digit filtering by hand: strip anything that isn't a digit or
// a decimal point, collapse to at most one decimal point, and cap to 2
// decimal places. No comma/peso formatting here — that stays display-only
// (formatCurrency), never applied to the value the user is actively typing
// into or the one stored in state.
function sanitizeAmountInput(raw) {
    let cleaned = String(raw || '').replace(/[^\d.]/g, '');

    const firstDot = cleaned.indexOf('.');
    if (firstDot !== -1) {
        cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
        const [intPart, decPart] = cleaned.split('.');
        cleaned = `${intPart}.${decPart.slice(0, 2)}`;
    }

    return cleaned;
}

function renderCustomAmountPanel(reservation, option) {
    if (!option || option.paymentType !== 'partial_payment') return '';

    const balance = getActiveBalance(reservation);
    const raw = state.form.customAmount;
    const parsed = Number(raw);
    const isValidNumber = raw !== '' && Number.isFinite(parsed);
    const remainingAfter = isValidNumber ? Math.max(balance.remainingBalance - parsed, 0) : balance.remainingBalance;

    let validationMessage = '';
    if (isValidNumber) {
        if (parsed < option.minAmount) validationMessage = `Enter at least ${formatCurrency(option.minAmount)}.`;
        else if (parsed > option.maxAmount) validationMessage = `Enter at most ${formatCurrency(option.maxAmount)}.`;
    }

    return `
        <div class="payment-custom-amount-panel">
            <label for="payment-custom-amount">Custom amount</label>
            <input
                id="payment-custom-amount"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                placeholder="e.g. ${escapeHtml(option.minAmount)}"
                data-field="customAmount"
                value="${escapeHtml(raw)}"
            >
            <p class="payment-custom-amount-hint">Minimum ${escapeHtml(formatCurrency(option.minAmount))} &middot; Maximum ${escapeHtml(formatCurrency(option.maxAmount))}</p>
            ${validationMessage ? `<p class="payment-custom-amount-error">${escapeHtml(validationMessage)}</p>` : `
                <p class="payment-custom-amount-consequence">Remaining after this payment: ${escapeHtml(formatCurrency(remainingAfter))}</p>
            `}
        </div>
    `;
}

function renderPaymentTypeButtons(reservation) {
    const visibleOptions = getVisibleOptions(reservation);
    const chips = visibleOptions.map((option) => `
        <button
            type="button"
            class="payment-select-chip ${state.selectedOptionKey === getPaymentOptionKey(option) ? 'active' : ''}"
            data-payment-option-key="${escapeHtml(getPaymentOptionKey(option))}"
        >
            ${option.paymentType === 'partial_payment'
                ? escapeHtml(option.displayLabel)
                : escapeHtml(`${option.displayLabel} — ${formatCurrency(option.amount)}`)}
        </button>
    `).join('');

    const selectedOption = getSelectedOption(reservation);
    return `${chips}${renderCustomAmountPanel(reservation, selectedOption)}`;
}

const COPY_ICON = `<i class="fa-regular fa-copy" aria-hidden="true"></i>`;
const INFO_ICON = `<i class="fa-solid fa-circle-info" aria-hidden="true"></i>`;

function getArrivalDateBounds(reservation) {
    const balance = getActiveBalance(reservation);
    const eventDateKey = String(reservation.event_date || '').split('T')[0];
    const maxKey = [balance.graceDeadlineKey, eventDateKey].filter(Boolean).sort()[0] || eventDateKey;
    return { min: getTodayDateKey(), max: maxKey };
}

function renderInstructionCard(reservation) {
    const methodMeta = getSelectedMethodObject();
    if (!methodMeta) return '';

    if (methodMeta.type === 'online') {
        return `
            <div class="payment-instructions-card">
                <div class="payment-howto-online">
                    ${methodMeta.qrImage ? `
                        <div class="payment-howto-qr-col">
                            <div class="payment-howto-qr-wrap">
                                <img class="payment-howto-qr" src="${escapeHtml(methodMeta.qrImage)}" alt="${escapeHtml(methodMeta.label)} QR Code" loading="lazy">
                                <p class="payment-howto-qr-label">Scan with ${escapeHtml(methodMeta.label)}</p>
                            </div>
                        </div>
                    ` : ''}
                    <div class="payment-howto-info-col">
                        <p class="payment-howto-info-heading">${methodMeta.qrImage ? 'Or send manually to:' : 'Send to:'}</p>
                        <div class="payment-howto-details">
                            ${(methodMeta.details || []).map((detail) => `
                                <div class="payment-howto-detail-row">
                                    <div class="payment-howto-detail-label">${escapeHtml(detail.label)}</div>
                                    <div class="payment-howto-detail-value">
                                        <span>${escapeHtml(detail.value)}</span>
                                        ${detail.copyable ? `<button type="button" class="payment-copy-btn" data-copy="${escapeHtml(detail.value)}" title="Copy ${escapeHtml(detail.label)}">${COPY_ICON} Copy</button>` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        <div class="payment-howto-reminder">${INFO_ICON} ${escapeHtml(methodMeta.helper || '')}</div>
                    </div>
                </div>
            </div>
        `;
    }

    const instructionText = methodMeta.helper || '';
    const { min, max } = getArrivalDateBounds(reservation);

    return `
        <div class="payment-instructions-card">
            <div class="payment-howto-onsite">
                <p class="payment-howto-onsite-title">Pay at Eli Coffee Events Café</p>
                <p class="payment-howto-onsite-note">${escapeHtml(instructionText)}</p>
                <div class="payment-howto-visit-date">
                    <label for="payment-visit-date">Planned date of arrival for payment</label>
                    <input
                        id="payment-visit-date"
                        type="date"
                        data-field="cashPaymentDate"
                        value="${escapeHtml(state.form.cashPaymentDate)}"
                        min="${escapeHtml(min)}"
                        max="${escapeHtml(max)}"
                    >
                </div>
                <div class="payment-howto-reminder">${INFO_ICON} Staff will record this payment on-site once it happens — no reference number or proof upload is needed from you.</div>
            </div>
        </div>
    `;
}

function renderFormSection(reservation) {
    const selectedOption = getSelectedOption(reservation);
    if (!selectedOption) return '';

    const selectedMethodObj = getSelectedMethodObject();
    const isOnsite = selectedMethodObj?.type === 'onsite';
    const isCustomAmount = selectedOption.paymentType === 'partial_payment';
    const displayAmount = isCustomAmount ? Number(state.form.customAmount || 0) : selectedOption.amount;
    const proofName = state.form.proofFile?.name || 'PNG, JPG up to 10MB';
    const refPattern = REFERENCE_NUMBER_PATTERNS[selectedMethodObj?.legacyModeKey];

    return `
        <section class="payment-step-section">
            <div>
                <p class="payment-step-label">Step 4</p>
                <h2 class="payment-step-heading">Payment details</h2>
            </div>
            <div class="payment-form-grid">
                ${!isOnsite ? `
                    <div class="payment-form-row">
                        <div class="payment-field-group">
                            <label for="payment-reference-number">Reference number</label>
                            <input
                                id="payment-reference-number"
                                type="text"
                                data-field="referenceNumber"
                                placeholder="${escapeHtml(refPattern?.placeholder || 'Reference number')}"
                                value="${escapeHtml(state.form.referenceNumber)}"
                            >
                            ${refPattern ? `<p class="payment-field-hint">${escapeHtml(selectedMethodObj?.label)} reference numbers are ${escapeHtml(refPattern.hint)}.</p>` : ''}
                        </div>
                        <div class="payment-field-group">
                            <label for="payment-amount">Amount paid</label>
                            <input id="payment-amount" type="text" readonly value="${escapeHtml(formatCurrency(displayAmount))}">
                        </div>
                    </div>
                    <div class="payment-field-group full">
                        <label for="payment-date-paid">Date paid</label>
                        <input id="payment-date-paid" type="date" data-field="paymentDate" value="${escapeHtml(state.form.paymentDate)}" max="${escapeHtml(getTodayDateKey())}">
                    </div>
                    <div class="payment-field-group full">
                        <label for="payment-proof-file">Proof of payment</label>
                        <label class="payment-proof-dropzone" for="payment-proof-file">
                            <input id="payment-proof-file" class="payment-proof-input" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" data-field="proofFile">
                            <div class="payment-proof-icon"><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i></div>
                            <div class="payment-proof-cta">Drop file here or <span>browse</span></div>
                            <div class="payment-proof-name">${escapeHtml(proofName)}</div>
                        </label>
                    </div>
                ` : `
                    <div class="payment-form-row">
                        <div class="payment-field-group">
                            <label for="payment-amount">Amount to pay</label>
                            <input id="payment-amount" type="text" readonly value="${escapeHtml(formatCurrency(displayAmount))}">
                        </div>
                        <div class="payment-field-group">
                            <label>Arrival date</label>
                            <input type="text" readonly value="${escapeHtml(state.form.cashPaymentDate ? formatDate(state.form.cashPaymentDate) : 'Set in Step 3')}">
                        </div>
                    </div>
                `}
                <div class="payment-field-group full">
                    <label for="payment-note">Note for admin (optional)</label>
                    <textarea id="payment-note" data-field="notes" placeholder="Any message for the organizer">${escapeHtml(state.form.notes)}</textarea>
                </div>
            </div>
            <div class="payment-submit-actions">
                <div class="payment-submit-preview">
                    <span class="payment-submit-preview-label">You are about to submit</span>
                    <span class="payment-submit-preview-value">${escapeHtml(`${selectedMethodObj?.shortLabel || selectedMethodObj?.label || 'Payment method'} · ${selectedOption.displayLabel} · ${formatCurrency(displayAmount)}`)}</span>
                </div>
                <button type="button" class="res-primary-btn" data-action="submit-payment" ${state.isSubmitting ? 'disabled' : ''}>${state.isSubmitting ? 'Submitting Payment...' : 'Submit Payment'}</button>
                <p class="payment-inline-message ${escapeHtml(state.flashType)}">${escapeHtml(state.flashMessage)}</p>
            </div>
        </section>
    `;
}

function renderActionableCard(reservation) {
    const selectedOption = getSelectedOption(reservation);
    if (!selectedOption) {
        return `
            <section class="payment-focus-card">
                <div class="payment-readonly-card">
                    <h2 class="payment-readonly-title">No payment action is available right now</h2>
                    <p class="payment-readonly-copy">This reservation does not currently have a customer payment step available.</p>
                </div>
            </section>
        `;
    }

    return `
        <section class="payment-focus-card">
            <section class="payment-step-section">
                <div>
                    <p class="payment-step-label">Step 1</p>
                    <h2 class="payment-step-heading">Choose payment method</h2>
                </div>
                <div class="payment-chip-grid">${renderPaymentMethodButtons(reservation)}</div>
            </section>

            <section class="payment-step-section">
                <div>
                    <p class="payment-step-label">Step 2</p>
                    <h2 class="payment-step-heading">Choose payment type</h2>
                </div>
                <div class="payment-chip-grid">${renderPaymentTypeButtons(reservation)}</div>
            </section>

            <section class="payment-step-section">
                <div>
                    <p class="payment-step-label">Step 3</p>
                    <h2 class="payment-step-heading">How to pay</h2>
                </div>
                ${renderInstructionCard(reservation)}
            </section>

            ${renderFormSection(reservation)}
        </section>
    `;
}

function renderPendingCard(reservation) {
    const pendingPayment = getLatestReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);
    const paymentStatus = getPaymentStatusMeta(pendingPayment?.payment_status || 'pending_review');
    const methodLabel = LEGACY_METHOD_DISPLAY_LABELS[pendingPayment?.payment_method] || pendingPayment?.payment_method || 'Payment method';

    return `
        <section class="payment-focus-card">
            <div class="payment-readonly-card">
                <span class="res-status pending"><i class="fa-solid fa-clock" aria-hidden="true"></i> ${escapeHtml(paymentStatus.label)}</span>
                <h2 class="payment-readonly-title">Payment submitted and waiting for admin review</h2>
                <p class="payment-readonly-copy">Your latest payment is already in review. Once the admin confirms it, your balance and receipt records will update here automatically.</p>
                <div class="payment-dl">
                    <div class="payment-dl-row">
                        <span>Payment type</span>
                        <strong>${escapeHtml(getPaymentLabel(pendingPayment?.payment_type))}</strong>
                    </div>
                    <div class="payment-dl-row">
                        <span>Amount</span>
                        <strong>${escapeHtml(formatCurrency(pendingPayment?.amount || 0))}</strong>
                    </div>
                    <div class="payment-dl-row">
                        <span>Method</span>
                        <strong>${escapeHtml(methodLabel)}</strong>
                    </div>
                </div>
                <p class="payment-inline-message ${escapeHtml(state.flashType)}">${escapeHtml(state.flashMessage)}</p>
            </div>
        </section>
    `;
}

function renderCompleteCard(reservation) {
    const balance = getActiveBalance(reservation);
    const latestReceiptEntry = getReservationReceipts(
        state.bundle.paymentsByReservationId,
        state.bundle.receiptsByPaymentId,
        reservation.reservation_id
    )[0] || null;

    return `
        <section class="payment-focus-card">
            <div class="payment-readonly-card">
                <span class="res-status approved"><i class="fa-solid fa-check" aria-hidden="true"></i> Paid in Full</span>
                <h2 class="payment-readonly-title">This reservation is already fully paid</h2>
                <p class="payment-readonly-copy">All required payments for this reservation have been approved and recorded. You can still review your payment history and receipts below.</p>
                <div class="payment-dl">
                    <div class="payment-dl-row">
                        <span>Total amount</span>
                        <strong>${escapeHtml(formatCurrency(balance.totalPrice))}</strong>
                    </div>
                    <div class="payment-dl-row">
                        <span>Approved payments</span>
                        <strong>${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                    </div>
                    <div class="payment-dl-row">
                        <span>Latest receipt</span>
                        <strong>${escapeHtml(latestReceiptEntry ? formatShortDate(latestReceiptEntry.receipt.issued_at) : 'No receipt')}</strong>
                    </div>
                </div>
                <p class="payment-inline-message ${escapeHtml(state.flashType)}">${escapeHtml(state.flashMessage)}</p>
            </div>
        </section>
    `;
}

function renderHistoryTab(reservation) {
    const payments = getReservationPayments(state.bundle.paymentsByReservationId, reservation.reservation_id)
        .slice()
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0));

    if (!payments.length) {
        return `
            <div class="payment-history-card">
                <p class="payment-empty-note">No payment submissions yet.</p>
            </div>
        `;
    }

    return `
        <div class="payment-history-card">
            <div class="payment-history-list">
                ${payments.map((payment) => {
                    const status = getPaymentStatusMeta(payment.payment_status);
                    const methodLabel = LEGACY_METHOD_DISPLAY_LABELS[payment.payment_method] || payment.payment_method;
                    return `
                        <div class="payment-history-item">
                            <div>
                                <div class="payment-item-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                                <div class="payment-item-meta">${escapeHtml(`${formatCurrency(payment.amount)} · ${methodLabel} · ${payment.submitted_at ? `Submitted ${formatDateTime(payment.submitted_at)}` : 'Submitted'}`)}</div>
                            </div>
                            <div class="payment-item-actions">
                                <span class="res-status ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
                                ${payment.proof_url ? `<a class="res-link-btn" href="${escapeHtml(payment.proof_url)}" target="_blank" rel="noopener noreferrer">View Proof</a>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderReceiptsTab(reservation) {
    const receipts = getReservationReceipts(
        state.bundle.paymentsByReservationId,
        state.bundle.receiptsByPaymentId,
        reservation.reservation_id
    );

    if (!receipts.length) {
        return `
            <div class="payment-receipt-card">
                <p class="payment-empty-note">No receipts yet.</p>
            </div>
        `;
    }

    return `
        <div class="payment-receipt-card">
            <div class="payment-receipt-list">
                ${receipts.map(({ payment, receipt }) => `
                    <div class="payment-receipt-item">
                        <div>
                            <div class="payment-item-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                            <div class="payment-item-meta">${escapeHtml(`${formatCurrency(payment.amount)} · Issued ${formatDateTime(receipt.issued_at)} · Receipt ${receipt.receipt_number}`)}</div>
                        </div>
                        <div class="payment-item-actions">
                            <button type="button" class="res-link-btn view-receipt-btn" data-payment-id="${escapeHtml(payment.payment_id)}">View Receipt</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function renderCurrentTab(reservation) {
    const paymentSummary = getActivePaymentSummary(reservation);
    const balance = getActiveBalance(reservation);
    const latestPayment = getLatestReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);

    if (paymentSummary.key === 'pending' && latestPayment) {
        const methodLabel = LEGACY_METHOD_DISPLAY_LABELS[latestPayment.payment_method] || latestPayment.payment_method;
        return `
            <div class="payment-current-card">
                <div class="payment-current-list">
                    <div class="payment-current-item">
                        <div>
                            <div class="payment-item-title">${escapeHtml(getPaymentLabel(latestPayment.payment_type))}</div>
                            <div class="payment-item-meta">${escapeHtml(`${formatCurrency(latestPayment.amount)} · ${methodLabel} · Submitted ${formatDateTime(latestPayment.submitted_at)}`)}</div>
                        </div>
                        <div class="payment-item-actions">
                            <span class="res-status pending"><i class="fa-solid fa-clock" aria-hidden="true"></i> Pending Review</span>
                            ${latestPayment.proof_url ? `<a class="res-link-btn" href="${escapeHtml(latestPayment.proof_url)}" target="_blank" rel="noopener noreferrer">View Proof</a>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    if (balance.remainingBalance <= 0) {
        const latestApproved = getLatestApprovedReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);
        return `
            <div class="payment-current-card">
                <h2 class="payment-current-title">Payment complete</h2>
                <p class="payment-current-copy">${escapeHtml(latestApproved ? `Your latest approved payment was ${getPaymentLabel(latestApproved.payment_type)} for ${formatCurrency(latestApproved.amount)}.` : 'All required payments are already recorded for this reservation.')}</p>
            </div>
        `;
    }

    // The active tab button already reads "Current Payment" — no need to
    // repeat the same words as a heading inside the panel.
    return `
        <div class="payment-current-card">
            <p class="payment-current-copy">${escapeHtml(balance.hasPartialPayment
                ? `No remaining balance payment submitted yet. Complete the form above by ${balance.dueDateLabel}.`
                : 'No payment submitted yet. Complete the form above to submit your initial payment.')}</p>
        </div>
    `;
}

function renderTabs(reservation) {
    return `
        <section class="payment-tabs-card">
            <div class="payment-tabs-nav" role="tablist" aria-label="Payment sections">
                <button type="button" class="payment-tab-btn ${state.activeTab === 'current' ? 'active' : ''}" data-payment-tab="current">Current Payment</button>
                <button type="button" class="payment-tab-btn ${state.activeTab === 'history' ? 'active' : ''}" data-payment-tab="history">Payment History</button>
                <button type="button" class="payment-tab-btn ${state.activeTab === 'receipts' ? 'active' : ''}" data-payment-tab="receipts">Receipts</button>
            </div>
            <div class="payment-tab-panel ${state.activeTab === 'current' ? 'active' : ''}">${renderCurrentTab(reservation)}</div>
            <div class="payment-tab-panel ${state.activeTab === 'history' ? 'active' : ''}">${renderHistoryTab(reservation)}</div>
            <div class="payment-tab-panel ${state.activeTab === 'receipts' ? 'active' : ''}">${renderReceiptsTab(reservation)}</div>
        </section>
    `;
}

function renderReservationPaymentPage() {
    const reservation = getReservation();
    if (!reservation) {
        paymentApp.innerHTML = `
            <section class="payment-screen-card">
                <p class="payment-screen-kicker">Reservation not found</p>
                <h1 class="payment-screen-title">We couldn't open that payment page</h1>
                <p class="payment-screen-copy">The reservation ID is missing, invalid, or not available for the signed-in customer.</p>
                <div class="payment-screen-actions">
                    <a class="res-primary-btn" href="${escapeHtml(buildCustomerAccountUrl('reservations'))}">Back to My Reservations</a>
                </div>
            </section>
        `;
        return;
    }

    syncSelections(reservation);

    const isCancelled = String(reservation.status || '').toLowerCase() === 'cancelled';
    const focusCard = isCancelled
        ? renderCancellationCard(reservation)
        : isCompletedPaymentOverview(
            reservation,
            state.bundle.paymentsByReservationId,
            state.bundle.reschedulesByReservationId,
            { formatDate, reservationRules: state.reservationRules }
        )
            ? renderCompleteCard(reservation)
            : isPendingPaymentOverview(
                reservation,
                state.bundle.paymentsByReservationId,
                state.bundle.reschedulesByReservationId,
                { formatDate, reservationRules: state.reservationRules }
            )
                ? renderPendingCard(reservation)
                : renderActionableCard(reservation);

    paymentApp.innerHTML = `
        ${renderSummaryStrip(reservation)}
        ${renderOverdueStrip(reservation)}
        ${focusCard}
        ${renderTabs(reservation)}
    `;
}

function openReceiptModal(paymentId) {
    const reservation = getReservation();
    const payment = getReservationPayments(state.bundle.paymentsByReservationId, reservation?.reservation_id)
        .find((entry) => String(entry.payment_id) === String(paymentId));
    const receipt = state.bundle.receiptsByPaymentId[paymentId];

    if (!reservation || !payment || !receipt || !receiptView) return;

    receiptView.innerHTML = `
        <div class="receipt-panel">
            <div class="receipt-panel-head">
                <div>
                    <div class="receipt-panel-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                    <div class="receipt-panel-sub">Receipt No. ${escapeHtml(receipt.receipt_number)}</div>
                </div>
                <span class="receipt-meta-chip">${escapeHtml(formatShortDate(receipt.issued_at))}</span>
            </div>
            <div class="receipt-panel-body">
                <div class="receipt-grid">
                    <div class="receipt-field">
                        <span class="receipt-label">Customer</span>
                        <span class="receipt-value">${escapeHtml(getCustomerDisplayName())}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Event</span>
                        <span class="receipt-value">${escapeHtml(reservation.event_type || 'Event')}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Reservation Date</span>
                        <span class="receipt-value">${escapeHtml(formatDate(reservation.event_date))}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Package</span>
                        <span class="receipt-value">${escapeHtml(getReservationPackageName(reservation))}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Payment Method</span>
                        <span class="receipt-value">${escapeHtml(LEGACY_METHOD_DISPLAY_LABELS[payment.payment_method] || payment.payment_method)}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Amount Paid</span>
                        <span class="receipt-value">${escapeHtml(formatCurrency(payment.amount))}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Reference</span>
                        <span class="receipt-value">${escapeHtml(payment.reference_number || 'Not provided')}</span>
                    </div>
                </div>
            </div>
            <div class="receipt-panel-foot">
                This acknowledges receipt of the payment recorded for this reservation. This is an acknowledgement receipt generated inside the system and is not an official sales invoice.
            </div>
        </div>
    `;

    receiptModalBackdrop?.classList.remove('hidden');
    receiptModalBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeReceiptModal() {
    receiptModalBackdrop?.classList.add('hidden');
    receiptModalBackdrop?.setAttribute('aria-hidden', 'true');
}

async function fetchCancellationInfo(reservationId) {
    try {
        const { data, error } = await supabase
            .from('reservation_cancellations')
            .select('reason, cancelled_at')
            .eq('reservation_id', reservationId)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    } catch {
        return null;
    }
}

async function loadPaymentPage() {
    try {
        const [methods, rules, paymentRules, types] = await Promise.all([
            loadPaymentMethods(supabase),
            loadReservationRules(supabase),
            loadPaymentRules(supabase),
            loadPaymentTypes(supabase)
        ]);
        state.paymentMethods = methods;
        state.reservationRules = rules;
        state.paymentRules = paymentRules;
        state.paymentTypes = types;
        if (!state.selectedMethod && methods.length) {
            state.selectedMethod = methods[0].id;
        }
        state.bundle = await loadCustomerPaymentBundle(supabase, user.id);
        state.cancellationInfo = state.reservationId ? await fetchCancellationInfo(state.reservationId) : null;
        renderReservationPaymentPage();
    } catch (error) {
        paymentApp.innerHTML = `
            <section class="payment-screen-card">
                <p class="payment-screen-kicker">Unable to load payment page</p>
                <h1 class="payment-screen-title">We couldn't load your reservation payment details</h1>
                <p class="payment-screen-copy">Something went wrong loading this page. Please try again in a moment.</p>
                <div class="payment-screen-actions">
                    <a class="res-primary-btn" href="${escapeHtml(buildCustomerAccountUrl('reservations'))}">Back to My Reservations</a>
                </div>
            </section>
        `;
    }
}

async function handleSubmitPayment() {
    const reservation = getReservation();
    const selectedOption = getSelectedOption(reservation);
    if (!reservation || !selectedOption || state.isSubmitting) return;

    if (selectedOption.paymentType === 'partial_payment') {
        const amount = Number(state.form.customAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            state.flashMessage = 'Please enter a custom payment amount.';
            state.flashType = 'error';
            renderReservationPaymentPage();
            return;
        }
    }

    const selectedMethodObj = getSelectedMethodObject();
    if (!selectedMethodObj) {
        state.flashMessage = 'Please choose a payment method.';
        state.flashType = 'error';
        renderReservationPaymentPage();
        return;
    }

    if (selectedMethodObj.type !== 'onsite' && state.form.referenceNumber
        && !validateReferenceNumber(selectedMethodObj.legacyModeKey, state.form.referenceNumber)) {
        state.flashMessage = `Please enter a valid ${selectedMethodObj.label || selectedMethodObj.legacyModeKey} reference number (${REFERENCE_NUMBER_PATTERNS[selectedMethodObj.legacyModeKey]?.hint || 'correct format'}).`;
        state.flashType = 'error';
        renderReservationPaymentPage();
        return;
    }

    state.isSubmitting = true;
    state.flashMessage = '';
    state.flashType = '';
    renderReservationPaymentPage();

    try {
        const result = await submitCustomerPayment({
            supabase,
            reservations: state.bundle.reservations,
            paymentsByReservationId: state.bundle.paymentsByReservationId,
            reschedulesByReservationId: state.bundle.reschedulesByReservationId,
            reservationId: reservation.reservation_id,
            selectedMethod: selectedMethodObj,
            paymentType: selectedOption.paymentType,
            rescheduleRequestId: selectedOption.rescheduleRequestId || null,
            customAmount: selectedOption.paymentType === 'partial_payment' ? Number(state.form.customAmount) : null,
            referenceNumber: state.form.referenceNumber.trim(),
            paymentDate: state.form.paymentDate || null,
            cashPaymentDate: state.form.cashPaymentDate || null,
            notes: state.form.notes.trim(),
            proofFile: state.form.proofFile,
            formatDate,
            reservationRules: state.reservationRules,
            paymentTypes: state.paymentTypes
        });

        state.form = {
            customAmount: '',
            referenceNumber: '',
            paymentDate: '',
            cashPaymentDate: '',
            notes: '',
            proofFile: null
        };
        state.flashMessage = result.successMessage;
        state.flashType = 'success';
        state.activeTab = 'current';
        await loadPaymentPage();
    } catch (error) {
        state.flashMessage = error?.message || 'Failed to submit payment.';
        state.flashType = 'error';
    } finally {
        state.isSubmitting = false;
        renderReservationPaymentPage();
    }
}

paymentApp?.addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
        const text = copyButton.dataset.copy || '';
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        const origInner = copyButton.innerHTML;
        copyButton.classList.add('copied');
        copyButton.innerHTML = `<i class="fa-solid fa-check" aria-hidden="true"></i> Copied!`;
        setTimeout(() => {
            if (document.body.contains(copyButton)) {
                copyButton.classList.remove('copied');
                copyButton.innerHTML = origInner;
            }
        }, 2000);
        return;
    }

    const methodButton = event.target.closest('[data-payment-method]');
    if (methodButton) {
        state.selectedMethod = methodButton.dataset.paymentMethod || '';
        renderReservationPaymentPage();
        return;
    }

    const optionButton = event.target.closest('[data-payment-option-key]');
    if (optionButton) {
        state.selectedOptionKey = optionButton.dataset.paymentOptionKey || '';
        renderReservationPaymentPage();
        return;
    }

    const tabButton = event.target.closest('[data-payment-tab]');
    if (tabButton) {
        state.activeTab = tabButton.dataset.paymentTab || 'current';
        renderReservationPaymentPage();
        return;
    }

    const receiptButton = event.target.closest('.view-receipt-btn');
    if (receiptButton) {
        openReceiptModal(receiptButton.dataset.paymentId);
        return;
    }

    const submitButton = event.target.closest('[data-action="submit-payment"]');
    if (submitButton) {
        await handleSubmitPayment();
    }
});

paymentApp?.addEventListener('input', (event) => {
    const field = event.target.dataset.field;
    if (!field || field === 'proofFile') return;

    state.form[field] = field === 'customAmount'
        ? sanitizeAmountInput(event.target.value)
        : (event.target.value || '');

    if (field === 'customAmount') {
        renderReservationPaymentPage();
        // Re-focus + restore the caret so live-typing isn't interrupted by
        // the full re-render this state model relies on everywhere else.
        // setSelectionRange throws on type="number" inputs (unsupported for
        // that type) — this only works now that the field is type="text".
        const input = document.getElementById('payment-custom-amount');
        if (input) {
            input.focus();
            const pos = input.value.length;
            input.setSelectionRange(pos, pos);
        }
    }
});

paymentApp?.addEventListener('change', (event) => {
    const field = event.target.dataset.field;
    if (field === 'proofFile') {
        state.form.proofFile = event.target.files?.[0] || null;
        renderReservationPaymentPage();
        return;
    }

    if (field) {
        state.form[field] = event.target.value || '';
    }
});

receiptModalClose?.addEventListener('click', closeReceiptModal);
receiptModalDismiss?.addEventListener('click', closeReceiptModal);
receiptModalBackdrop?.addEventListener('click', (event) => {
    if (event.target === receiptModalBackdrop) {
        closeReceiptModal();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeReceiptModal();
    }
});

await loadPaymentPage();

initAutoRefresh(() => {
    // renderReservationPaymentPage() fully rebuilds paymentApp's markup, which
    // would wipe out an in-progress reference number or a chosen-but-not-yet-
    // submitted receipt file. Skip the refresh while the customer is actively
    // interacting with the form, or while a submission is in flight; the next
    // poll/focus event will pick it up.
    const proofFileInput = document.getElementById('payment-proof-file');
    const isEditingForm = paymentApp?.contains(document.activeElement);
    const hasUnsubmittedFile = !!(proofFileInput && proofFileInput.files && proofFileInput.files.length > 0);
    if (isEditingForm || hasUnsubmittedFile || state.isSubmitting) return;

    loadPaymentPage();
});