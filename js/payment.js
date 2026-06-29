import { customerSupabase as supabase } from './supabase.js';
import {
    PAYMENT_METHODS,
    PAYMENT_METHOD_ORDER,
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
    loadDynamicPaymentMethods,
    submitCustomerPayment
} from './customer_payments.js';

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
    activeTab: 'current',
    selectedMethod: 'gcash',
    selectedOptionKey: '',
    isSubmitting: false,
    flashMessage: '',
    flashType: '',
    form: {
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
    return getReservationBalanceDetails(reservation, state.bundle.paymentsByReservationId, { formatDate });
}

function getActivePaymentOptions(reservation) {
    return getAvailablePaymentOptions(
        reservation,
        state.bundle.paymentsByReservationId,
        state.bundle.reschedulesByReservationId,
        { formatDate }
    );
}

function getPaymentOptionKey(option) {
    return `${option.paymentType}:${option.rescheduleRequestId || ''}`;
}

function getVisibleOptions(reservation) {
    const options = getActivePaymentOptions(reservation);
    if (PAYMENT_METHODS[state.selectedMethod]?.type === 'onsite') {
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

    if (PAYMENT_METHODS[state.selectedMethod]?.type === 'onsite' && !cashAllowed) {
        state.selectedMethod = 'gcash';
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

function renderSummaryStrip(reservation) {
    const { paymentSummary, balance, highlightedAmount } = getTopSummary(reservation);

    return `
        <section class="payment-hero-card">
            <div class="payment-hero-left">
                <h1 class="payment-hero-title">${escapeHtml(reservation.event_type || 'Reservation Payment')}</h1>
                <div class="payment-hero-meta">
                    ${escapeHtml(getReservationPackageName(reservation))} &bull; ${escapeHtml(formatDate(reservation.event_date))} &bull; ${escapeHtml(reservation.event_time || 'No time selected')}
                </div>
            </div>
            <div class="payment-hero-right">
                <span class="payment-status-badge ${escapeHtml(paymentSummary.key)}">${escapeHtml(paymentSummary.label)}</span>
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

function renderPaymentMethodButtons(reservation) {
    const allOptions = getActivePaymentOptions(reservation);
    const cashAllowed = allOptions.some((option) => option.paymentType === 'full_payment');

    return PAYMENT_METHOD_ORDER.map((method) => {
        const meta = PAYMENT_METHODS[method];
        const isDisabled = method === 'cash' && !cashAllowed;
        return `
            <button
                type="button"
                class="payment-select-chip ${state.selectedMethod === method ? 'active' : ''}"
                data-payment-method="${escapeHtml(method)}"
                ${isDisabled ? 'disabled' : ''}
            >
                ${escapeHtml(meta.shortLabel || meta.label)}
            </button>
        `;
    }).join('');
}

function renderPaymentTypeButtons(reservation) {
    return getVisibleOptions(reservation).map((option) => `
        <button
            type="button"
            class="payment-select-chip ${state.selectedOptionKey === getPaymentOptionKey(option) ? 'active' : ''}"
            data-payment-option-key="${escapeHtml(getPaymentOptionKey(option))}"
        >
            ${escapeHtml(`${option.displayLabel} — ${formatCurrency(option.amount)}`)}
        </button>
    `).join('');
}

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const INFO_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

function renderInstructionCard() {
    const methodMeta = PAYMENT_METHODS[state.selectedMethod];

    if (methodMeta?.type === 'online') {
        return `
            <div class="payment-instructions-card">
                <div class="payment-howto-online">
                    <div class="payment-howto-qr-col">
                        <div class="payment-howto-qr-wrap">
                            <img class="payment-howto-qr" src="${escapeHtml(methodMeta.qrImage)}" alt="${escapeHtml(methodMeta.label)} QR Code" loading="lazy">
                            <p class="payment-howto-qr-label">Scan with ${escapeHtml(methodMeta.label)}</p>
                        </div>
                    </div>
                    <div class="payment-howto-info-col">
                        <p class="payment-howto-info-heading">Or send manually to:</p>
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

    return `
        <div class="payment-instructions-card">
            <div class="payment-howto-onsite">
                <div class="payment-howto-visit-date">
                    <label for="payment-visit-date">Date of cafe visit</label>
                    <input id="payment-visit-date" type="date" data-field="cashPaymentDate" value="${escapeHtml(state.form.cashPaymentDate)}">
                </div>
                <div class="payment-howto-reminder">${INFO_ICON} ${escapeHtml(methodMeta?.helper || 'Pay in person at the cafe on your scheduled visit date. The admin will confirm your payment manually.')}</div>
            </div>
        </div>
    `;
}

function renderFormSection(reservation) {
    const selectedOption = getSelectedOption(reservation);
    if (!selectedOption) return '';

    const isOnsite = PAYMENT_METHODS[state.selectedMethod]?.type === 'onsite';
    const proofName = state.form.proofFile?.name || 'PNG, JPG up to 10MB';

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
                            <input id="payment-reference-number" type="text" data-field="referenceNumber" placeholder="e.g. 1234567890" value="${escapeHtml(state.form.referenceNumber)}">
                        </div>
                        <div class="payment-field-group">
                            <label for="payment-amount">Amount paid</label>
                            <input id="payment-amount" type="text" readonly value="${escapeHtml(formatCurrency(selectedOption.amount))}">
                        </div>
                    </div>
                    <div class="payment-field-group full">
                        <label for="payment-date-paid">Date paid</label>
                        <input id="payment-date-paid" type="date" data-field="paymentDate" value="${escapeHtml(state.form.paymentDate)}">
                    </div>
                    <div class="payment-field-group full">
                        <label for="payment-proof-file">Proof of payment</label>
                        <label class="payment-proof-dropzone" for="payment-proof-file">
                            <input id="payment-proof-file" class="payment-proof-input" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" data-field="proofFile">
                            <div class="payment-proof-icon">&#8593;</div>
                            <div class="payment-proof-cta">Drop file here or <span>browse</span></div>
                            <div class="payment-proof-name">${escapeHtml(proofName)}</div>
                        </label>
                    </div>
                ` : `
                    <div class="payment-form-row">
                        <div class="payment-field-group">
                            <label for="payment-amount">Amount to pay</label>
                            <input id="payment-amount" type="text" readonly value="${escapeHtml(formatCurrency(selectedOption.amount))}">
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
                    <span class="payment-submit-preview-value">${escapeHtml(`${PAYMENT_METHODS[state.selectedMethod]?.shortLabel || PAYMENT_METHODS[state.selectedMethod]?.label || state.selectedMethod} • ${selectedOption.displayLabel} • ${formatCurrency(selectedOption.amount)}`)}</span>
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
                ${renderInstructionCard()}
            </section>

            ${renderFormSection(reservation)}
        </section>
    `;
}

function renderPendingCard(reservation) {
    const pendingPayment = getLatestReservationPayment(state.bundle.paymentsByReservationId, reservation.reservation_id);
    const paymentStatus = getPaymentStatusMeta(pendingPayment?.payment_status || 'pending_review');
    const methodLabel = PAYMENT_METHODS[pendingPayment?.payment_method]?.shortLabel || PAYMENT_METHODS[pendingPayment?.payment_method]?.label || pendingPayment?.payment_method || 'Payment method';

    return `
        <section class="payment-focus-card">
            <div class="payment-readonly-card">
                <span class="payment-status-badge ${escapeHtml(paymentStatus.key)}">${escapeHtml(paymentStatus.label)}</span>
                <h2 class="payment-readonly-title">Payment submitted and waiting for admin review</h2>
                <p class="payment-readonly-copy">Your latest payment is already in review. Once the admin confirms it, your balance and receipt records will update here automatically.</p>
                <div class="payment-readonly-grid">
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Payment type</div>
                        <div class="payment-readonly-value small">${escapeHtml(getPaymentLabel(pendingPayment?.payment_type))}</div>
                    </div>
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Amount</div>
                        <div class="payment-readonly-value">${escapeHtml(formatCurrency(pendingPayment?.amount || 0))}</div>
                    </div>
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Method</div>
                        <div class="payment-readonly-value small">${escapeHtml(methodLabel)}</div>
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
                <span class="payment-status-badge approved">Paid in full</span>
                <h2 class="payment-readonly-title">This reservation is already fully paid</h2>
                <p class="payment-readonly-copy">All required payments for this reservation have been approved and recorded. You can still review your payment history and receipts below.</p>
                <div class="payment-readonly-grid">
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Total amount</div>
                        <div class="payment-readonly-value">${escapeHtml(formatCurrency(balance.totalPrice))}</div>
                    </div>
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Approved payments</div>
                        <div class="payment-readonly-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</div>
                    </div>
                    <div class="payment-readonly-stat">
                        <div class="payment-readonly-label">Latest receipt</div>
                        <div class="payment-readonly-value small">${escapeHtml(latestReceiptEntry ? formatShortDate(latestReceiptEntry.receipt.issued_at) : 'No receipt')}</div>
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
                    const methodLabel = PAYMENT_METHODS[payment.payment_method]?.shortLabel || PAYMENT_METHODS[payment.payment_method]?.label || payment.payment_method;
                    return `
                        <div class="payment-history-item">
                            <div>
                                <div class="payment-item-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                                <div class="payment-item-meta">${escapeHtml(`${formatCurrency(payment.amount)} • ${methodLabel} • ${payment.submitted_at ? `Submitted ${formatDateTime(payment.submitted_at)}` : 'Submitted'}`)}</div>
                            </div>
                            <div class="payment-item-actions">
                                <span class="payment-status-badge ${escapeHtml(status.key)}">${escapeHtml(status.label)}</span>
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
                            <div class="payment-item-meta">${escapeHtml(`${formatCurrency(payment.amount)} • Issued ${formatDateTime(receipt.issued_at)} • Receipt ${receipt.receipt_number}`)}</div>
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
        const methodLabel = PAYMENT_METHODS[latestPayment.payment_method]?.shortLabel || PAYMENT_METHODS[latestPayment.payment_method]?.label || latestPayment.payment_method;
        return `
            <div class="payment-current-card">
                <div class="payment-current-list">
                    <div class="payment-current-item">
                        <div>
                            <div class="payment-item-title">${escapeHtml(getPaymentLabel(latestPayment.payment_type))}</div>
                            <div class="payment-item-meta">${escapeHtml(`${formatCurrency(latestPayment.amount)} • ${methodLabel} • Submitted ${formatDateTime(latestPayment.submitted_at)}`)}</div>
                        </div>
                        <div class="payment-item-actions">
                            <span class="payment-status-badge pending">Pending Review</span>
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

    return `
        <div class="payment-current-card">
            <h2 class="payment-current-title">Current payment</h2>
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

    const focusCard = isCompletedPaymentOverview(
        reservation,
        state.bundle.paymentsByReservationId,
        state.bundle.reschedulesByReservationId,
        { formatDate }
    )
        ? renderCompleteCard(reservation)
        : isPendingPaymentOverview(
            reservation,
            state.bundle.paymentsByReservationId,
            state.bundle.reschedulesByReservationId,
            { formatDate }
        )
            ? renderPendingCard(reservation)
            : renderActionableCard(reservation);

    paymentApp.innerHTML = `
        ${renderSummaryStrip(reservation)}
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
                        <span class="receipt-value">${escapeHtml(PAYMENT_METHODS[payment.payment_method]?.label || payment.payment_method)}</span>
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

async function loadPaymentPage() {
    try {
        await loadDynamicPaymentMethods(supabase);
        state.bundle = await loadCustomerPaymentBundle(supabase, user.id);
        renderReservationPaymentPage();
    } catch (error) {
        console.error('Failed to load reservation payment page:', error);
        paymentApp.innerHTML = `
            <section class="payment-screen-card">
                <p class="payment-screen-kicker">Unable to load payment page</p>
                <h1 class="payment-screen-title">We couldn't load your reservation payment details</h1>
                <p class="payment-screen-copy">${escapeHtml(error?.message || 'Unknown error')}</p>
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
            paymentMethod: state.selectedMethod,
            paymentType: selectedOption.paymentType,
            rescheduleRequestId: selectedOption.rescheduleRequestId || null,
            referenceNumber: state.form.referenceNumber.trim(),
            paymentDate: state.form.paymentDate || null,
            cashPaymentDate: state.form.cashPaymentDate || null,
            notes: state.form.notes.trim(),
            proofFile: state.form.proofFile,
            formatDate
        });

        state.form = {
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
        copyButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
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
        state.selectedMethod = methodButton.dataset.paymentMethod || 'gcash';
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
    state.form[field] = event.target.value || '';
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
