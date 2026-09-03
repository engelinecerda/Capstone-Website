// Shared, side-effect-free helpers used by both js/account.js (the
// reservations list) and js/reservation_details.js (the standalone
// reservation detail page). Pure functions only — no DOM access, no
// module-level state, no Supabase calls. Anything that needs data beyond
// its arguments takes that data as a parameter instead of reaching into a
// page-specific state object, so it works the same regardless of which
// page fetched the data.

export const BUSINESS_TIME_ZONE = 'Asia/Manila';

export const PAYMENT_TYPE_META = {
    reservation_fee: { label: 'Reservation Fee', description: 'Fixed reservation fee' },
    down_payment: { label: 'Down Payment', description: '50% of your total amount' },
    partial_payment: { label: 'Custom Amount', description: 'Enter any amount you want to pay' },
    full_payment: { label: 'Full Payment', description: 'Settle the remaining balance in full' },
    reschedule_fee: { label: 'Reschedule Fee', description: 'Fixed fee for approved reschedule requests' }
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
    return `₱${Number(value || 0).toLocaleString()}`;
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

// Font Awesome icon name (without the fa- prefix) for status badges, for
// at-a-glance recognition alongside the existing tone colors.
export function getReservationStatusIcon(statusKey) {
    const normalizedStatus = String(statusKey || '').toLowerCase();
    if (['cancelled', 'declined'].includes(normalizedStatus)) return 'xmark';
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

export function getCancellationFee(reservation, paymentRules) {
    const isOffsite = String(reservation?.location_type || '').toLowerCase() === 'offsite';
    const key = isOffsite ? 'cancellation_fee_offsite' : 'cancellation_fee_onsite';
    const configured = Number(paymentRules?.[key]);
    if (paymentRules && Number.isFinite(configured) && configured >= 0) {
        return configured;
    }
    return isOffsite ? 2000 : 500;
}

export function getRescheduleFee(paymentRules) {
    const configured = Number(paymentRules?.reschedule_fee);
    if (paymentRules && Number.isFinite(configured) && configured >= 0) {
        return configured;
    }
    return 3000;
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
            .select('reservation_id, change_seen_at, updated_at')
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
            .select('reservation_id, change_seen_at, updated_at')
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

    return { count: unseenIds.length, reservationIds: unseenIds };
}

export async function markReservationChangesSeen(supabase, reservationIds) {
    if (!reservationIds?.length) return;
    const { error } = await supabase
        .from('reservations')
        .update({ change_seen_at: new Date().toISOString() })
        .in('reservation_id', reservationIds);
    if (error) throw error;
}