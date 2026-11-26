// Shared, side-effect-free helpers used by both js/account.js (the
// reservations list) and js/reservation_details.js (the standalone
// reservation detail page). Pure functions only — no DOM access, no
// module-level state, no Supabase calls. Anything that needs data beyond
// its arguments takes that data as a parameter instead of reaching into a
// page-specific state object, so it works the same regardless of which
// page fetched the data.

import { formatMoney } from './money.js';

export const BUSINESS_TIME_ZONE = 'Asia/Manila';

export const PAYMENT_TYPE_META = {
    reservation_fee: { label: 'Reservation Fee', description: 'Fixed reservation fee' },
    down_payment: { label: 'Down Payment', description: '50% of your total amount' },
    partial_payment: { label: 'Custom Amount', description: 'Enter any amount you want to pay' },
    full_payment: { label: 'Full Payment', description: 'Settle the remaining balance in full' },
    reschedule_fee: { label: 'Reschedule Fee', description: 'Fixed fee for approved reschedule requests' },
    extension_fee: { label: 'Extension Fee', description: 'Fee for your requested extension hours' },
    additional_head_fee: { label: 'Additional Guests Fee', description: 'Fee for your requested additional guests' }
};

// Package Extension Hours — mirrors RESCHEDULE_STATUS_META's shape exactly,
// but this feature has no update-v20-style "skip pending" history: every
// extension request genuinely passes through pending_payment first.
export const EXTENSION_STATUS_META = {
    pending_payment: { label: 'Awaiting Payment', key: 'info' },
    pending_verification: { label: 'Pending Verification', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' },
    expired: { label: 'Expired', key: 'cancelled' }
};

// Additional Head Requests (post-booking) — identical shape/lifecycle to
// EXTENSION_STATUS_META, see that constant's own comment.
export const ADDITIONAL_HEAD_STATUS_META = {
    pending_payment: { label: 'Awaiting Payment', key: 'info' },
    pending_verification: { label: 'Pending Verification', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' },
    expired: { label: 'Expired', key: 'cancelled' }
};

// update-v20: no manager approval step — a submitted reschedule goes
// straight to approved_pending_payment (skips 'pending' entirely). That
// entry is kept only so any not-yet-migrated historical row still renders
// a sensible label rather than falling through to the raw status string.
export const RESCHEDULE_STATUS_META = {
    pending: { label: 'Awaiting Fee', key: 'info' },
    approved_pending_payment: { label: 'Awaiting Fee', key: 'info' },
    rejected: { label: 'Rejected', key: 'rejected' },
    completed: { label: 'Completed', key: 'approved' },
    // A cancellation request always supersedes an open reschedule — see
    // supabase/migrations/20260907_cancellation_supersedes_reschedule.sql.
    voided: { label: 'Voided - Cancellation Requested', key: 'cancelled' },
    withdrawn: { label: 'Withdrawn', key: 'cancelled' }
};

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatCurrency(value) {
    return formatMoney(value);
}

export function formatDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDateTime(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not available';
    return date.toLocaleString('en-PH', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
}

export function formatShortDate(value) {
    if (!value) return 'No date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'No date';
    return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateKey(value) {
    return String(value || '').split('T')[0];
}

export function getTimeZoneNowParts(timeZone = BUSINESS_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = formatter.formatToParts(new Date()).reduce((map, part) => {
        if (part.type !== 'literal') map[part.type] = part.value;
        return map;
    }, {});

    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        hours: Number(parts.hour || 0),
        minutes: Number(parts.minute || 0)
    };
}

export function isDateBeforeToday(value) {
    const dateKey = formatDateKey(value);
    if (!dateKey) return false;
    return dateKey < getTimeZoneNowParts().dateKey;
}

export function parseEventTimeToParts(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;

    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3].toUpperCase();

    if (hours === 12) {
        hours = meridiem === 'AM' ? 0 : 12;
    } else if (meridiem === 'PM') {
        hours += 12;
    }

    return { hours, minutes };
}

export function getReservationEventDateTime(reservation) {
    const dateKey = formatDateKey(reservation?.event_date);
    if (!dateKey) return null;

    const timeParts = parseEventTimeToParts(reservation?.event_time);
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;

    if (timeParts) {
        date.setHours(timeParts.hours, timeParts.minutes, 0, 0);
    }

    return date;
}

export function isReservationEventPast(reservation) {
    const dateKey = formatDateKey(reservation?.event_date);
    if (!dateKey) return false;

    const nowParts = getTimeZoneNowParts();
    if (dateKey < nowParts.dateKey) return true;
    if (dateKey > nowParts.dateKey) return false;

    const eventTimeParts = parseEventTimeToParts(reservation?.event_time) || { hours: 0, minutes: 0 };
    const eventMinutes = (eventTimeParts.hours * 60) + eventTimeParts.minutes;
    const currentMinutes = (nowParts.hours * 60) + nowParts.minutes;

    return eventMinutes <= currentMinutes;
}

// outstandingBalance must be explicitly supplied (from
// reservation_payment_summary) for a past-event reservation to compute as
// "completed" — without it this never infers completion on its own, it
// only reflects an already-persisted 'completed' status. Event-passed-but-
// unpaid reservations are handled entirely by the separate auto-cancel-
// overdue flow, not this function.
export function getEffectiveReservationStatus(reservation, outstandingBalance) {
    const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
    if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
        return normalizedStatus;
    }
    const isPaidInFull = Number.isFinite(Number(outstandingBalance)) && Number(outstandingBalance) <= 0;
    if (isPaidInFull && isReservationEventPast(reservation) && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
        return 'completed';
    }
    return normalizedStatus;
}

export function getReservationStatusMeta(status) {
    const normalizedStatus = String(status || 'pending').toLowerCase();
    const labelMap = {
        pending: 'Pending Verification',
        approved: 'Approved',
        confirmed: 'Approved',
        cancelled: 'Cancelled',
        declined: 'Declined',
        completed: 'Completed',
        rescheduled: 'Rescheduled',
        cancellation_requested: 'Cancellation Requested',
        cancellation_approved: 'Cancellation Approved — Fee Due'
    };

    return {
        key: normalizedStatus,
        label: labelMap[normalizedStatus] || (normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1))
    };
}

