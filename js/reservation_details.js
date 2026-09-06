import { customerSupabase as supabase } from './supabase.js';
import { showFeedbackModal, showConfirmModal } from './feedback_modal.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    fetchExtensions as fetchSharedExtensions,
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
    getExtensionStatusMeta,
    computeContractMeta,
    computeCanReschedule,
    computeCanCancel,
    computeCanRequestExtension,
    getOpenExtension,
    getCancellationBlockReason,
    getRescheduleBlockReason,
    getCancellationFee,
    getRescheduleFee,
    getCancellationFeePayment,
    isCancellationFeeOwed,
    isRescheduleFeeOwed,
    isExtensionFeeOwed
} from './reservation_shared.js';
import { fetchMaxExtensionHours, requestExtension } from './reservation_extensions.js';
import { loadPolicyBodies, renderPolicyText } from './policy_text.js';
import { initAutoRefresh } from './auto_refresh.js';

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

const extensionRequestBackdrop = document.getElementById('extension-request-backdrop');
const extensionModalClose      = document.getElementById('extension-modal-close');
const extensionModalDismiss    = document.getElementById('extension-modal-dismiss');
const extensionModalConfirm    = document.getElementById('extension-modal-confirm');
const extensionModalBody       = document.getElementById('extension-modal-body');
const extensionModalMessage    = document.getElementById('extension-modal-message');

const submissionFeedbackBackdrop = document.getElementById('submission-feedback-backdrop');
const submissionFeedbackClose    = document.getElementById('submission-feedback-close');
const submissionFeedbackDismiss  = document.getElementById('submission-feedback-dismiss');
const submissionFeedbackEyebrow  = document.getElementById('submission-feedback-eyebrow');
const submissionFeedbackTitle    = document.getElementById('submission-feedback-title');
const submissionFeedbackCopy     = document.getElementById('submission-feedback-copy');

let pageData = null;

