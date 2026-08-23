import { customerSupabase as supabase } from './supabase.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    getReservationBalanceDetails,
    isReservationPaymentEnabled,
    loadPaymentRules,
    loadReservationRules
} from './customer_payments.js';
import {
    escapeHtml,
    formatCurrency,
    formatDate,
    formatDateTime,
    formatShortDate,
    getEffectiveReservationStatus,
    getReservationStatusMeta,
    getReservationStatusIcon,
    getReservationPackageName,
    getReservationAddOnName,
    getReservationLocationLabel,
    getRescheduleStatusMeta,
    computeContractMeta,
    computeCanReschedule,
    computeCanCancel,
    getCancellationBlockReason,
    getCancellationFee
} from './reservation_shared.js';
import { loadPolicyBodies, renderPolicyText } from './policy_text.js';

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.href = '/login.html';
}
const user = session.user;

const pageContainer = document.getElementById('reservation-details-page');
const reservationId = new URLSearchParams(window.location.search).get('reservation_id');

if (!reservationId) {
    window.location.href = '/account.html?section=reservations';
}

// Cancel-reservation modal — same markup, classes, and behavior as the
// modal on account.html (built into this page directly instead of
// redirecting there, since this is a separate static page with its own
// DOM and can't reach account.html's modal).
const cancelReservationBackdrop = document.getElementById('cancel-reservation-backdrop');
const cancelModalClose          = document.getElementById('cancel-modal-close');
const cancelModalDismiss        = document.getElementById('cancel-modal-dismiss');
const cancelModalConfirm        = document.getElementById('cancel-modal-confirm');
const cancelModalMessage        = document.getElementById('cancel-modal-message');
const cancelFeeAmount           = document.getElementById('cancel-fee-amount');
const cancelReasonInput         = document.getElementById('cancel-reason-input');

const submissionFeedbackBackdrop = document.getElementById('submission-feedback-backdrop');
const submissionFeedbackClose    = document.getElementById('submission-feedback-close');
const submissionFeedbackDismiss  = document.getElementById('submission-feedback-dismiss');
const submissionFeedbackEyebrow  = document.getElementById('submission-feedback-eyebrow');
const submissionFeedbackTitle    = document.getElementById('submission-feedback-title');
const submissionFeedbackCopy     = document.getElementById('submission-feedback-copy');

// Contract resubmission modal — lets the customer re-sign and re-upload
// after a manager requests resubmission, mirroring the draw/type signature
// capture already used on reservations.html.
const resubmitBackdrop      = document.getElementById('resubmit-contract-backdrop');
const resubmitClose         = document.getElementById('resubmit-contract-close');
const resubmitCancel        = document.getElementById('resubmit-contract-cancel');
const resubmitSubmit        = document.getElementById('resubmit-contract-submit');
const resubmitMessage       = document.getElementById('resubmit-contract-message');
const resubmitViewLink      = document.getElementById('resubmit-contract-view-link');
const resubmitCanvas        = document.getElementById('resubmit-signature-canvas');
const resubmitClearBtn      = document.getElementById('resubmit-signature-clear-btn');
const resubmitStatus        = document.getElementById('resubmit-signature-status');

const resubmitState = {
    pad: null,
    agreementViewMethod: '',
    agreementViewedAt: ''
};

let pageData = null;