// Tabler icon name (without the ti- prefix) for status badges, for
// at-a-glance recognition alongside the existing tone colors.
export function getReservationStatusIcon(statusKey) {
    const normalizedStatus = String(statusKey || '').toLowerCase();
    if (['cancelled', 'declined'].includes(normalizedStatus)) return 'x';
    if (normalizedStatus === 'completed') return 'check';
    if (['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) return 'check';
    return 'clock';
}

export function getPaymentLabel(paymentType) {
    return PAYMENT_TYPE_META[paymentType]?.label || (paymentType || 'Payment');
}

export function getRescheduleStatusMeta(status) {
    return RESCHEDULE_STATUS_META[String(status || 'pending').toLowerCase()] || RESCHEDULE_STATUS_META.pending;
}

export function getExtensionStatusMeta(status) {
    return EXTENSION_STATUS_META[String(status || 'pending_payment').toLowerCase()] || EXTENSION_STATUS_META.pending_payment;
}

export function getAdditionalHeadStatusMeta(status) {
    return ADDITIONAL_HEAD_STATUS_META[String(status || 'pending_payment').toLowerCase()] || ADDITIONAL_HEAD_STATUS_META.pending_payment;
}

export function getReservationPackageName(reservation) {
    return reservation.package?.package_name || reservation.package_id || 'No package selected';
}

export function getReservationAddOnName(reservation) {
    return reservation.add_on?.package_name || '';
}

export function getReservationLocationLabel(reservation) {
    return String(reservation.location_type || '').toLowerCase() === 'onsite'
        ? 'Onsite - ELI Coffee'
        : `Offsite - ${reservation.venue_location || 'Venue not provided'}`;
}

export function getCancellationFeePayment(payments) {
    return (payments || []).find((payment) => payment.payment_type === 'cancellation_fee') || null;
}

// An unpaid reservation that the overdue job cancelled normally (20261201):
// nothing had been paid, so the job created no cancellation_fee row. Without
// this, "cancelled and no fee row" would read as "fee owed" on every customer
// screen. It only holds while NO fee row exists — if a fee was created (the
// customer had paid something, or staff added one) it is handled as usual.
export function isCancellationFeeWaived(reservation, payments) {
    return String(reservation?.status || '').toLowerCase() === 'cancelled'
        && (
            reservation?.cancellation_reason === 'auto_cancelled_overdue'
            // 20261206: a customer cancellation whose frozen fee is 0.
            || getFrozenFee(reservation?.cancellation_fee_amount) === 0
        )
        && !getCancellationFeePayment(payments);
}

// True while the reservation has a cancellation fee outstanding and
// needs the customer to act — either it's holding its date awaiting the
// fee (cancellation_requested, payment-first model), or it's already
// finalized cancelled (fee never got approved before the hold expired, or
// a submitted fee was rejected and needs resubmission). Once a
// cancellation_fee payment is pending_review or approved, this goes
// false — nothing more for the customer to do right now.
// 'cancellation_approved' is the pre-update-v20 manager-approval status —
// kept here only for any reservation still sitting in that state from
// before this cycle's rewrites.
export function isCancellationFeeOwed(reservation, payments) {
    if (!['cancellation_requested', 'cancellation_approved', 'cancelled'].includes(String(reservation?.status || '').toLowerCase())) return false;
    if (isCancellationFeeWaived(reservation, payments)) return false;
    const feePayment = getCancellationFeePayment(payments);
    const feeStatus = String(feePayment?.payment_status || '').toLowerCase();
    return !feePayment || feeStatus === 'rejected';
}

// True while a cancellation is holding the reservation's date and
// awaiting the fee to be verified (or the hold to expire) — the
// payment-first window itself, distinct from isCancellationFeeOwed which
// also covers the already-finalized-but-unpaid case after the hold ends.
export function isCancellationPending(reservation) {
    return String(reservation?.status || '').toLowerCase() === 'cancellation_requested';
}

// A reservation's balance.remainingBalance only tracks the base package
// price (see getReservationBalanceDetails in customer_payments.js) — it
// can read 0 while a reschedule or cancellation fee is still separately
// owed on top of that. Both this and isCancellationFeeOwed above exist so
// every surface that shows "what does the customer owe right now" (the
// account.js reservation card, reservation_details.js, payment.js) agrees,
// instead of three separate re-derivations drifting apart.
export function isRescheduleFeeOwed(rescheduleRequests, payments) {
    const openRequest = (rescheduleRequests || [])
        .find((request) => String(request.status || '').toLowerCase() === 'approved_pending_payment');
    if (!openRequest) return false;
    const hasExistingFee = (payments || []).some((payment) => (
        String(payment.reschedule_request_id || '') === String(openRequest.reschedule_request_id)
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
    return !hasExistingFee;
}

// Mirrors isRescheduleFeeOwed exactly, for the same reason: a reservation's
// balance.remainingBalance never reflects an extension fee, so every
// surface that shows "what does the customer owe right now" needs this
// checked alongside the base balance, not folded into it.
export function isExtensionFeeOwed(extensions, payments) {
    const openExtension = (extensions || [])
        .find((extension) => String(extension.status || '').toLowerCase() === 'pending_payment');
    if (!openExtension) return false;
    const hasExistingFee = (payments || []).some((payment) => (
        String(payment.extension_id || '') === String(openExtension.extension_id)
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
    return !hasExistingFee;
}

// True while an extension request exists that the customer still needs to
// see progress on (awaiting their payment, or awaiting Manager review) —
// used to render the "not yet confirmed" status indicator on the
// reservation details page (spec item 4).
export function getOpenExtension(extensions) {
    return (extensions || []).find((extension) => (
        ['pending_payment', 'pending_verification'].includes(String(extension.status || '').toLowerCase())
    )) || null;
}

// Pure eligibility check, mirrors computeCanReschedule exactly: only once
// the base reservation is Confirmed (approved/confirmed/rescheduled), and
// only when no other extension request is already open for it.
export function computeCanRequestExtension(status, extensions) {
    const normalizedStatus = String(status || '').toLowerCase();
    return ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus) && !getOpenExtension(extensions);
}

// Additional Head Requests (post-booking) — mirrors isExtensionFeeOwed/
// getOpenExtension/computeCanRequestExtension exactly, just for
// reservation_additional_head_requests instead of reservation_extensions.
export function isAdditionalHeadFeeOwed(additionalHeadRequests, payments) {
    const openRequest = (additionalHeadRequests || [])
        .find((request) => String(request.status || '').toLowerCase() === 'pending_payment');
    if (!openRequest) return false;
    const hasExistingFee = (payments || []).some((payment) => (
        String(payment.additional_head_request_id || '') === String(openRequest.additional_head_request_id)
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
    return !hasExistingFee;
}

export function getOpenAdditionalHeadRequest(additionalHeadRequests) {
    return (additionalHeadRequests || []).find((request) => (
        ['pending_payment', 'pending_verification'].includes(String(request.status || '').toLowerCase())
    )) || null;
}

export function computeCanRequestAdditionalHeads(status, additionalHeadRequests) {
    const normalizedStatus = String(status || '').toLowerCase();
    return ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus) && !getOpenAdditionalHeadRequest(additionalHeadRequests);
}

// ── Cancellation / reschedule fees ──────────────────────────────────────────
// Policy (Terms, section 6): every payment is non-refundable, and
//   * cancelling LESS than 2 days before the event costs 30% of the total
//     contract amount (the full 30%, on top of what was already paid); 2 or
//     more days before costs nothing; nothing paid at all costs nothing;
//   * rescheduling LESS than 30 days before the ORIGINAL event date costs
//     10% of the total contract amount; 30 or more days costs nothing.
// The numbers come from system_settings.payment_rules (cancellation_fee_
// notice_days / cancellation_fee_percent / reschedule_fee_notice_days /
// reschedule_fee_percent) and fall back to the policy above when never saved.
// Days are whole calendar days in Asia/Manila (event date minus today).
//
// This is the browser copy of public.cancellation_fee_for() and
// public.reschedule_fee_for() (supabase/migrations/20261206_...). The
// database decides the real amount and freezes it on the request
// (reservations.cancellation_fee_amount, reschedule_requests.fee_amount);
// these functions only PREVIEW it before the request exists, and
// fee_policy_test.mjs keeps the two identical.
export const FEE_POLICY_DEFAULTS = Object.freeze({
    cancellationNoticeDays: 2,
    cancellationFeePercent: 30,
    rescheduleNoticeDays: 30,
    rescheduleFeePercent: 10
});

function policyNumber(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getFeePolicy(paymentRules) {
    const r = paymentRules || {};
    return {
        cancellationNoticeDays: policyNumber(r.cancellation_fee_notice_days, FEE_POLICY_DEFAULTS.cancellationNoticeDays),
        cancellationFeePercent: policyNumber(r.cancellation_fee_percent, FEE_POLICY_DEFAULTS.cancellationFeePercent),
        rescheduleNoticeDays: policyNumber(r.reschedule_fee_notice_days, FEE_POLICY_DEFAULTS.rescheduleNoticeDays),
        rescheduleFeePercent: policyNumber(r.reschedule_fee_percent, FEE_POLICY_DEFAULTS.rescheduleFeePercent)
    };
}

// Whole calendar days from `todayKey` (YYYY-MM-DD, Manila) to the event date.
// Negative once the event has passed; null when the date is missing.
export function getDaysUntilEvent(reservation, todayKey = getTimeZoneNowParts().dateKey) {
    const eventKey = formatDateKey(reservation?.event_date);
    if (!eventKey || !todayKey) return null;
    const toDays = (key) => {
        const [y, m, d] = String(key).split('-').map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
    };
    const days = toDays(eventKey) - toDays(todayKey);
    return Number.isFinite(days) ? days : null;
}

// percent of an amount, in whole centavos, rounded half up with integer
// arithmetic only (the database rounds numeric the same way, so a value like
// 10.005 can never come out differently here).
function percentOfAmount(amount, percent) {
    const cents = Math.round(Number(amount || 0) * 100);
    const hundredths = Math.round(Number(percent || 0) * 100);
    return Math.floor((cents * hundredths + 5000) / 10000) / 100;
}

function getApprovedPaidTotal(payments) {
    return (payments || []).reduce((sum, payment) => (
        String(payment?.payment_status || '').toLowerCase() === 'approved'
            ? sum + Number(payment.amount || 0)
            : sum
    ), 0);
}

// What cancelling would cost right now, and why. `payments` is the
// reservation's payment rows (used for the "nothing paid" rule); leave it
// out and the notice rule alone decides.
export function getCancellationFeeInfo(reservation, paymentRules, payments, todayKey) {
    const policy = getFeePolicy(paymentRules);
    const days = getDaysUntilEvent(reservation, todayKey);
    const base = { percent: policy.cancellationFeePercent, noticeDays: policy.cancellationNoticeDays, days };
    if (days === null || days >= policy.cancellationNoticeDays) {
        return { ...base, amount: 0, reason: 'notice' };
    }
    if (Array.isArray(payments) && getApprovedPaidTotal(payments) <= 0) {
        return { ...base, amount: 0, reason: 'nothing_paid' };
    }
    return { ...base, amount: percentOfAmount(reservation?.total_price, policy.cancellationFeePercent), reason: 'fee' };
}

export function computeCancellationFee(reservation, paymentRules, payments, todayKey) {
    return getCancellationFeeInfo(reservation, paymentRules, payments, todayKey).amount;
}

export function computeRescheduleFee(reservation, paymentRules, todayKey) {
    const policy = getFeePolicy(paymentRules);
    const days = getDaysUntilEvent(reservation, todayKey);
    if (days === null || days >= policy.rescheduleNoticeDays) return 0;
    return percentOfAmount(reservation?.total_price, policy.rescheduleFeePercent);
}

function getFrozenFee(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

// The old flat fee. Still what the overdue auto-cancel charges, and what a
// cancellation already in flight before 20261206 (no frozen amount) owes.
function getFlatCancellationFee(reservation, paymentRules) {
    const isOffsite = String(reservation?.location_type || '').toLowerCase() === 'offsite';
    const key = isOffsite ? 'cancellation_fee_offsite' : 'cancellation_fee_onsite';
    const configured = Number(paymentRules?.[key]);
    if (paymentRules && Number.isFinite(configured) && configured >= 0) {
        return configured;
    }
    return isOffsite ? 2000 : 500;
}

const CANCELLATION_FLOW_STATUSES = ['cancellation_requested', 'cancellation_approved', 'cancelled'];

// The cancellation fee for this reservation. Once cancelling has begun the
// amount frozen by the database is the answer (or the old flat fee when none
// was frozen); before that it is a preview from the notice rule. Pass the
// reservation's payments for an accurate preview.
export function getCancellationFee(reservation, paymentRules, payments) {
    const status = String(reservation?.status || '').toLowerCase();
    if (CANCELLATION_FLOW_STATUSES.includes(status)) {
        const frozen = getFrozenFee(reservation?.cancellation_fee_amount);
        return frozen !== null ? frozen : getFlatCancellationFee(reservation, paymentRules);
    }
    return computeCancellationFee(reservation, paymentRules, payments);
}

// The reschedule fee. With a request: the amount frozen on it (or the old
// flat fee for a request made before 20261206). With only a reservation: a
// preview of what rescheduling would cost today. With neither: the old flat fee.
export function getRescheduleFee(paymentRules, request = null, reservation = null) {
    if (request) {
        const frozen = getFrozenFee(request.fee_amount);
        if (frozen !== null) return frozen;
    } else if (reservation) {
        return computeRescheduleFee(reservation, paymentRules);
    }
    const configured = Number(paymentRules?.reschedule_fee);
    if (paymentRules && Number.isFinite(configured) && configured >= 0) {
        return configured;
    }
    return 3000;
}

// Contract / message tokens for the fee policy, from the live settings.
// {{cancellation_fee}} and {{reschedule_fee}} used to be flat peso amounts; they
// now read as the percentage ("30% of the total contract amount") so a template
// that says "a cancellation fee of {{cancellation_fee}}" stays correct.
export function getFeeTokenValues(paymentRules) {
    const p = getFeePolicy(paymentRules);
    return {
        cancellation_fee: `${p.cancellationFeePercent}% of the total contract amount`,
        reschedule_fee: `${p.rescheduleFeePercent}% of the total contract amount`,
        cancellation_fee_percent: String(p.cancellationFeePercent),
        cancellation_notice_days: String(p.cancellationNoticeDays),
        reschedule_fee_percent: String(p.rescheduleFeePercent),
        reschedule_notice_days: String(p.rescheduleNoticeDays)
    };
}

function plural(n, word) {
    return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

// Customer-facing wording for the fee policy, built from the live settings so
// it can never disagree with what is charged.
export function describeCancellationPolicy(paymentRules) {
    const p = getFeePolicy(paymentRules);
    return `Cancelling less than ${plural(p.cancellationNoticeDays, 'day')} before the event is charged ${p.cancellationFeePercent}% of the total contract amount. Cancelling earlier has no fee.`;
}

export function describeReschedulePolicy(paymentRules) {
    const p = getFeePolicy(paymentRules);
    return `Rescheduling less than ${plural(p.rescheduleNoticeDays, 'day')} before the event date may incur a ${p.rescheduleFeePercent}% fee of the total contract amount. With more notice there is no fee.`;
}

// The note shown under the fee in the Cancel Reservation dialog.
export function describeCancellationFeeInfo(info, paymentRules) {
    if (info.amount > 0) {
        return `${describeCancellationPolicy(paymentRules)} This fee must be paid to complete the cancellation. You will be directed to the Payments section after confirming.`;
    }
    if (info.reason === 'nothing_paid') {
        return 'Nothing has been paid on this reservation, so no cancellation fee applies. It will be cancelled right away.';
    }
    return `You are cancelling at least ${plural(info.noticeDays, 'day')} before your event, so no cancellation fee applies. Your reservation will be cancelled right away.`;
}

// The one place Unpaid/Partially paid/Paid in full/Overpaid labels and pill
// colors are decided, fed by reservation_payment_summary's computed_status.
// Deliberately reuses the existing .status-pill.pending/.approved classes
// (identical colors already established for those states elsewhere) rather
// than inventing new tokens — only "overpaid" needs its own class.
export function getPaymentStatusPillMeta(computedStatus) {
    const map = {
        unpaid: { key: 'pending', label: 'Unpaid' },
        partially_paid: { key: 'pending', label: 'Partially paid' },
        paid_in_full: { key: 'approved', label: 'Paid in full' },
        overpaid: { key: 'overpaid', label: 'Overpaid' }
    };
    return map[String(computedStatus || '').toLowerCase()] || map.unpaid;
}

// Resolves whether a payment row's method is one the customer submits
// evidence for (reference number + proof) or one the café issues the
// receipt for (cash/card, confirmed by a manager). Looks up the method via
// payment_method_id when present; falls back to the legacy free-text
// payment_method value for older rows recorded before that FK existed
// (same shape as resolveLegacyModeKey elsewhere) — cash/card still meant
// cafe_issued before evidence_source existed as a column.
export function resolvePaymentEvidenceSource(payment, paymentMethodMap = {}) {
    const method = paymentMethodMap[payment?.payment_method_id];
    if (method) return method.evidence_source;
    return ['cash', 'card'].includes(payment?.payment_method) ? 'cafe_issued' : 'customer_submitted';
}

// Pure contract-meta computation — takes the raw contract row directly
// rather than looking it up from a page-specific state object, so callers
// on any page can use it.
export function computeContractMeta(contract) {
    const reviewStatus = String(contract?.review_status || '').toLowerCase();

    if (reviewStatus === 'verified' || contract?.verified_date) {
        return {
            label: 'Verified contract',
            key: 'approved',
            statusKey: 'verified',
            verification: `Verified ${formatDateTime(contract.verified_date)}`,
            reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
            note: '',
            hasFile: Boolean(contract?.contract_url),
            contract
        };
    }

    if (reviewStatus === 'pending_review' || contract?.contract_url) {
        return {
            label: 'Pending review',
            key: 'pending',
            statusKey: 'pending_review',
            verification: 'Pending admin verification',
            reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
            note: contract?.review_notes || '',
            hasFile: Boolean(contract?.contract_url),
            contract
        };
    }

    return {
        label: 'No contract uploaded',
        key: 'neutral',
        statusKey: 'missing',
        verification: 'No signed contract uploaded yet',
        reviewedAt: '',
        note: '',
        hasFile: false,
        contract
    };
}

// Pure eligibility checks — take the reservation's status plus whatever
// list of related rows would normally come from page state.
export function computeCanReschedule(status, rescheduleRequests) {
    const normalizedStatus = String(status || '').toLowerCase();
    const latestOpenRequest = (rescheduleRequests || [])
        .find((request) => ['pending', 'approved_pending_payment'].includes(String(request.status || '').toLowerCase()));

    return ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus) && !latestOpenRequest;
}

// Client-side pre-flight for the two eligibility gates set_reschedule_hold_
// expiry() (the DB trigger) actually enforces — this is the friendly
// disabled-button reason (Rescheduling & Cancellation spec §4); the
// trigger is still the real backstop if this ever goes stale relative to
// admin policy changes or client state.
export function getRescheduleBlockReason(reservation, paymentRules) {
    if (!reservation) return null;

    const minNotice = paymentRules?.reschedule_min_notice_days;
    if (minNotice !== null && minNotice !== undefined && Number.isFinite(Number(minNotice))) {
        const eventDate = getReservationEventDateTime(reservation);
        if (eventDate) {
            const daysUntilEvent = (eventDate.getTime() - Date.now()) / 86400000;
            if (daysUntilEvent < Number(minNotice)) {
                const n = Number(minNotice);
                return `Reschedule requests must be made at least ${n} day${n === 1 ? '' : 's'} before your event.`;
            }
        }
    }

    const maxCount = paymentRules?.max_reschedule_count;
    if (maxCount !== null && maxCount !== undefined && Number.isFinite(Number(maxCount))) {
        if (Number(reservation.reschedule_count || 0) >= Number(maxCount)) {
            return 'This reservation has reached its reschedule limit — contact us directly.';
        }
    }

    return null;
}

export function computeCanCancel(status, payments, reservation = null, paymentRules = null) {
    const normalizedStatus = String(status || '').toLowerCase();
    if (!['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) return false;

    const hasPendingFee = (payments || []).some((payment) => (
        payment.payment_type === 'cancellation_fee'
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
    if (hasPendingFee) return false;

    return getCancellationBlockReason(reservation, paymentRules) === null;
}

// Returns null when the optional time-based cancellation rules allow a
// request right now, or a customer-facing sentence explaining why they
// don't. Both rules are opt-in — a null/unset value in paymentRules means
// that particular rule is off (see the admin Payment Rules panel).
export function getCancellationBlockReason(reservation, paymentRules) {
    if (!reservation) return null;

    const minNotice = paymentRules?.cancellation_min_notice_days;
    if (minNotice !== null && minNotice !== undefined && Number.isFinite(Number(minNotice))) {
        const eventDate = getReservationEventDateTime(reservation);
        if (eventDate) {
            const daysUntilEvent = (eventDate.getTime() - Date.now()) / 86400000;
            if (daysUntilEvent < Number(minNotice)) {
                const n = Number(minNotice);
                return `Cancellation requests must be submitted at least ${n} day${n === 1 ? '' : 's'} before your event date.`;
            }
        }
    }

    const requestWindow = paymentRules?.cancellation_request_window_days;
    if (requestWindow !== null && requestWindow !== undefined && Number.isFinite(Number(requestWindow))) {
        if (reservation.created_at) {
            const daysSinceBooking = (Date.now() - new Date(reservation.created_at).getTime()) / 86400000;
            if (daysSinceBooking > Number(requestWindow)) {
                const n = Number(requestWindow);
                return `Cancellation requests are only accepted within ${n} day${n === 1 ? '' : 's'} of booking.`;
            }
        }
    }

    return null;
}

// update-v20 manager alert banner — with no approve/reject step left on
// either flow, this is the manager's replacement visibility: reservations
// with a customer-initiated cancellation or reschedule that's finalized
// (paid, change took effect) or in progress (confirmed, fee not yet paid)
// and not yet reviewed (reservations.change_seen_at is null, or older than
// the reservation's own updated_at — i.e. something changed since it was
// last marked seen). "Review" (wired per-page) sets change_seen_at to
// clear it; a later change naturally re-trips it.
export async function fetchUnseenReservationChanges(supabase) {
    const [{ data: cancellations, error: cancellationError }, { data: rescheduleRows, error: rescheduleError }] = await Promise.all([
        supabase
            .from('reservations')
            .select('reservation_id, change_seen_at, updated_at, reservation_number, contact_name')
            .in('status', ['cancellation_requested', 'cancellation_approved', 'cancelled']),
        supabase
            .from('reschedule_requests')
            .select('reservation_id')
            .in('status', ['approved_pending_payment', 'completed'])
    ]);
    if (cancellationError) throw cancellationError;
    if (rescheduleError) throw rescheduleError;

    const rescheduleReservationIds = Array.from(new Set((rescheduleRows || []).map((row) => row.reservation_id)));
    const cancellationIds = new Set((cancellations || []).map((row) => row.reservation_id));
    const seenById = new Map((cancellations || []).map((row) => [row.reservation_id, row]));

    const missingIds = rescheduleReservationIds.filter((id) => !seenById.has(id));
    if (missingIds.length) {
        const { data: rescheduleReservations, error: fetchError } = await supabase
            .from('reservations')
            .select('reservation_id, change_seen_at, updated_at, reservation_number, contact_name')
            .in('reservation_id', missingIds);
        if (fetchError) throw fetchError;
        (rescheduleReservations || []).forEach((row) => seenById.set(row.reservation_id, row));
    }

    const allIds = new Set([...cancellationIds, ...rescheduleReservationIds]);
    const unseenIds = Array.from(allIds).filter((id) => {
        const row = seenById.get(id);
        if (!row) return false;
        if (!row.change_seen_at) return true;
        return new Date(row.change_seen_at).getTime() < new Date(row.updated_at).getTime();
    });

    // Carried alongside reservationIds so a banner can name the specific
    // booking(s) that triggered it instead of just a bare count.
    const reservations = unseenIds.map((id) => {
        const row = seenById.get(id);
        return {
            reservation_id: id,
            reservation_number: row?.reservation_number || null,
            contact_name: row?.contact_name || null
        };
    });

    return { count: unseenIds.length, reservationIds: unseenIds, reservations };
}

export async function markReservationChangesSeen(supabase, reservationIds) {
    if (!reservationIds?.length) return;
    const { error } = await supabase
        .from('reservations')
        .update({ change_seen_at: new Date().toISOString() })
        .in('reservation_id', reservationIds);
    if (error) throw error;
}