// reservation.event_end_time comes back from Postgres as a raw "HH:MM:SS"
// time value (unlike event_time, which is already stored pre-formatted as
// "3:00 PM") — this is the one place that needs converting for display.
function formatTimeOfDay(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return '';
    let hours = Number(match[1]);
    const minutes = match[2];
    const meridiem = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${meridiem}`;
}

function isReservationContractsColumnMissing(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

async function fetchContract(id) {
    const { data, error } = await supabase
        .from('reservation_contracts')
        .select('reservation_id, contract_url, verified_date, review_status, review_notes, reviewed_at')
        .eq('reservation_id', id)
        .maybeSingle();

    if (error) {
        if (
            isReservationContractsColumnMissing(error, 'review_status')
            || isReservationContractsColumnMissing(error, 'review_notes')
            || isReservationContractsColumnMissing(error, 'reviewed_at')
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
            contact_name,
            event_type,
            event_date,
            event_time,
            event_end_time,
            guest_count,
            location_type,
            venue_location,
            package_id,
            add_on_id,
            total_price,
            special_requests,
            status,
            cancellation_reason,
            cancellation_hold_expires_at,
            pre_cancellation_status,
            reschedule_count,
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

    const [contract, paymentsByReservationId, reschedulesByReservationId, extensionsByReservationId, cancellationInfo, review, reservationRules, paymentRules, policyBodies] = await Promise.all([
        fetchContract(reservationId),
        fetchSharedPayments(supabase, [reservationId]),
        fetchSharedRescheduleRequests(supabase, [reservationId]),
        fetchSharedExtensions(supabase, [reservationId]),
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
        extensions: extensionsByReservationId[reservationId] || [],
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


// Four-step stepper: Submitted -> Verification -> Payment -> Confirmed.
// Completed steps show a timestamp sublabel; the active step sets an
// expectation ("In review — 1 to 2 days") instead of a dead-end word like
// "Locked"; future steps carry no sublabel at all.
function buildStepperSteps(reservation, contractMeta, balance, payments) {
    const verificationDone = isReservationPaymentEnabled(reservation);
    // "Payment" and "Confirmed" complete as soon as ANY base payment type
    // (reservation fee, down payment, custom amount, or full payment) has
    // been approved — not only once the full balance is paid. A remaining
    // balance is still communicated separately via the note strip/header
    // balance badge (both driven by balance.remainingBalance, unchanged),
    // so this doesn't hide that a balance is still due.
    const paymentDone = balance.approvedBaseTotal > 0;
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
                ${reservation.event_end_time ? `
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-hourglass-end" aria-hidden="true"></i> End time</dt>
                    <dd>${escapeHtml(formatTimeOfDay(reservation.event_end_time))}</dd>
                </div>
                ` : ''}
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

function buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl, cancellationFeeOwed = false, paymentRules = null, rescheduleFeeOwed = false, extensionFeeOwed = null) {
    // balance.remainingBalance only tracks the base package price — it goes
    // to 0 the moment the package itself is paid off, regardless of whether
    // a *cancellation*, *reschedule*, or *extension* fee is now separately
    // owed on top of that. Without these checks, a fully-paid reservation
    // that later gets one of those fees reads as paymentDone forever and
    // the CTA below never renders, even though the customer still owes
    // money. extensionFeeOwed is the open reservation_extensions row itself
    // (or null) rather than a boolean, since its amount comes from that
    // row's own snapshotted total_price, not a shared config value the way
    // the cancellation/reschedule fee amounts do.
    const baseBalancePaid = balance.remainingBalance <= 0;
    const paymentDone = baseBalancePaid && !cancellationFeeOwed && !rescheduleFeeOwed && !extensionFeeOwed;
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
                ${rescheduleFeeOwed ? `
                    <div class="rd-receipt-row rd-receipt-total rd-receipt-fee-due">
                        <span>Reschedule fee due</span>
                        <span>${escapeHtml(formatCurrency(getRescheduleFee(paymentRules)))}</span>
                    </div>
                ` : ''}
                ${extensionFeeOwed ? `
                    <div class="rd-receipt-row rd-receipt-total rd-receipt-fee-due">
                        <span>Extension fee due (${escapeHtml(String(extensionFeeOwed.requested_hours))} hour${Number(extensionFeeOwed.requested_hours) === 1 ? '' : 's'})</span>
                        <span>${escapeHtml(formatCurrency(extensionFeeOwed.total_price))}</span>
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
            </div>

            ${showPaymentCta ? `
                <button
                    type="button"
                    class="rd-pay-cta ${locked ? 'locked' : 'primary'}"
                    ${locked ? 'disabled aria-describedby="rd-pay-caption"' : ''}
                    data-payment-url="${escapeHtml(paymentUrl)}"
                >
                    ${locked ? '<i class="fa-solid fa-lock" aria-hidden="true"></i>' : ''} ${cancellationFeeOwed ? 'Pay cancellation fee' : (rescheduleFeeOwed ? 'Pay reschedule fee' : (extensionFeeOwed ? 'Pay extension fee' : 'Continue payment'))}
                </button>
                ${locked ? `<p class="rd-pay-caption" id="rd-pay-caption">Unlocks after your reservation is verified</p>` : ''}
            ` : ''}
        </section>
    `;
}

// A cancellation request always supersedes an open reschedule (see
// supabase/migrations/20260907_cancellation_supersedes_reschedule.sql,
// which voids the reschedule server-side) — so once the reservation itself
// is in a cancellation state, that's the only active request shown here,
// regardless of any now-voided reschedule history.
//
// Payment-first cancellation (update-v20, revised) — while status is
// 'cancellation_requested', the reservation is on hold: the date stays
// occupied and the fee must be verified by a manager before the deadline
// or the reservation auto-finalizes as cancelled anyway (js/reservation_
// shared.js's isCancellationPending, 20260909_reschedule_hold_and_
// cancellation_debt.sql §8). Mirrors the reschedule hold card exactly —
// same countdown row, same withdraw affordance. 'cancellation_approved'
// (pre-update-v20) has no hold_expires_at and no withdraw path.
function buildCancellationRequestCard(reservation, cancellationFeePayment, paymentRules) {
    const isPending = String(reservation.status || '').toLowerCase() === 'cancellation_requested';
    return `
        <section class="rd-panel rd-reschedule-card">
            <div class="rd-reschedule-card-head">
                <h2 class="rd-panel-title">${isPending ? 'Cancellation pending' : 'Cancellation confirmed'}</h2>
                <span class="res-status info">Fee due</span>
            </div>
            <dl class="rd-dl">
                <div class="rd-dl-row rd-dl-row-wrap">
                    <dt><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Reason</dt>
                    <dd${reservation.cancellation_reason ? '' : ' class="muted"'}>${escapeHtml(reservation.cancellation_reason || 'No reason provided')}</dd>
                </div>
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-coins" aria-hidden="true"></i> Cancellation fee</dt>
                    <dd>${escapeHtml(formatCurrency(cancellationFeePayment?.amount ?? getCancellationFee(reservation, paymentRules)))}</dd>
                </div>
                ${isPending && reservation.cancellation_hold_expires_at ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Hold expires</dt>
                        <dd>${escapeHtml(formatDateTime(reservation.cancellation_hold_expires_at))} &mdash; pay and get verified by then, or this finalizes automatically and your date releases</dd>
                    </div>
                ` : ''}
            </dl>
            ${isPending ? `
                <div class="rd-reschedule-row-actions">
                    <button type="button" class="rd-cancel-link" data-action="withdraw-cancellation">Withdraw request</button>
                </div>
            ` : ''}
        </section>
    `;
}

function buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus, cancelBlockReason = null, cancellationFeePayment = null, paymentRules = null, rescheduleBlockReason = null) {
    if (['cancelled', 'declined', 'completed'].includes(effectiveStatus)) return '';

    if (['cancellation_requested', 'cancellation_approved'].includes(String(reservation.status || '').toLowerCase())) {
        return buildCancellationRequestCard(reservation, cancellationFeePayment, paymentRules);
    }

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

    // Same pattern for reschedule (spec §4 — "the customer sees a disabled
    // reschedule action with a short reason"). Only shown when there's no
    // open request already (that has its own withdraw/status UI below) and
    // reschedule isn't available for the more basic "wrong status" reason
    // computeCanReschedule already covers without a matching string.
    const rescheduleMarkup = canReschedule
        ? `<a class="rd-btn-outline" href="${escapeHtml(openRescheduleUrl)}">Request reschedule</a>`
        : (rescheduleBlockReason
            ? `<span class="rd-cancel-blocked" title="${escapeHtml(rescheduleBlockReason)}">${escapeHtml(rescheduleBlockReason)}</span>`
            : '');

    if (!latestRequest && !canReschedule && !canCancel && !cancelBlockReason && !rescheduleBlockReason) return '';

    if (!latestRequest) {
        return `
            <div class="rd-reschedule-row">
                <div class="rd-reschedule-row-left">
                    <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
                    <span>Need to change your event date?</span>
                </div>
                <div class="rd-reschedule-row-actions">
                    ${rescheduleMarkup}
                    ${cancelMarkup}
                </div>
            </div>
        `;
    }

    const statusMeta = getRescheduleStatusMeta(latestRequest.status);
    // No manager approval step (update-v20) — a reschedule request goes
    // straight to approved_pending_payment, the only "before the date
    // actually moves" state left to withdraw from.
    const isPendingReschedule = String(latestRequest.status || '').toLowerCase() === 'approved_pending_payment';

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
                ${isPendingReschedule && latestRequest.hold_expires_at ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Hold expires</dt>
                        <dd>${escapeHtml(formatDateTime(latestRequest.hold_expires_at))} &mdash; pay by then to keep this date</dd>
                    </div>
                ` : ''}
                ${latestRequest.reviewed_at ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-clock" aria-hidden="true"></i> Admin response</dt>
                        <dd>Reviewed ${escapeHtml(formatShortDate(latestRequest.reviewed_at))}</dd>
                    </div>
                ` : ''}
            </dl>
            ${(canReschedule || canCancel || cancelBlockReason || rescheduleBlockReason || isPendingReschedule) ? `
                <div class="rd-reschedule-row-actions">
                    ${isPendingReschedule ? `<button type="button" class="rd-cancel-link" data-action="withdraw-reschedule" data-request-id="${escapeHtml(latestRequest.reschedule_request_id)}">Withdraw request</button>` : ''}
                    ${isPendingReschedule ? '' : rescheduleMarkup}
                    ${cancelMarkup}
                </div>
            ` : ''}
        </section>
    `;
}

// Adds whole hours to a raw Postgres "HH:MM:SS" time-of-day string, for
// showing the *pending* effective end time before an extension is approved
// (reservation.event_end_time itself only updates once it actually is).
function addHoursToTimeString(value, hours) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return '';
    const totalMinutes = (Number(match[1]) * 60 + Number(match[2]) + Number(hours) * 60) % (24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = String(totalMinutes % 60).padStart(2, '0');
    return formatTimeOfDay(`${h}:${m}`);
}

// Package Extension Hours (spec item 4) — mirrors buildRescheduleRow's
// shape/markup exactly (same "Need to change...?" prompt row when nothing
// is open yet, same status-badge card once something is), reusing the same
// .rd-reschedule-row / .rd-reschedule-card / .res-status classes so this
// reads as one consistent pattern rather than a bolted-on second design.
function buildExtensionSection(reservation, extensions, effectiveStatus) {
    if (['cancelled', 'declined', 'completed'].includes(effectiveStatus)) return '';
    if (['cancellation_requested', 'cancellation_approved'].includes(String(reservation.status || '').toLowerCase())) return '';

    const canRequest = computeCanRequestExtension(reservation.status, extensions);
    const latestExtension = (extensions || [])[0] || null;
    const isOpen = latestExtension && ['pending_payment', 'pending_verification'].includes(String(latestExtension.status || '').toLowerCase());

    if (!isOpen) {
        if (!canRequest) return '';
        return `
            <div class="rd-reschedule-row">
                <div class="rd-reschedule-row-left">
                    <i class="fa-solid fa-hourglass-half" aria-hidden="true"></i>
                    <span>Need more time for your event?</span>
                </div>
                <div class="rd-reschedule-row-actions">
                    <button type="button" class="rd-btn-outline" data-action="open-extension">Request extension</button>
                </div>
            </div>
        `;
    }

    const statusMeta = getExtensionStatusMeta(latestExtension.status);
    const isAwaitingPayment = String(latestExtension.status).toLowerCase() === 'pending_payment';
    const pendingEndTime = reservation.event_end_time
        ? addHoursToTimeString(reservation.event_end_time, latestExtension.requested_hours)
        : '';

    return `
        <section class="rd-panel rd-reschedule-card">
            <div class="rd-reschedule-card-head">
                <h2 class="rd-panel-title">Extension request</h2>
                <span class="res-status ${escapeHtml(statusMeta.key)}">${escapeHtml(statusMeta.label)}</span>
            </div>
            <dl class="rd-dl">
                <div class="rd-dl-row">
                    <dt><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Requested hours</dt>
                    <dd>${escapeHtml(String(latestExtension.requested_hours))} hour${Number(latestExtension.requested_hours) === 1 ? '' : 's'} &middot; ${escapeHtml(formatCurrency(latestExtension.total_price))}</dd>
                </div>
                ${pendingEndTime ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Pending end time</dt>
                        <dd>${escapeHtml(pendingEndTime)} &mdash; not yet confirmed</dd>
                    </div>
                ` : ''}
                ${isAwaitingPayment && latestExtension.hold_expires_at ? `
                    <div class="rd-dl-row">
                        <dt><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i> Hold expires</dt>
                        <dd>${escapeHtml(formatDateTime(latestExtension.hold_expires_at))} &mdash; pay by then to keep this time</dd>
                    </div>
                ` : ''}
            </dl>
        </section>
    `;
}

function buildReviewRow(effectiveStatus, review, reservationId) {
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

    const reviewUrl = `/reviews.html?review_reservation_id=${encodeURIComponent(reservationId)}`;
    return `
        <div class="rd-reschedule-row">
            <div class="rd-reschedule-row-left">
                <i class="fa-solid fa-star" aria-hidden="true"></i>
                <span>How was your event?</span>
            </div>
            <div class="rd-reschedule-row-actions">
                <a class="rd-btn-outline" href="${escapeHtml(reviewUrl)}">Leave a review</a>
            </div>
        </div>
    `;
}

function render() {
    const { reservation, contract, payments, rescheduleRequests, extensions, paymentsByReservationId, cancellationInfo, review, reservationRules, paymentRules } = pageData;
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, { formatDate, reservationRules });
    const effectiveStatus = getEffectiveReservationStatus(reservation, balance.remainingBalance);
    const reservationStatus = getReservationStatusMeta(effectiveStatus);
    const statusIcon = getReservationStatusIcon(effectiveStatus);
    const contractMeta = computeContractMeta(contract);
    const rescheduleBlockReason = getRescheduleBlockReason(reservation, paymentRules);
    const canReschedule = computeCanReschedule(reservation.status, rescheduleRequests) && !rescheduleBlockReason;
    const canCancel = computeCanCancel(reservation.status, payments, reservation, paymentRules);
    const cancelBlockReason = getCancellationBlockReason(reservation, paymentRules);
    const isTerminalCancelled = ['cancelled', 'declined'].includes(effectiveStatus);
    const paymentUrl = buildCustomerPaymentUrl(reservationId);
    const cancellationFeeOwed = isCancellationFeeOwed(reservation, payments);
    const rescheduleFeeOwed = isRescheduleFeeOwed(rescheduleRequests, payments);
    // Unlike cancellation/reschedule (a shared config amount), an extension
    // fee's amount comes from the specific open request's own snapshotted
    // total_price — so this is the row itself (or null), not a boolean.
    const openExtension = isExtensionFeeOwed(extensions, payments)
        ? (extensions || []).find((extension) => String(extension.status || '').toLowerCase() === 'pending_payment')
        : null;
    // The 4-step booking stepper (Submitted/Verification/Payment/Confirmed)
    // describes progress toward a *new* booking — showing it while a
    // cancellation fee is owed read as if the original reservation was
    // still being set up. The cancellation request card further down the
    // page (buildCancellationRequestCard) already covers this state.
    const isCancellationInProgress = cancellationFeeOwed;

    const showBalanceSummary = !isTerminalCancelled;
    const paymentDone = balance.remainingBalance <= 0 && !cancellationFeeOwed && !rescheduleFeeOwed && !openExtension;

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
                        <span class="rd-balance-label">${cancellationFeeOwed ? 'Cancellation fee due' : (rescheduleFeeOwed ? 'Reschedule fee due' : (openExtension ? 'Extension fee due' : (paymentDone ? 'Paid in full' : 'Balance due')))}</span>
                        <div class="rd-balance-amount-row">
                            <strong class="rd-balance-amount">${escapeHtml(
                                cancellationFeeOwed
                                    ? formatCurrency(getCancellationFee(reservation, paymentRules))
                                    : (rescheduleFeeOwed
                                        ? formatCurrency(getRescheduleFee(paymentRules))
                                        : (openExtension
                                            ? formatCurrency(openExtension.total_price)
                                            : (paymentDone ? formatCurrency(balance.totalPrice) : formatCurrency(balance.remainingBalance))))
                            )}</strong>
                            ${(!paymentDone && !cancellationFeeOwed && !rescheduleFeeOwed && !openExtension) ? `<span class="rd-balance-due-date">by ${escapeHtml(formatShortDate(balance.dueDateKey))}</span>` : ''}
                        </div>
                    </div>
                ` : ''}
            </div>

            ${isTerminalCancelled
                ? buildCancellationNotice(reservation, effectiveStatus, cancellationInfo, getCancellationFeePayment(payments))
                : (isCancellationInProgress ? '' : buildStepperMarkup(buildStepperSteps(reservation, contractMeta, balance, payments)))
            }

            ${(!isTerminalCancelled && !isCancellationInProgress) ? (() => {
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
            ${buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl, cancellationFeeOwed, paymentRules, rescheduleFeeOwed, openExtension)}
        </div>

        ${buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus, cancelBlockReason, getCancellationFeePayment(payments), paymentRules, rescheduleBlockReason)}
        ${buildExtensionSection(reservation, extensions, effectiveStatus)}
        ${buildReviewRow(effectiveStatus, review, reservation.reservation_id)}
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
        // Payment-first cancellation (Rescheduling & Cancellation spec §7,
        // revised) — mirrors the reschedule hold exactly, just holding the
        // CURRENT date instead of a new one. The reservation moves to
        // 'cancellation_requested', which still occupies its date/time
        // (is_capacity_blocking_reservation_status), until either a
        // manager approves the cancellation_fee payment (finalize_
        // cancellation_on_fee_approval trigger) or the hold deadline
        // passes unpaid (expire_cancellation_holds cron). Both are DB-side
        // — the client only sets the request itself; the fee payment row
        // is created separately when the customer actually submits proof
        // through js/payment.js's real flow, same as every other payment
        // type. See 20260909_reschedule_hold_and_cancellation_debt.sql §8.
        const previousStatus = reservation.status;
        const feeAmount = getCancellationFee(reservation, pageData.paymentRules);
        const holdHours = Number(pageData.paymentRules?.cancellation_hold_hours) || 48;

        const { error: statusError } = await supabase
            .from('reservations')
            .update({ status: 'cancellation_requested', cancellation_reason: reason })
            .eq('reservation_id', reservationId);

        if (statusError) throw statusError;

        // Best-effort audit trail — the hold/pending state itself already
        // lives on the reservation row regardless of whether this insert
        // succeeds, so a failure here doesn't leave anything customer-
        // facing broken.
        await supabase
            .from('reservation_status')
            .insert({
                reservation_id: reservationId,
                previous_status: previousStatus,
                new_status: 'cancellation_requested',
                changed_at: new Date().toISOString()
            });

        closeCancelModal();
        await loadPageData();
        render();
        openSubmissionFeedbackModal({
            eyebrow: 'Cancellation Requested',
            title: 'Pay the Cancellation Fee to Finalize',
            copy: `Your date is on hold. Pay the ${formatCurrency(feeAmount)} cancellation fee within ${holdHours} hours to finalize your cancellation — if it isn't verified in time, your reservation will be automatically cancelled and the fee will still be owed.`
        });
    } catch (error) {
        if (cancelModalConfirm) cancelModalConfirm.removeAttribute('disabled');
        setCancelModalMessage(`Failed to submit cancellation: ${error.message}`, true);
    }
}