function isReservationContractsColumnMissing(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

async function fetchContract(id) {
    const { data, error } = await supabase
        .from('reservation_contracts')
        .select('reservation_id, contract_url, verified_date, review_status, review_notes, reviewed_at, resubmitted_at')
        .eq('reservation_id', id)
        .maybeSingle();

    if (error) {
        if (
            isReservationContractsColumnMissing(error, 'review_status')
            || isReservationContractsColumnMissing(error, 'review_notes')
            || isReservationContractsColumnMissing(error, 'reviewed_at')
            || isReservationContractsColumnMissing(error, 'resubmitted_at')
        ) {
            const fallback = await supabase
                .from('reservation_contracts')
                .select('reservation_id, contract_url, verified_date')
                .eq('reservation_id', id)
                .maybeSingle();
            if (fallback.error) throw fallback.error;
            return fallback.data || null;
        }
        throw error;
    }

    return data || null;
}

// Best-effort lookups — both features are optional add-ons to older schemas,
// so a missing table/column should degrade to "no data" instead of failing
// the whole page load.
async function fetchCancellationInfo(id) {
    try {
        const { data, error } = await supabase
            .from('reservation_cancellations')
            .select('reason, cancelled_at')
            .eq('reservation_id', id)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    } catch (error) {
        return null;
    }
}

async function fetchReview(id) {
    try {
        const { data, error } = await supabase
            .from('reviews')
            .select('rating')
            .eq('reservation_id', id)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    } catch (error) {
        return null;
    }
}

async function loadPageData() {
    const { data: reservation, error: reservationError } = await supabase
        .from('reservations')
        .select(`
            reservation_id,
            reservation_number,
            user_id,
            event_type,
            event_date,
            event_time,
            guest_count,
            location_type,
            venue_location,
            package_id,
            add_on_id,
            total_price,
            special_requests,
            status,
            created_at,
            package:package_id ( package_name, package_type, duration_hours ),
            add_on:add_on_id ( package_name, package_type )
        `)
        .eq('reservation_id', reservationId)
        .eq('user_id', user.id)
        .maybeSingle();

    if (reservationError) throw reservationError;
    if (!reservation) {
        throw new Error('This reservation could not be found.');
    }

    const [contract, paymentsByReservationId, reschedulesByReservationId, cancellationInfo, review, reservationRules, paymentRules, policyBodies] = await Promise.all([
        fetchContract(reservationId),
        fetchSharedPayments(supabase, [reservationId]),
        fetchSharedRescheduleRequests(supabase, [reservationId]),
        fetchCancellationInfo(reservationId),
        fetchReview(reservationId),
        loadReservationRules(supabase),
        loadPaymentRules(supabase).catch(() => null),
        loadPolicyBodies(supabase, ['cancellation_policy']).catch(() => ({}))
    ]);

    pageData = {
        reservation,
        contract,
        payments: paymentsByReservationId[reservationId] || [],
        rescheduleRequests: reschedulesByReservationId[reservationId] || [],
        paymentsByReservationId,
        cancellationInfo,
        review,
        reservationRules,
        paymentRules,
        policyBodies
    };
}

function getLatestApprovedPaymentDate(payments) {
    const approved = (payments || [])
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .sort((a, b) => new Date(b.verified_at || b.submitted_at || 0) - new Date(a.verified_at || a.submitted_at || 0));
    return approved[0]?.verified_at || approved[0]?.submitted_at || null;
}

function getCancellationFeePayment(payments) {
    return (payments || []).find((payment) => payment.payment_type === 'cancellation_fee') || null;
}

// True only while the reservation is sitting in cancellation_approved with
// no cancellation_fee payment yet submitted, or with one that was rejected
// (needs resubmission). Once a cancellation_fee payment is pending_review
// or approved, this goes false — matches the same "hasPendingCancellationFee"
// gating customer_payments.js's getAvailablePaymentOptions() already uses
// to decide whether to offer the fee as a payment option.
function isCancellationFeeOwed(reservation, payments) {
    if (String(reservation?.status || '').toLowerCase() !== 'cancellation_approved') return false;
    const feePayment = getCancellationFeePayment(payments);
    const feeStatus = String(feePayment?.payment_status || '').toLowerCase();
    return !feePayment || feeStatus === 'rejected';
}

// Four-step stepper: Submitted -> Verification -> Payment -> Confirmed.
// Completed steps show a timestamp sublabel; the active step sets an
// expectation ("In review — 1 to 2 days") instead of a dead-end word like
// "Locked"; future steps carry no sublabel at all.
function buildStepperSteps(reservation, contractMeta, balance, payments) {
    const verificationDone = isReservationPaymentEnabled(reservation);
    const paymentDone = balance.remainingBalance <= 0;
    const latestApprovedPaymentDate = getLatestApprovedPaymentDate(payments);

    return [
        {
            key: 'submitted',
            label: 'Submitted',
            state: 'done',
            sub: formatDateTime(reservation.created_at)
        },
        {
            key: 'verification',
            label: 'Verification',
            state: verificationDone ? 'done' : 'current',
            sub: verificationDone
                ? (contractMeta.reviewedAt || 'Verified')
                : 'In review — 1 to 2 days'
        },
        {
            key: 'payment',
            label: 'Payment',
            state: !verificationDone ? 'upcoming' : (paymentDone ? 'done' : 'current'),
            sub: !verificationDone
                ? ''
                : (paymentDone ? (latestApprovedPaymentDate ? formatDateTime(latestApprovedPaymentDate) : 'Paid in full') : `Balance due by ${balance.dueDateLabel}`)
        },
        {
            key: 'confirmed',
            label: 'Confirmed',
            state: paymentDone ? 'done' : 'upcoming',
            sub: paymentDone ? 'Booking confirmed' : ''
        }
    ];
}

// Each step column renders as [left-half connector][dot][right-half
// connector], both halves flex:1, so every dot lands at the exact center of
// its (equal-width) column and consecutive gaps are always identical — no
// more asymmetric centering between the last column and the rest.
//
// A connector half's color reflects the completion state of the EDGE it's
// part of, not either endpoint alone: the edge between step i and step i+1
// is green once step i itself is 'done', otherwise pale tan. Both halves of
// a given edge (step i's right half + step i+1's left half) always get the
// same class, so they read as one continuous line split only for layout.
// The outer edges (before the first step, after the last) render with no
// modifier class at all, so they stay transparent — no dangling line.
function connectorClass(step) {
    if (!step) return '';
    return step.state === 'done' ? 'is-done' : 'is-upcoming';
}

function buildStepperMarkup(steps) {
    return `
        <ol class="rd-stepper">
            ${steps.map((step, index) => `
                <li class="rd-step ${escapeHtml(step.state)}">
                    <span class="rd-step-track">
                        <span class="rd-step-connector ${connectorClass(steps[index - 1])}" aria-hidden="true"></span>
                        <span class="rd-step-dot" aria-hidden="true">${step.state === 'done' ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                        <span class="rd-step-connector ${connectorClass(index < steps.length - 1 ? step : null)}" aria-hidden="true"></span>
                    </span>
                    <span class="rd-step-text">
                        <span class="rd-step-label">${escapeHtml(step.label)}</span>
                        ${step.sub ? `<span class="rd-step-sub">${escapeHtml(step.sub)}</span>` : ''}
                    </span>
                </li>
            `).join('')}
        </ol>
    `;
}

function buildCancellationNotice(reservation, effectiveStatus, cancellationInfo, cancellationFeePayment) {
    const isDeclined = effectiveStatus === 'declined';
    const title = isDeclined ? 'Reservation declined' : 'Reservation cancelled';

    return `
        <div class="rd-cancel-notice">
            <div class="rd-cancel-notice-head">
                <i class="fa-solid fa-circle-xmark" aria-hidden="true"></i>
                <strong>${escapeHtml(title)}</strong>
            </div>
            ${cancellationInfo?.reason ? `
                <p class="rd-cancel-notice-line"><span>Reason</span>${escapeHtml(cancellationInfo.reason)}</p>
            ` : ''}
            ${cancellationFeePayment ? `
                <p class="rd-cancel-notice-line"><span>Cancellation fee</span>${escapeHtml(formatCurrency(cancellationFeePayment.amount))} &middot; ${escapeHtml(getPaymentStatusLabel(cancellationFeePayment.payment_status))}</p>
            ` : ''}
        </div>
    `;
}

function getPaymentStatusLabel(status) {
    const key = String(status || '').toLowerCase();
    if (key === 'approved') return 'Paid';
    if (key === 'pending_review') return 'Pending review';
    if (key === 'rejected') return 'Rejected';
    return 'Pending';
}

// The single-sentence "what do I do?" strip under the stepper. Content is
// driven entirely by reservation/contract/balance state so it always
// answers the customer's next action (or tells them none is needed).
function getNoteStripCopy(reservation, effectiveStatus, contractMeta, balance) {
    const verificationDone = isReservationPaymentEnabled(reservation);
    const paymentDone = balance.remainingBalance <= 0;

    if (effectiveStatus === 'completed') {
        return {
            tone: 'neutral',
            icon: 'circle-check',
            body: 'This event is complete. You can still view your signed contract and payment records below.'
        };
    }

    if (!verificationDone) {
        return {
            tone: 'amber',
            icon: 'circle-info',
            body: "Your contract is being verified by our team. Payment unlocks once it's approved — no action needed from you right now."
        };
    }

    if (paymentDone) {
        return {
            tone: 'green',
            icon: 'circle-check',
            body: `Your reservation is fully paid and confirmed for ${formatShortDate(reservation.event_date)}.`
        };
    }

    return {
        tone: 'amber',
        icon: 'circle-info',
        body: balance.helperText || 'Your contract is verified. Complete your payment to confirm this booking.'
    };
}

function contractBadgeClass(contractMeta) {
    if (contractMeta.statusKey === 'verified') return 'approved';
    if (contractMeta.statusKey === 'missing') return 'completed';
    if (contractMeta.statusKey === 'resubmission_requested') return 'resubmission_requested';
    return 'pending';
}

function buildEventDetailsPanel(reservation) {
    const addOnName = getReservationAddOnName(reservation);
    const specialRequests = String(reservation.special_requests || '').trim();
    const hasOptionalContent = Boolean(addOnName) || Boolean(specialRequests);

    return `
        <section class="rd-panel">
            <h2 class="rd-panel-title">Event details</h2>
            <dl class="rd-dl">
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-calendar" aria-hidden="true"></i> Date</dt>
                    <dd>${escapeHtml(formatDate(reservation.event_date))}</dd>
                </div>
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-clock" aria-hidden="true"></i> Start time</dt>
                    <dd>${escapeHtml(reservation.event_time || 'No time selected')}</dd>
                </div>
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-users" aria-hidden="true"></i> Guests</dt>
                    <dd>${escapeHtml(String(reservation.guest_count || 0))} guests</dd>
                </div>
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-location-dot" aria-hidden="true"></i> Location</dt>
                    <dd>${escapeHtml(getReservationLocationLabel(reservation))}</dd>
                </div>
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-box" aria-hidden="true"></i> Package</dt>
                    <dd>${escapeHtml(getReservationPackageName(reservation))}</dd>
                </div>
                ${addOnName ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-gift" aria-hidden="true"></i> Add-on</dt>
                        <dd>${escapeHtml(addOnName)}</dd>
                    </div>
                ` : ''}
                ${specialRequests ? `
                    <div class="rd-dl-row rd-dl-row-wrap">
                        <dt><i class="fa-solid fa-note-sticky" aria-hidden="true"></i> Special requests</dt>
                        <dd>${escapeHtml(specialRequests)}</dd>
                    </div>
                ` : ''}
            </dl>
            ${!hasOptionalContent ? `
                <p class="rd-footnote">No add-ons or special requests for this booking.</p>
            ` : ''}
        </section>
    `;
}

function buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl, cancellationFeeOwed = false, paymentRules = null) {
    // balance.remainingBalance only tracks the base package price — it goes
    // to 0 the moment the package itself is paid off, regardless of whether
    // a *cancellation* fee is now separately owed on top of that. Without
    // the cancellationFeeOwed check, a fully-paid reservation that later
    // moves to cancellation_approved reads as paymentDone forever and the
    // CTA below never renders, even though the customer still owes money.
    const baseBalancePaid = balance.remainingBalance <= 0;
    const paymentDone = baseBalancePaid && !cancellationFeeOwed;
    const verificationDone = isReservationPaymentEnabled(reservation);
    const hideActions = ['cancelled', 'declined', 'completed'].includes(effectiveStatus);
    const showPaymentCta = !hideActions && !paymentDone;
    const locked = !verificationDone;

    return `
        <section class="rd-panel">
            <h2 class="rd-panel-title">Payment &amp; contract</h2>

            <div class="rd-receipt-lines">
                <div class="rd-receipt-row">
                    <span>Package total</span>
                    <span>${escapeHtml(formatCurrency(balance.totalPrice))}</span>
                </div>
                <div class="rd-receipt-row">
                    <span>Paid &amp; approved</span>
                    <span>${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</span>
                </div>
                <div class="rd-receipt-row rd-receipt-total">
                    <span>${baseBalancePaid ? 'Paid in full' : `Balance due by ${escapeHtml(balance.dueDateLabel)}`}</span>
                    <span>${escapeHtml(baseBalancePaid ? formatCurrency(0) : formatCurrency(balance.remainingBalance))}</span>
                </div>
                ${cancellationFeeOwed ? `
                    <div class="rd-receipt-row rd-receipt-total rd-receipt-fee-due">
                        <span>Cancellation fee due</span>
                        <span>${escapeHtml(formatCurrency(getCancellationFee(reservation, paymentRules)))}</span>
                    </div>
                ` : ''}
            </div>

            <div class="rd-contract-inset">
                <div class="rd-contract-inset-head">
                    <i class="fa-solid fa-file-lines" aria-hidden="true"></i>
                    <span class="rd-contract-inset-title">Signed contract</span>
                    <span class="res-status ${escapeHtml(contractBadgeClass(contractMeta))}">${escapeHtml(contractMeta.label)}</span>
                </div>
                ${contract?.contract_url ? `
                    <a class="rd-btn-outline" href="${escapeHtml(contract.contract_url)}" target="_blank" rel="noopener noreferrer">
                        <i class="fa-solid fa-eye" aria-hidden="true"></i> View contract
                    </a>
                ` : `
                    <p class="rd-inline-note">Your signed contract will appear here once submitted.</p>
                `}
                ${contractMeta.statusKey === 'resubmission_requested' ? `
                    <div class="rd-contract-resubmission-note">
                        <p class="rd-inline-note rd-inline-note-warning">
                            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                            ${escapeHtml(contractMeta.note || 'Please re-upload a corrected, signed contract.')}
                        </p>
                    </div>
                    <button
                        type="button"
                        class="rd-btn-outline rd-btn-resubmit"
                        id="rd-resubmit-contract-btn"
                        data-reservation-id="${escapeHtml(reservation.reservation_id)}"
                    >
                        <i class="fa-solid fa-pen" aria-hidden="true"></i> Re-upload contract
                    </button>
                ` : ''}
            </div>

            ${showPaymentCta ? `
                <button
                    type="button"
                    class="rd-pay-cta ${locked ? 'locked' : 'primary'}"
                    ${locked ? 'disabled aria-describedby="rd-pay-caption"' : ''}
                    data-payment-url="${escapeHtml(paymentUrl)}"
                >
                    ${locked ? '<i class="fa-solid fa-lock" aria-hidden="true"></i>' : ''} ${cancellationFeeOwed ? 'Pay cancellation fee' : 'Continue payment'}
                </button>
                ${locked ? `<p class="rd-pay-caption" id="rd-pay-caption">Unlocks after your contract is verified</p>` : ''}
            ` : ''}
        </section>
    `;
}

function buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus, cancelBlockReason = null) {
    if (['cancelled', 'declined', 'completed'].includes(effectiveStatus)) return '';

    const latestRequest = rescheduleRequests[0] || null;
    const openRescheduleUrl = `/account.html?section=reservations&open=reschedule&reservation_id=${encodeURIComponent(reservation.reservation_id)}`;

    // A block reason is only ever shown for the time-based rules (min notice
    // / request window) — computeCanCancel already returns false for other
    // reasons (wrong status, open fee) without a matching reason string, so
    // cancelMarkup naturally renders nothing in those cases, same as before.
    const cancelMarkup = canCancel
        ? `<button type="button" class="rd-cancel-link" data-action="open-cancel">Cancel reservation</button>`
        : (cancelBlockReason
            ? `<span class="rd-cancel-blocked" title="${escapeHtml(cancelBlockReason)}">${escapeHtml(cancelBlockReason)}</span>`
            : '');

    if (!latestRequest && !canReschedule && !canCancel && !cancelBlockReason) return '';

    if (!latestRequest) {
        return `
            <div class="rd-reschedule-row">
                <div class="rd-reschedule-row-left">
                    <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
                    <span>Need to change your event date?</span>
                </div>
                <div class="rd-reschedule-row-actions">
                    ${canReschedule ? `<a class="rd-btn-outline" href="${escapeHtml(openRescheduleUrl)}">Request reschedule</a>` : ''}
                    ${cancelMarkup}
                </div>
            </div>
        `;
    }

    const statusMeta = getRescheduleStatusMeta(latestRequest.status);

    return `
        <section class="rd-panel rd-reschedule-card">
            <div class="rd-reschedule-card-head">
                <h2 class="rd-panel-title">Reschedule request</h2>
                <span class="res-status ${escapeHtml(statusMeta.key)}">${escapeHtml(statusMeta.label)}</span>
            </div>
            <dl class="rd-dl">
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-calendar-days" aria-hidden="true"></i> Requested date</dt>
                    <dd>${escapeHtml(formatDate(latestRequest.requested_date))} at ${escapeHtml(latestRequest.requested_time || 'No time selected')}</dd>
                </div>
                ${latestRequest.reviewed_at ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-clock" aria-hidden="true"></i> Admin response</dt>
                        <dd>Reviewed ${escapeHtml(formatShortDate(latestRequest.reviewed_at))}</dd>
                    </div>
                ` : ''}
            </dl>
            ${(canReschedule || canCancel || cancelBlockReason) ? `
                <div class="rd-reschedule-row-actions">
                    ${canReschedule ? `<a class="rd-btn-outline" href="${escapeHtml(openRescheduleUrl)}">Request reschedule</a>` : ''}
                    ${cancelMarkup}
                </div>
            ` : ''}
        </section>
    `;
}

function buildReviewRow(effectiveStatus, review) {
    if (effectiveStatus !== 'completed') return '';

    if (review) {
        return `
            <div class="rd-reschedule-row">
                <div class="rd-reschedule-row-left">
                    <i class="fa-solid fa-star" aria-hidden="true"></i>
                    <span>You reviewed this event (${escapeHtml(String(review.rating || 0))}/5).</span>
                </div>
            </div>
        `;
    }

    const openReviewUrl = `/account.html?section=reservations&open=review&reservation_id=${encodeURIComponent(reservationId)}`;
    return `
        <div class="rd-reschedule-row">
            <div class="rd-reschedule-row-left">
                <i class="fa-solid fa-star" aria-hidden="true"></i>
                <span>How was your event?</span>
            </div>
            <div class="rd-reschedule-row-actions">
                <a class="rd-btn-outline" href="${escapeHtml(openReviewUrl)}">Leave a review</a>
            </div>
        </div>
    `;
}

function render() {
    const { reservation, contract, payments, rescheduleRequests, paymentsByReservationId, cancellationInfo, review, reservationRules, paymentRules } = pageData;
    const effectiveStatus = getEffectiveReservationStatus(reservation);
    const reservationStatus = getReservationStatusMeta(effectiveStatus);
    const statusIcon = getReservationStatusIcon(effectiveStatus);
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, { formatDate, reservationRules });
    const contractMeta = computeContractMeta(contract);
    const canReschedule = computeCanReschedule(reservation.status, rescheduleRequests);
    const canCancel = computeCanCancel(reservation.status, payments, reservation, paymentRules);
    const cancelBlockReason = getCancellationBlockReason(reservation, paymentRules);
    const isTerminalCancelled = ['cancelled', 'declined'].includes(effectiveStatus);
    const paymentUrl = buildCustomerPaymentUrl(reservationId);
    const cancellationFeeOwed = isCancellationFeeOwed(reservation, payments);

    const showBalanceSummary = !isTerminalCancelled;
    const paymentDone = balance.remainingBalance <= 0 && !cancellationFeeOwed;

    pageContainer.innerHTML = `
        <section class="rd-header-card">
            <div class="rd-header-row">
                <div class="rd-header-left">
                    <div class="rd-title-row">
                        <h1 class="rd-event-title">${escapeHtml(reservation.event_type || 'Event')}</h1>
                        <span class="res-status ${escapeHtml(reservationStatus.key)}"><i class="fa-solid fa-${escapeHtml(statusIcon)}" aria-hidden="true"></i> ${escapeHtml(reservationStatus.label)}</span>
                    </div>
                    <p class="rd-subline">${[reservation.reservation_number, getReservationPackageName(reservation)].filter(Boolean).map(escapeHtml).join(' &middot; ')}</p>
                </div>
                ${showBalanceSummary ? `
                    <div class="rd-header-right">
                        <span class="rd-balance-label">${cancellationFeeOwed ? 'Cancellation fee due' : (paymentDone ? 'Paid in full' : 'Balance due')}</span>
                        <div class="rd-balance-amount-row">
                            <strong class="rd-balance-amount">${escapeHtml(
                                cancellationFeeOwed
                                    ? formatCurrency(getCancellationFee(reservation, paymentRules))
                                    : (paymentDone ? formatCurrency(balance.totalPrice) : formatCurrency(balance.remainingBalance))
                            )}</strong>
                            ${(!paymentDone && !cancellationFeeOwed) ? `<span class="rd-balance-due-date">by ${escapeHtml(formatShortDate(balance.dueDateKey))}</span>` : ''}
                        </div>
                    </div>
                ` : ''}
            </div>

            ${isTerminalCancelled
                ? buildCancellationNotice(reservation, effectiveStatus, cancellationInfo, getCancellationFeePayment(payments))
                : buildStepperMarkup(buildStepperSteps(reservation, contractMeta, balance, payments))
            }

            ${!isTerminalCancelled ? (() => {
                const note = getNoteStripCopy(reservation, effectiveStatus, contractMeta, balance);
                return `
                    <div class="rd-note-strip tone-${escapeHtml(note.tone)}">
                        <i class="fa-solid fa-${escapeHtml(note.icon)}" aria-hidden="true"></i>
                        <p>${escapeHtml(note.body)}</p>
                    </div>
                `;
            })() : ''}
        </section>

        <div class="rd-grid">
            ${buildEventDetailsPanel(reservation)}
            ${buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl, cancellationFeeOwed, paymentRules)}
        </div>

        ${buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus, cancelBlockReason)}
        ${buildReviewRow(effectiveStatus, review)}
    `;
}

function setCancelModalMessage(message, isError = false) {
    if (!cancelModalMessage) return;
    cancelModalMessage.textContent = message || '';
    cancelModalMessage.className = 'account-modal-message' + (isError ? ' error' : '');
}

function closeCancelModal() {
    cancelReservationBackdrop?.classList.add('hidden');
    cancelReservationBackdrop?.setAttribute('aria-hidden', 'true');
    if (cancelModalConfirm) cancelModalConfirm.removeAttribute('disabled');
    setCancelModalMessage('');
}

// Swaps the hardcoded fallback copy inside the policy block for the
// admin-saved override, if one exists — same "override only when present"
// contract as the cancel modal on account.html. Leaves the fallback markup
// untouched when there's nothing saved yet, or the fetch failed.
function applyPolicyOverride(elId, settingKey) {
    const el = document.getElementById(elId);
    const body = pageData?.policyBodies?.[settingKey];
    if (el && body) el.innerHTML = renderPolicyText(body);
}

function openCancelModal() {
    if (!pageData?.reservation) return;
    const fee = getCancellationFee(pageData.reservation, pageData.paymentRules);
    if (cancelFeeAmount) cancelFeeAmount.textContent = `₱${fee.toLocaleString()}`;
    if (cancelReasonInput) cancelReasonInput.value = '';
    applyPolicyOverride('cancel-policy-body', 'cancellation_policy');
    setCancelModalMessage('');
    cancelReservationBackdrop?.classList.remove('hidden');
    cancelReservationBackdrop?.setAttribute('aria-hidden', 'false');
}

function openSubmissionFeedbackModal({
    eyebrow = 'Submitted',
    title = 'Submission Received',
    copy = 'Your submission has been received.'
} = {}) {
    if (submissionFeedbackEyebrow) submissionFeedbackEyebrow.textContent = eyebrow;
    if (submissionFeedbackTitle) submissionFeedbackTitle.textContent = title;
    if (submissionFeedbackCopy) submissionFeedbackCopy.textContent = copy;
    submissionFeedbackBackdrop?.classList.remove('hidden');
    submissionFeedbackBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeSubmissionFeedbackModal() {
    submissionFeedbackBackdrop?.classList.add('hidden');
    submissionFeedbackBackdrop?.setAttribute('aria-hidden', 'true');
}

async function submitCancellationRequest() {
    if (!pageData?.reservation) return;
    const reservation = pageData.reservation;

    const reason = cancelReasonInput?.value.trim() || '';
    if (!reason) {
        setCancelModalMessage('Please tell us why you\'re cancelling this reservation.', true);
        return;
    }

    if (cancelModalConfirm) cancelModalConfirm.setAttribute('disabled', 'true');
    setCancelModalMessage('Submitting your cancellation request...');

    try {
        // Same two-gate flow as account.js's cancel modal: this only files
        // the request. js/admin_reservation_details.js creates the
        // cancellation_fee payment row and flips the status to
        // 'cancellation_approved' once a manager approves it.
        const previousStatus = reservation.status;

        const { error: statusError } = await supabase
            .from('reservations')
            .update({ status: 'cancellation_requested', cancellation_reason: reason })
            .eq('reservation_id', reservationId);

        if (statusError) throw statusError;

        const { error: historyError } = await supabase
            .from('reservation_status')
            .insert({
                reservation_id: reservationId,
                previous_status: previousStatus,
                new_status: 'cancellation_requested',
                changed_at: new Date().toISOString()
            });

        if (historyError) throw historyError;

        closeCancelModal();
        await loadPageData();
        render();
        openSubmissionFeedbackModal({
            eyebrow: 'Request Submitted',
            title: 'Cancellation Request Sent',
            copy: 'Our team will review your request. You\'ll be notified once a decision is made, and if approved, you\'ll be asked to pay the cancellation fee to finalize it.'
        });
    } catch (error) {
        if (cancelModalConfirm) cancelModalConfirm.removeAttribute('disabled');
        setCancelModalMessage(`Failed to submit cancellation: ${error.message}`, true);
    }
}

function setResubmitMessage(message = '', isError = false) {
    if (!resubmitMessage) return;
    resubmitMessage.textContent = message;
    resubmitMessage.classList.toggle('error', isError);
}

function setResubmitStatus(message = '', isError = false) {
    if (!resubmitStatus) return;
    resubmitStatus.textContent = message;
    resubmitStatus.classList.toggle('error', isError);
}

function resizeResubmitCanvas() {
    if (!resubmitCanvas) return;
    const data = resubmitState.pad && !resubmitState.pad.isEmpty() ? resubmitState.pad.toData() : null;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    resubmitCanvas.width = resubmitCanvas.offsetWidth * ratio;
    resubmitCanvas.height = resubmitCanvas.offsetHeight * ratio;
    resubmitCanvas.getContext('2d').scale(ratio, ratio);
    if (resubmitState.pad) {
        resubmitState.pad.clear();
        if (data) resubmitState.pad.fromData(data);
    }
}

function initResubmitSignaturePad() {
    if (!resubmitCanvas || resubmitState.pad || typeof SignaturePad === 'undefined') return;
    resubmitState.pad = new SignaturePad(resubmitCanvas, { penColor: '#2A1408', backgroundColor: '#ffffff' });
}

async function getResubmitSignatureDataUrl() {
    if (!resubmitState.pad || resubmitState.pad.isEmpty()) return null;
    return resubmitState.pad.toDataURL('image/png');
}

function openResubmitModal() {
    const { reservation, contract } = pageData || {};
    if (!reservation) return;

    resubmitState.agreementViewMethod = '';
    resubmitState.agreementViewedAt = '';
    setResubmitMessage('');
    setResubmitStatus('');

    if (contract?.contract_url && resubmitViewLink) {
        resubmitViewLink.href = contract.contract_url;
    }

    initResubmitSignaturePad();
    resizeResubmitCanvas();
    if (resubmitState.pad) resubmitState.pad.clear();

    resubmitBackdrop?.classList.remove('hidden');
    resubmitBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeResubmitModal() {
    resubmitBackdrop?.classList.add('hidden');
    resubmitBackdrop?.setAttribute('aria-hidden', 'true');
}

async function submitResubmission() {
    const { reservation } = pageData || {};
    if (!reservation) return;

    const signerName = (reservation.contact_name || '').trim();
    if (!signerName) {
        setResubmitMessage('We could not determine your name from this reservation. Please contact the venue.', true);
        return;
    }

    // Viewing the current contract at least once satisfies the same
    // agreement-acknowledgement requirement the initial signing flow
    // enforces server-side (agreement_view_method / agreement_viewed_at).
    if (!resubmitState.agreementViewMethod) {
        resubmitState.agreementViewMethod = 'opened_full_view';
        resubmitState.agreementViewedAt = new Date().toISOString();
    }

    const signatureDataUrl = await getResubmitSignatureDataUrl();
    if (!signatureDataUrl) {
        setResubmitStatus('Please sign to continue.', true);
        return;
    }

    resubmitSubmit.disabled = true;
    setResubmitMessage('Submitting your signed contract...');

    try {
        const { data: result, error } = await supabase.functions.invoke('generate-signed-contract', {
            body: {
                reservation_id: reservation.reservation_id,
                signature_data_url: signatureDataUrl,
                signer_name: signerName,
                signature_type: 'drawn',
                agreement_view_method: resubmitState.agreementViewMethod,
                agreement_viewed_at: resubmitState.agreementViewedAt
            }
        });

        if (error || !result?.success) {
            throw new Error(result?.error || 'We could not submit your signed contract. Please try again.');
        }

        closeResubmitModal();
        await loadPageData();
        render();
        openSubmissionFeedbackModal({
            eyebrow: 'Contract Submitted',
            title: 'Signed Contract Received',
            copy: 'Your corrected contract has been submitted and is being reviewed.'
        });
    } catch (error) {
        setResubmitMessage(error.message, true);
    } finally {
        resubmitSubmit.disabled = false;
    }
}

async function init() {
    try {
        await loadPageData();
        render();
    } catch (error) {
        pageContainer.innerHTML = `<p style="color:#c0392b;text-align:center;padding:40px 0;">We couldn't load this reservation. Please try again.</p>`;
    }
}

pageContainer?.addEventListener('click', async (event) => {
    const payBtn = event.target.closest('.rd-pay-cta');
    if (payBtn && !payBtn.disabled) {
        const url = payBtn.dataset.paymentUrl;
        if (url) window.location.href = url;
        return;
    }

    const cancelTriggerBtn = event.target.closest('[data-action="open-cancel"]');
    if (cancelTriggerBtn) {
        openCancelModal();
    }

    const resubmitTriggerBtn = event.target.closest('#rd-resubmit-contract-btn');
    if (resubmitTriggerBtn) {
        openResubmitModal();
    }
});

cancelModalClose?.addEventListener('click', closeCancelModal);
cancelModalDismiss?.addEventListener('click', closeCancelModal);
cancelModalConfirm?.addEventListener('click', submitCancellationRequest);
cancelReservationBackdrop?.addEventListener('click', (event) => {
    if (event.target === cancelReservationBackdrop) closeCancelModal();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !cancelReservationBackdrop?.classList.contains('hidden')) closeCancelModal();
});

submissionFeedbackClose?.addEventListener('click', closeSubmissionFeedbackModal);
submissionFeedbackDismiss?.addEventListener('click', closeSubmissionFeedbackModal);
submissionFeedbackBackdrop?.addEventListener('click', (event) => {
    if (event.target === submissionFeedbackBackdrop) closeSubmissionFeedbackModal();
});

pageContainer?.addEventListener('change', (event) => {
    const fileInput = event.target.closest('[data-field="replacement_contract"]');
    if (!fileInput) return;
    const filenameEl = pageContainer.querySelector('[data-contract-filename]');
    const file = fileInput.files?.[0];
    if (filenameEl) {
        filenameEl.textContent = file?.name || 'No file chosen';
    }
});

resubmitClose?.addEventListener('click', closeResubmitModal);
resubmitCancel?.addEventListener('click', closeResubmitModal);
resubmitSubmit?.addEventListener('click', submitResubmission);
resubmitBackdrop?.addEventListener('click', (event) => {
    if (event.target === resubmitBackdrop) closeResubmitModal();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !resubmitBackdrop?.classList.contains('hidden')) closeResubmitModal();
});

resubmitClearBtn?.addEventListener('click', () => {
    resubmitState.pad?.clear();
    setResubmitStatus('');
});
resubmitViewLink?.addEventListener('click', () => {
    resubmitState.agreementViewMethod = 'opened_full_view';
    resubmitState.agreementViewedAt = new Date().toISOString();
});
window.addEventListener('resize', () => {
    if (!resubmitBackdrop?.classList.contains('hidden')) resizeResubmitCanvas();
});

init();

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        window.location.href = '/login.html';
    }
});