async function withdrawCancellationRequest() {
    const reservation = pageData?.reservation;
    if (!reservation) return;
    const confirmed = await showConfirmModal({
        title: 'Withdraw cancellation request?',
        message: 'This will withdraw your cancellation request and keep this reservation active.',
        confirmText: 'Yes, keep reservation',
        cancelText: 'Cancel'
    });
    if (!confirmed) return;
    try {
        const { error } = await supabase
            .from('reservations')
            .update({
                status: reservation.pre_cancellation_status || 'approved',
                cancellation_reason: null,
                cancellation_hold_expires_at: null,
                pre_cancellation_status: null
            })
            .eq('reservation_id', reservationId);
        if (error) throw error;

        await supabase
            .from('reservation_status')
            .insert({
                reservation_id: reservationId,
                previous_status: 'cancellation_requested',
                new_status: reservation.pre_cancellation_status || 'approved',
                changed_at: new Date().toISOString()
            });

        await loadPageData();
        render();
    } catch (error) {
        showFeedbackModal({
            type: 'error',
            title: 'Couldn\'t withdraw request',
            message: `Failed to withdraw: ${error.message}`
        });
    }
}

async function withdrawRescheduleRequest(requestId) {
    if (!requestId) return;
    const confirmed = await showConfirmModal({
        title: 'Withdraw reschedule request?',
        message: 'This will withdraw your pending reschedule request.',
        confirmText: 'Yes, withdraw',
        cancelText: 'Cancel'
    });
    if (!confirmed) return;
    try {
        const { error } = await supabase
            .from('reschedule_requests')
            .update({ status: 'withdrawn' })
            .eq('reschedule_request_id', requestId);
        if (error) throw error;
        await loadPageData();
        render();
    } catch (error) {
        showFeedbackModal({
            type: 'error',
            title: 'Couldn\'t withdraw request',
            message: `Failed to withdraw: ${error.message}`
        });
    }
}

async function init() {
    try {
        await loadPageData();
        render();
    } catch (error) {
        console.error('[reservation_details] failed to load:', error);
        pageContainer.innerHTML = `<p style="color:#c0392b;text-align:center;padding:40px 0;">We couldn't load this reservation. Please try again.</p>`;
    }
}

// ── Extension request modal ────────────────────────────────────────────────
// availability is re-fetched from get_max_extension_hours() every time the
// modal opens (never cached across opens) — the real gap can shrink between
// visits as other customers book, and the server re-validates it again
// anyway at INSERT time, but showing a stale number here would just mean a
// confusing rejection right after the customer submits.
let extensionAvailability = null;
let extensionQuantity = 1;

function setExtensionModalMessage(message, isError = false) {
    if (!extensionModalMessage) return;
    extensionModalMessage.textContent = message || '';
    extensionModalMessage.className = 'account-modal-message' + (isError ? ' error' : '');
}

function renderExtensionModalBody() {
    if (!extensionModalBody) return;

    if (!extensionAvailability) {
        extensionModalBody.innerHTML = '<p class="rd-inline-note">Checking availability…</p>';
        extensionModalConfirm?.setAttribute('disabled', 'true');
        return;
    }

    if (!extensionAvailability.extendable) {
        const reason = extensionAvailability.nextBookingLabel
            ? `No extension time is available — the next slot is booked at ${extensionAvailability.nextBookingLabel}.`
            : 'No extension time is available for this reservation right now.';
        extensionModalBody.innerHTML = `<p class="rd-inline-note">${escapeHtml(reason)}</p>`;
        extensionModalConfirm?.setAttribute('disabled', 'true');
        return;
    }

    const maxHours = extensionAvailability.maxHours;
    const pricePerHour = extensionAvailability.pricePerHour || 0;
    const total = extensionQuantity * pricePerHour;
    const capNote = extensionAvailability.nextBookingLabel
        ? ` — the next slot is booked at ${extensionAvailability.nextBookingLabel}`
        : '';

    extensionModalBody.innerHTML = `
        <p class="rd-inline-note">${escapeHtml(`You can extend by up to ${maxHours} hour${maxHours === 1 ? '' : 's'}${capNote}.`)}</p>
        <div class="extension-qty-row">
            <label class="cancel-reason-label" for="extension-qty-input">Hours to add</label>
            <div class="extension-qty-stepper">
                <button type="button" class="extension-qty-btn" id="extension-qty-minus" aria-label="Decrease hours" ${extensionQuantity <= 1 ? 'disabled' : ''}>&minus;</button>
                <input type="number" id="extension-qty-input" class="extension-qty-input" inputmode="numeric" min="1" max="${maxHours}" step="1" value="${extensionQuantity}" aria-label="Hours to add">
                <button type="button" class="extension-qty-btn" id="extension-qty-plus" aria-label="Increase hours" ${extensionQuantity >= maxHours ? 'disabled' : ''}>&plus;</button>
            </div>
        </div>
        <div class="cancel-fee-block">
            <span class="cancel-fee-label">Total</span>
            <strong class="cancel-fee-amount">${escapeHtml(formatCurrency(total))}</strong>
            <p class="cancel-fee-note">${escapeHtml(formatCurrency(pricePerHour))} per hour &middot; ${extensionQuantity} hour${extensionQuantity === 1 ? '' : 's'}</p>
        </div>
    `;
    extensionModalConfirm?.removeAttribute('disabled');

    const qtyInput = document.getElementById('extension-qty-input');
    const minusBtn = document.getElementById('extension-qty-minus');
    const plusBtn = document.getElementById('extension-qty-plus');

    const setQuantity = (value) => {
        extensionQuantity = Math.max(1, Math.min(maxHours, Math.round(value) || 1));
        renderExtensionModalBody();
    };

    qtyInput?.addEventListener('change', () => setQuantity(Number(qtyInput.value)));
    minusBtn?.addEventListener('click', () => setQuantity(extensionQuantity - 1));
    plusBtn?.addEventListener('click', () => setQuantity(extensionQuantity + 1));
}

async function openExtensionModal() {
    if (!pageData?.reservation) return;
    extensionQuantity = 1;
    extensionAvailability = null;
    setExtensionModalMessage('');
    renderExtensionModalBody();
    extensionRequestBackdrop?.classList.remove('hidden');
    extensionRequestBackdrop?.setAttribute('aria-hidden', 'false');

    try {
        extensionAvailability = await fetchMaxExtensionHours(supabase, reservationId);
    } catch (error) {
        extensionAvailability = { maxHours: 0, pricePerHour: null, extendable: false, nextBookingLabel: null };
        setExtensionModalMessage(`Couldn't check extension availability: ${error.message}`, true);
    }
    renderExtensionModalBody();
}

function closeExtensionModal() {
    extensionRequestBackdrop?.classList.add('hidden');
    extensionRequestBackdrop?.setAttribute('aria-hidden', 'true');
    extensionModalConfirm?.removeAttribute('disabled');
    setExtensionModalMessage('');
}

async function submitExtensionRequest() {
    if (!extensionAvailability?.extendable) return;
    extensionModalConfirm?.setAttribute('disabled', 'true');
    setExtensionModalMessage('Submitting your extension request…');

    try {
        await requestExtension(supabase, reservationId, extensionQuantity);
        closeExtensionModal();
        // Routes straight into the existing payment flow (spec item 4) —
        // the extension_fee option now exists for this reservation
        // (getAvailablePaymentOptions picks it up automatically), so no
        // separate payment UI is needed here.
        window.location.href = buildCustomerPaymentUrl(reservationId);
    } catch (error) {
        extensionModalConfirm?.removeAttribute('disabled');
        setExtensionModalMessage(`Failed to submit extension request: ${error.message}`, true);
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
        return;
    }

    const extensionTriggerBtn = event.target.closest('[data-action="open-extension"]');
    if (extensionTriggerBtn) {
        openExtensionModal();
        return;
    }

    const withdrawRescheduleBtn = event.target.closest('[data-action="withdraw-reschedule"]');
    if (withdrawRescheduleBtn) {
        withdrawRescheduleRequest(withdrawRescheduleBtn.dataset.requestId);
        return;
    }

    const withdrawCancellationBtn = event.target.closest('[data-action="withdraw-cancellation"]');
    if (withdrawCancellationBtn) {
        withdrawCancellationRequest();
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
    if (event.key === 'Escape' && !extensionRequestBackdrop?.classList.contains('hidden')) closeExtensionModal();
});

extensionModalClose?.addEventListener('click', closeExtensionModal);
extensionModalDismiss?.addEventListener('click', closeExtensionModal);
extensionModalConfirm?.addEventListener('click', submitExtensionRequest);
extensionRequestBackdrop?.addEventListener('click', (event) => {
    if (event.target === extensionRequestBackdrop) closeExtensionModal();
});

submissionFeedbackClose?.addEventListener('click', closeSubmissionFeedbackModal);
submissionFeedbackDismiss?.addEventListener('click', closeSubmissionFeedbackModal);
submissionFeedbackBackdrop?.addEventListener('click', (event) => {
    if (event.target === submissionFeedbackBackdrop) closeSubmissionFeedbackModal();
});

init();

initAutoRefresh(async () => {
    try {
        await loadPageData();
        render();
    } catch (error) {
        // A background refresh failure shouldn't blow away a page the
        // customer is already looking at with an error screen — just log
        // it and leave the last-good render in place.
        console.error('[reservation_details] silent auto-refresh failed:', error);
    }
});

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        window.location.href = '/login.html';
    }
});