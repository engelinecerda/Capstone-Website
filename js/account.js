import { customerSupabase as supabase } from './supabase.js';
import { showFeedbackModal } from './feedback_modal.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchReceipts as fetchSharedReceipts,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    getReservationBalanceDetails as getSharedReservationBalanceDetails,
    getPaymentSummary as getSharedPaymentSummary,
    isReservationPaymentEnabled as isSharedReservationPaymentEnabled,
    loadPaymentRules,
    loadReservationRules,
    RESERVATION_RULES_DEFAULTS
} from './customer_payments.js';
import {
    fetchAvailableStartTimes,
    fetchBlackoutDates,
    fetchCalendarAvailability,
    getBookingScope as getSharedBookingScope,
    getCalendarRange,
    getScopeLabel,
    loadAdvanceNoticeRules,
    getEffectiveMinAdvanceDays,
    isOutsideBookingWindow,
} from './reservation_availability.js';
import {
    BUSINESS_TIME_ZONE,
    PAYMENT_TYPE_META,
    RESCHEDULE_STATUS_META,
    escapeHtml,
    formatCurrency,
    formatDate,
    formatDateTime,
    formatShortDate,
    formatDateKey,
    getTimeZoneNowParts,
    isDateBeforeToday,
    parseEventTimeToParts,
    getReservationEventDateTime,
    isReservationEventPast,
    getEffectiveReservationStatus,
    getReservationStatusMeta,
    getReservationStatusIcon,
    getPaymentLabel,
    getRescheduleStatusMeta,
    getReservationPackageName,
    getReservationAddOnName,
    getReservationLocationLabel,
    getCancellationFee,
    getRescheduleFee,
    getCancellationBlockReason,
    isCancellationFeeOwed,
    isRescheduleFeeOwed,
    computeContractMeta,
    computeCanReschedule,
    computeCanCancel
} from './reservation_shared.js';
import { loadPolicyBodies, renderPolicyText } from './policy_text.js';
import { initAutoRefresh } from './auto_refresh.js';

const PAYMENT_METHODS = {
    card: {
        label: 'Card',
        helper: 'Use the owner-provided debit or credit card payment arrangement, then submit the payment reference and proof here for review.',
        channel: {
            title: 'Owner Card Arrangement',
            lines: ['Account Holder: ELI Coffee Events', 'Channel: Card terminal or payment link', 'Reference: Use the reference number given by the owner/admin']
        }
    },
    bancnet: {
        label: 'BancNet',
        helper: 'Submit your transfer reference number and upload a clear screenshot or receipt.',
        channel: {
            title: 'Owner Bank Account',
            lines: ['Bank: BDO Unibank', 'Account Name: ELI Coffee Events', 'Account Number: 1234 5678 9012']
        }
    },
    gcash_maya: {
        label: 'GCash/Maya',
        helper: 'Use your e-wallet reference number and upload your payment proof for admin review.',
        channel: {
            title: 'Owner E-Wallet Channel',
            lines: ['GCash Name: ELI Coffee Events', 'GCash Number: 0917 123 4567', 'Maya Username: elicoffeeevents']
        }
    },
    cash: {
        label: 'Cash',
        helper: 'Schedule the date you will visit the cafe to pay in person. Admin will still confirm the payment manually.'
    }
};

const ONSITE_RESERVATION_FEE = 999;
const RESERVATIONS_PAGE_SIZE = 5;

const PAYMENT_STATUS_META = {
    pending_review: { label: 'Pending Review', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' }
};

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
    window.location.href = '/login.html';
}

const user = session.user;
const reservationsList = document.getElementById('reservations-list');
const paymentsList = document.getElementById('payments-list');
const receiptModalBackdrop = document.getElementById('receipt-modal-backdrop');
const receiptModalClose = document.getElementById('receipt-modal-close');
const receiptModalDismiss = document.getElementById('receipt-modal-dismiss');
const receiptView = document.getElementById('receipt-view');
const rescheduleModalBackdrop = document.getElementById('reschedule-modal-backdrop');
const rescheduleModalClose = document.getElementById('reschedule-modal-close');
const rescheduleModalCancel = document.getElementById('reschedule-modal-cancel');
const rescheduleModalSubmit = document.getElementById('reschedule-modal-submit');
const rescheduleModalMessage = document.getElementById('reschedule-modal-message');
const rescheduleCurrentValue = document.getElementById('reschedule-current-value');
const rescheduleMonthLabel = document.getElementById('reschedule-month-label');
const rescheduleCalendarGrid = document.getElementById('reschedule-calendar-grid');
const rescheduleTimeGrid = document.getElementById('reschedule-time-grid');
const reschedulePrevMonth = document.getElementById('reschedule-prev-month');
const rescheduleNextMonth = document.getElementById('reschedule-next-month');
const cancelReservationBackdrop = document.getElementById('cancel-reservation-backdrop');
const cancelModalClose = document.getElementById('cancel-modal-close');
const cancelModalDismiss = document.getElementById('cancel-modal-dismiss');
const cancelModalConfirm = document.getElementById('cancel-modal-confirm');
const cancelModalMessage = document.getElementById('cancel-modal-message');
const cancelFeeAmount = document.getElementById('cancel-fee-amount');
const cancelReasonInput = document.getElementById('cancel-reason-input');
const submissionFeedbackBackdrop = document.getElementById('submission-feedback-backdrop');
const submissionFeedbackClose = document.getElementById('submission-feedback-close');
const submissionFeedbackDismiss = document.getElementById('submission-feedback-dismiss');
const submissionFeedbackEyebrow = document.getElementById('submission-feedback-eyebrow');
const submissionFeedbackTitle = document.getElementById('submission-feedback-title');
const submissionFeedbackCopy = document.getElementById('submission-feedback-copy');

const state = {
    reservations: [],
    paymentRules: null,
    reservationRules: null,
    policyBodies: null,
    contractsByReservationId: {},
    paymentsByReservationId: {},
    receiptsByPaymentId: {},
    reschedulesByReservationId: {},
    reviewsByReservationId: {},
    profile: null,
    emailSecurityReady: true,
    reservationView: 'active',
    reservationPage: 1,
    receiptModalPaymentId: null,
    rescheduleModal: {
        reservationId: null,
        month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        selectedDate: '',
        selectedTime: '',
        calendarAvailability: new Map(),
        availableStartTimes: [],
        advanceNoticeRules: null,
        closedDates: new Set(),
        blackoutDateColumn: null,
        blackoutReasonColumn: null
    },
    cancelModal: {
        reservationId: null
    }
};

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function setFormMessage(element, message, tone = '') {
    if (!element) return;
    element.textContent = message;
    element.className = 'form-msg' + (tone ? ` ${tone}` : '');
}

function isMissingProfileColumnError(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column profiles.${columnName} does not exist`);
}

function isMissingColumnError(error, tableName, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column ${tableName}.${columnName} does not exist`);
}

function isMissingReviewsTableError(error) {
    const message = error?.message || '';
    return message.includes(`Could not find the table 'public.reviews'`)
        || message.includes("relation \"public.reviews\" does not exist")
        || message.includes("relation \"reviews\" does not exist");
}

function getReviewFeatureErrorMessage(error) {
    if (isMissingReviewsTableError(error)) {
        return 'The reviews feature is not fully set up in Supabase yet. Apply the review migrations in `supabase/migrations/`, then reload this page.';
    }

    return 'Something went wrong. Please try again.';
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

function getPaymentStatusMeta(status) {
    return PAYMENT_STATUS_META[String(status || 'pending_review').toLowerCase()] || PAYMENT_STATUS_META.pending_review;
}

function getReservationPayments(reservationId) {
    return state.paymentsByReservationId[reservationId] || [];
}

function getReservationReceipts(reservationId) {
    return getReservationPayments(reservationId)
        .map((payment) => ({
            payment,
            receipt: state.receiptsByPaymentId[payment.payment_id] || null
        }))
        .filter((entry) => entry.receipt && String(entry.payment.payment_status || '').toLowerCase() === 'approved')
        .sort((left, right) => new Date(right.receipt.issued_at || 0) - new Date(left.receipt.issued_at || 0));
}

function getReservationRescheduleRequests(reservationId) {
    return state.reschedulesByReservationId[reservationId] || [];
}

function getReservationReview(reservationId) {
    return state.reviewsByReservationId[reservationId] || null;
}

function getReservationContract(reservationId) {
    return state.contractsByReservationId[reservationId] || null;
}

function isReservationContractsColumnMissing(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

function getReservationContractMeta(reservationId) {
    const contract = getReservationContract(reservationId);
    return computeContractMeta(contract);
}

function isPastReservation(reservation) {
    const normalizedStatus = getEffectiveReservationStatus(reservation);

    if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
        return true;
    }

    const eventDateTime = getReservationEventDateTime(reservation);
    return eventDateTime ? eventDateTime.getTime() < Date.now() : isDateBeforeToday(reservation?.event_date);
}

function getReservationBuckets() {
    return state.reservations.reduce((groups, reservation) => {
        if (isPastReservation(reservation)) {
            groups.past.push(reservation);
        } else {
            groups.active.push(reservation);
        }
        return groups;
    }, { active: [], past: [] });
}

function getBookingScope(reservation) {
    return getSharedBookingScope(
        reservation?.location_type,
        reservation?.package?.package_name || reservation?.package_name || ''
    );
}

function getReservationDurationHours(reservation) {
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

function getEffectiveMinAdvanceDaysForReservation(reservation) {
    return getEffectiveMinAdvanceDays(state.rescheduleModal.advanceNoticeRules, reservation?.event_type);
}

function getReservationName(profile) {
    const parts = [profile.first_name, profile.middle_name, profile.last_name].filter(Boolean);
    return parts.join(' ') || profile.email || 'Customer';
}

function roundCurrency(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function getNormalPayments(reservationId) {
    return getReservationPayments(reservationId).filter((payment) => !payment.reschedule_request_id);
}

// Excludes cancellation_fee/reschedule_fee the same way public.
// reservation_payment_summary does (see 20260725_payment_ledger.sql) — a
// penalty fee isn't progress toward paying off the reservation total. An
// approved cancellation_fee row carries no reschedule_request_id, so
// without this it would inflate "amount paid" here.
const NON_BASE_PAYMENT_TYPES = new Set(['cancellation_fee', 'reschedule_fee']);

function getApprovedBasePaymentsTotal(reservationId) {
    return getNormalPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .filter((payment) => !NON_BASE_PAYMENT_TYPES.has(payment.payment_type))
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function getPendingBasePayment(reservationId) {
    return getNormalPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

// Unlike getPendingBasePayment above (deliberately base-only — see
// getAvailablePaymentOptions, where it gates NEW base payment options and
// shouldn't be blocked by an unrelated pending fee), this covers EVERY
// payment type. Use this anywhere the UI needs "what payment is the
// customer currently waiting on?" — base-only used to make a more recent
// reschedule/cancellation fee submission (or its approval) invisible to
// those displays.
function getLatestPendingPayment(reservationId) {
    return getReservationPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

function getReservationBalanceDueDate(reservation) {
    const eventDateKey = formatDateKey(reservation?.event_date);
    if (!eventDateKey) return null;

    const dueDate = new Date(`${eventDateKey}T00:00:00`);
    if (Number.isNaN(dueDate.getTime())) return null;

    const fullPaymentDays = Number(state.reservationRules?.full_payment_days ?? RESERVATION_RULES_DEFAULTS.full_payment_days);
    dueDate.setDate(dueDate.getDate() - (Number.isFinite(fullPaymentDays) ? fullPaymentDays : RESERVATION_RULES_DEFAULTS.full_payment_days));
    return dueDate;
}

function getReservationBalanceDetails(reservation) {
    const reservationId = reservation?.reservation_id;
    const totalPrice = roundCurrency(Number(reservation?.total_price || 0));
    const approvedBaseTotal = roundCurrency(getApprovedBasePaymentsTotal(reservationId));
    const remainingBalance = roundCurrency(Math.max(totalPrice - approvedBaseTotal, 0));
    const dueDate = getReservationBalanceDueDate(reservation);
    const dueDateKey = dueDate ? buildLocalDateKey(dueDate) : '';
    const dueDateLabel = dueDateKey ? formatDate(dueDateKey) : 'No due date';
    const isPastDue = Boolean(remainingBalance > 0 && dueDateKey && getTodayDateKey() > dueDateKey);
    const hasPartialPayment = approvedBaseTotal > 0 && remainingBalance > 0;

    let phaseLabel = 'Initial Payment';
    let stateLabel = 'Initial payment required';
    let toneKey = 'pending';
    let helperText = 'Choose Reservation Fee, Down Payment, or Full Payment to start this reservation.';

    if (remainingBalance <= 0) {
        phaseLabel = 'Paid in Full';
        stateLabel = 'Paid in full';
        toneKey = 'approved';
        helperText = 'All required reservation payments are already recorded.';
    } else if (hasPartialPayment) {
        phaseLabel = 'Remaining Balance';
        stateLabel = isPastDue ? 'Overdue' : 'Partially paid';
        toneKey = isPastDue ? 'rejected' : 'info';
        helperText = isPastDue
            ? `The remaining balance is past due. It should have been settled by ${dueDateLabel}.`
            : `Your reservation is confirmed. Settle the remaining balance by ${dueDateLabel}.`;
    } else if (isPastDue) {
        stateLabel = 'Overdue';
        toneKey = 'rejected';
        helperText = `Your payment should have been submitted by ${dueDateLabel}.`;
    } else if (dueDateKey) {
        helperText = `To stay on schedule, complete payment by ${dueDateLabel}.`;
    }

    return {
        totalPrice,
        approvedBaseTotal,
        remainingBalance,
        dueDate,
        dueDateKey,
        dueDateLabel,
        isPastDue,
        hasPartialPayment,
        phaseLabel,
        stateLabel,
        toneKey,
        helperText
    };
}

function getPaymentActionLabel(paymentType, reservation, amount = 0, rescheduleRequestId = '') {
    if (paymentType === 'full_payment' && !rescheduleRequestId) {
        const balance = getReservationBalanceDetails(reservation);
        if (balance.approvedBaseTotal > 0 && amount < balance.totalPrice) {
            return 'Remaining Balance';
        }
    }

    return getPaymentLabel(paymentType);
}

function buildPaymentOption(reservation, paymentType, amount, overrides = {}) {
    const displayLabel = overrides.displayLabel || getPaymentActionLabel(paymentType, reservation, amount, overrides.rescheduleRequestId || '');
    const baseDescription = PAYMENT_TYPE_META[paymentType]?.description || '';

    return {
        paymentType,
        amount,
        label: PAYMENT_TYPE_META[paymentType]?.label || displayLabel,
        displayLabel,
        description: baseDescription,
        displayDescription: overrides.displayDescription || baseDescription,
        rescheduleRequestId: overrides.rescheduleRequestId || ''
    };
}

function hasPendingOrApprovedPayment(reservationId, paymentType) {
    return getNormalPayments(reservationId).some((payment) => (
        payment.payment_type === paymentType
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
}

function getReservationFeeAmount(reservation, remainingBalance) {
    const locationType = String(reservation?.location_type || '').toLowerCase();

    if (locationType === 'onsite') {
        return roundCurrency(Math.min(ONSITE_RESERVATION_FEE, remainingBalance));
    }

    // Keep the current fallback for offsite packages until the client confirms the exact fee rule.
    return roundCurrency(Math.min(5000, remainingBalance));
}

function getAvailablePaymentOptions(reservation) {
    const reservationId = reservation.reservation_id;
    const options = [];

    // Checked before the isReservationPaymentEnabled gate below, which
    // excludes 'cancelled' on purpose (a cancelled reservation shouldn't
    // offer to pay the rest of the event balance) — but the cancellation
    // fee itself is exactly what's owed once cancelled, so it can't be
    // gated behind the same check or it would never appear.
    if (isCancellationFeeOwed(reservation, getReservationPayments(reservationId))) {
        options.push(buildPaymentOption(reservation, 'cancellation_fee', getCancellationFee(reservation, state.paymentRules), {
            displayLabel: 'Cancellation Fee',
            displayDescription: 'Required fee to finalize the cancellation of your reservation.'
        }));
    }

    if (!isSharedReservationPaymentEnabled(reservation)) {
        return options.filter((option) => option.amount > 0);
    }

    const balance = getReservationBalanceDetails(reservation);
    const totalPrice = balance.totalPrice;
    const approvedBasePayments = balance.approvedBaseTotal;
    const remainingBalance = balance.remainingBalance;
    const pendingBasePayment = getPendingBasePayment(reservationId);

    if (!pendingBasePayment && remainingBalance > 0) {
        if (approvedBasePayments > 0) {
            if (!hasPendingOrApprovedPayment(reservationId, 'full_payment')) {
                options.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, {
                    displayLabel: 'Remaining Balance',
                    displayDescription: balance.dueDateKey
                        ? `Settle the unpaid balance by ${balance.dueDateLabel}.`
                        : 'Settle the unpaid balance for this reservation.'
                }));
            }
        } else {
            if (!hasPendingOrApprovedPayment(reservationId, 'reservation_fee')) {
                options.push(buildPaymentOption(
                    reservation,
                    'reservation_fee',
                    getReservationFeeAmount(reservation, remainingBalance),
                    { displayDescription: 'Confirm your reservation with the reservation fee.' }
                ));
            }

            const downPaymentAmount = roundCurrency(Math.min(totalPrice * 0.5, remainingBalance));
            if (
                downPaymentAmount > 0
                && downPaymentAmount < remainingBalance
                && !hasPendingOrApprovedPayment(reservationId, 'down_payment')
            ) {
                options.push(buildPaymentOption(reservation, 'down_payment', downPaymentAmount, {
                    displayDescription: 'Pay 50% now to confirm the reservation and settle the rest later.'
                }));
            }

            options.push(buildPaymentOption(reservation, 'partial_payment', 0, {
                displayLabel: 'Custom Amount',
                displayDescription: 'Enter any amount you want to pay toward this reservation.'
            }));

            if (!hasPendingOrApprovedPayment(reservationId, 'full_payment')) {
                options.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, {
                    displayDescription: 'Settle the reservation in one payment.'
                }));
            }
        }
    }

    getReservationRescheduleRequests(reservationId)
        .filter((request) => String(request.status || '').toLowerCase() === 'approved_pending_payment')
        .forEach((request) => {
            const hasExistingRescheduleFee = getReservationPayments(reservationId).some((payment) => (
                String(payment.reschedule_request_id || '') === String(request.reschedule_request_id)
                && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
            ));

            if (!hasExistingRescheduleFee) {
                const rescheduleFeeAmount = getRescheduleFee(state.paymentRules);
                options.push(buildPaymentOption(reservation, 'reschedule_fee', rescheduleFeeAmount, {
                    displayDescription: `${PAYMENT_TYPE_META.reschedule_fee.description} for ${formatDate(request.requested_date)}`,
                    rescheduleRequestId: request.reschedule_request_id
                }));
            }
        });

    return options.filter((option) => option.amount > 0);
}

// Thin wrapper over the shared, single-source-of-truth implementation
// (js/customer_payments.js's getPaymentPageState/getPaymentSummary) — this
// used to be a full separate re-derivation that drifted out of sync with
// that one (twice, in two different ways) before being consolidated. Kept
// as a same-signature local wrapper so every existing call site in this
// file (getPaymentSummary(reservation)) needs no changes.
function getPaymentSummary(reservation) {
    return getSharedPaymentSummary(reservation, state.paymentsByReservationId, state.reschedulesByReservationId, {
        formatDate,
        reservationRules: state.reservationRules,
        paymentRules: state.paymentRules
    });
}

function getLatestReservationPayment(reservationId) {
    return getReservationPayments(reservationId)
        .slice()
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

function getLatestApprovedReservationPayment(reservationId) {
    return getReservationPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .slice()
        .sort((left, right) => new Date(right.verified_at || right.submitted_at || 0) - new Date(left.verified_at || left.submitted_at || 0))[0] || null;
}

function isCompletedPaymentOverview(reservation) {
    const paymentSummary = getPaymentSummary(reservation);
    const availableOptions = getAvailablePaymentOptions(reservation);
    return paymentSummary.key === 'approved' && !availableOptions.length;
}

function isPendingPaymentOverview(reservation) {
    const paymentSummary = getPaymentSummary(reservation);
    const availableOptions = getAvailablePaymentOptions(reservation);
    return paymentSummary.key === 'pending'
        && Boolean(getLatestPendingPayment(reservation.reservation_id))
        && !availableOptions.length;
}

function getTimelineTimestamp(value, fallback = Number.MAX_SAFE_INTEGER) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isNaN(timestamp) ? fallback : timestamp;
}

function getPaymentTimelineEntries(reservation) {
    const reservationId = reservation.reservation_id;
    const pendingTimelinePayment = getLatestPendingPayment(reservationId);
    const approvedPayments = getReservationPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .slice()
        .sort((left, right) => new Date(left.verified_at || left.submitted_at || 0) - new Date(right.verified_at || right.submitted_at || 0));
    const receipts = getReservationReceipts(reservationId);
    const entries = [];

    entries.push({
        key: 'default',
        title: 'Reservation Created',
        meta: formatShortDate(reservation.created_at || reservation.event_date),
        note: 'Reservation recorded in the system',
        sortTimestamp: getTimelineTimestamp(reservation.created_at || reservation.event_date),
        sortOrder: 10
    });

    const firstBaseApproval = approvedPayments.find((payment) => !payment.reschedule_request_id);
    if (firstBaseApproval) {
        entries.push({
            key: 'approved',
            title: 'Reservation Confirmed',
            meta: formatShortDate(firstBaseApproval.verified_at || firstBaseApproval.submitted_at),
            note: `${getPaymentLabel(firstBaseApproval.payment_type)} approved`,
            sortTimestamp: getTimelineTimestamp(firstBaseApproval.verified_at || firstBaseApproval.submitted_at),
            sortOrder: 20
        });
    }

    if (pendingTimelinePayment) {
        const pendingTimestamp = getTimelineTimestamp(pendingTimelinePayment.submitted_at);
        entries.push({
            key: 'pending',
            title: `${getPaymentLabel(pendingTimelinePayment.payment_type)} Submitted`,
            meta: formatShortDate(pendingTimelinePayment.submitted_at),
            note: `${formatCurrency(pendingTimelinePayment.amount)} / ${PAYMENT_METHODS[pendingTimelinePayment.payment_method]?.label || pendingTimelinePayment.payment_method} / awaiting admin review`,
            proofUrl: pendingTimelinePayment.proof_url || '',
            sortTimestamp: pendingTimestamp,
            sortOrder: 30
        });
        entries.push({
            key: 'info',
            title: 'Awaiting Approval',
            meta: 'Pending',
            note: 'The admin still needs to approve the latest submission before the payment step can continue.',
            sortTimestamp: pendingTimestamp,
            sortOrder: 31
        });
        entries.push({
            key: 'default',
            title: 'Receipt Generation',
            meta: 'Next step',
            note: 'A receipt will appear here automatically once the submitted payment is approved.',
            sortTimestamp: pendingTimestamp,
            sortOrder: 32
        });
    }

    approvedPayments.forEach((payment) => {
        entries.push({
            key: 'approved',
            title: getPaymentLabel(payment.payment_type),
            meta: `Approved ${formatShortDate(payment.verified_at || payment.submitted_at)}`,
            note: `${formatCurrency(payment.amount)} / ${PAYMENT_METHODS[payment.payment_method]?.label || payment.payment_method}`,
            sortTimestamp: getTimelineTimestamp(payment.verified_at || payment.submitted_at),
            sortOrder: 40
        });
    });

    receipts.forEach(({ payment, receipt }) => {
        entries.push({
            key: 'info',
            title: 'Receipt Generated',
            meta: formatShortDate(receipt.issued_at),
            note: `${getPaymentLabel(payment.payment_type)} acknowledgement receipt available`,
            paymentId: payment.payment_id,
            reservationId,
            sortTimestamp: getTimelineTimestamp(receipt.issued_at),
            sortOrder: 50
        });
    });

    return entries
        .sort((left, right) => {
            if (left.sortTimestamp !== right.sortTimestamp) {
                return left.sortTimestamp - right.sortTimestamp;
            }
            return (left.sortOrder || 0) - (right.sortOrder || 0);
        })
        .map(({ sortTimestamp, sortOrder, ...entry }) => entry);
}

function renderPaymentTimeline(reservation) {
    const entries = getPaymentTimelineEntries(reservation);
    if (!entries.length) {
        return '<div class="payment-empty">Timeline details will appear as payment steps are approved.</div>';
    }

    return `
        <div class="payment-timeline-list">
            ${entries.map((entry) => `
                <div class="payment-timeline-item">
                    <span class="payment-timeline-dot ${escapeHtml(entry.key)}" aria-hidden="true"></span>
                    <div class="payment-timeline-main">
                        <div class="payment-timeline-title-row">
                            <strong class="payment-timeline-title">${escapeHtml(entry.title)}</strong>
                            <span class="payment-timeline-meta">${escapeHtml(entry.meta)}</span>
                        </div>
                        <div class="payment-timeline-note">${escapeHtml(entry.note)}</div>
                    </div>
                    ${entry.paymentId ? `
                        <button
                            type="button"
                            class="res-link-btn view-receipt-btn"
                            data-reservation-id="${escapeHtml(entry.reservationId)}"
                            data-payment-id="${escapeHtml(entry.paymentId)}"
                        >
                            View Receipt
                        </button>
                    ` : entry.proofUrl ? `
                        <a
                            class="res-link-btn"
                            href="${escapeHtml(entry.proofUrl)}"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            View Proof
                        </a>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function getPaymentNextStepCopy(reservation, paymentSummary, paymentModuleEnabled, hasPayments) {
    const summaryKey = String(paymentSummary?.key || '').toLowerCase();
    const summaryLabel = String(paymentSummary?.label || '').toLowerCase();
    const balance = getReservationBalanceDetails(reservation);

    if (!paymentModuleEnabled) {
        return 'Wait for admin approval. The payment step will unlock here once your reservation is approved.';
    }

    if (summaryKey === 'approved' && summaryLabel.includes('paid in full')) {
        return 'Payment is complete. Open the Payments module if you want to review the submitted details or receipt.';
    }

    if (summaryKey === 'pending' && hasPayments) {
        return summaryLabel.includes('remaining balance')
            ? 'Your remaining balance submission is under review. Once approved, this reservation will show as fully paid.'
            : 'Your payment submission is under review. Wait for admin confirmation before sending another reservation payment.';
    }

    if (balance.hasPartialPayment) {
        return balance.isPastDue
            ? `Your reservation is confirmed, but the remaining balance is overdue. Please settle it immediately.`
            : `Your reservation is confirmed. The remaining balance must be settled by ${balance.dueDateLabel}.`;
    }

    if (summaryKey === 'info') {
        return 'The next step is paying the approved reschedule fee. Open the Payments module to submit it.';
    }

    return hasPayments
        ? 'Open the Payments module to continue this reservation payment and review your submitted entries.'
        : 'Choose an initial payment to confirm this reservation. Reservation Fee, Down Payment, or Full Payment are all accepted.';
}

function canRescheduleReservation(reservation) {
    return computeCanReschedule(reservation.status, getReservationRescheduleRequests(reservation.reservation_id));
}

function canCancelReservation(reservation) {
    return computeCanCancel(reservation?.status, getReservationPayments(reservation.reservation_id), reservation, state.paymentRules);
}

// Submission itself now happens on the dedicated /payment.html page (same
// DB-driven method list + payment_type pricing used everywhere else) —
// this only decides whether to show a "go pay" CTA or an empty-state
// message, reusing the same option/gating helpers the rest of this file's
// status displays already depend on.
function renderPaymentComposer(reservation) {
    const options = getAvailablePaymentOptions(reservation);
    if (!options.length) {
        if (!isSharedReservationPaymentEnabled(reservation)) {
            return '<div class="payment-empty">Payment submission becomes available after admin approves this reservation.</div>';
        }
        const waitingMessage = getLatestPendingPayment(reservation.reservation_id)
            ? 'Your latest reservation payment is still pending admin review.'
            : 'No new payment actions are available right now.';
        return `<div class="payment-empty">${escapeHtml(waitingMessage)}</div>`;
    }

    const balance = getReservationBalanceDetails(reservation);
    const isCancellationApproved = isCancellationFeeOwed(reservation, getReservationPayments(reservation.reservation_id));
    const actionIntro = isCancellationApproved
        ? 'Your reservation is cancelled. Pay the cancellation fee to settle your balance.'
        : (balance.hasPartialPayment
            ? `This reservation is already confirmed. Settle the remaining balance by ${balance.dueDateLabel}.`
            : 'Choose the payment that works for you to confirm this reservation.');

    return `
        <div class="payment-composer-cta">
            <p class="payment-flow-intro">${escapeHtml(actionIntro)}</p>
            <a class="res-primary-btn" href="${escapeHtml(buildCustomerPaymentUrl(reservation.reservation_id))}">Go to payment page</a>
        </div>
    `;
}

function renderPaymentStatusContext(reservation) {
    const paymentSummary = getPaymentSummary(reservation);
    const paymentEntries = getReservationPayments(reservation.reservation_id);
    const paymentModuleEnabled = isSharedReservationPaymentEnabled(reservation) || paymentEntries.length > 0;
    const nextStepCopy = getPaymentNextStepCopy(reservation, paymentSummary, paymentModuleEnabled, paymentEntries.length > 0);
    const availableOptions = getAvailablePaymentOptions(reservation);
    const balance = getReservationBalanceDetails(reservation);
    const nextPayment = availableOptions[0] || null;
    const latestPayment = getLatestReservationPayment(reservation.reservation_id);
    const latestReceipt = getReservationReceipts(reservation.reservation_id)[0] || null;

    const nextActionCopy = nextPayment
        ? `${nextPayment.displayLabel || nextPayment.label} is the next action available in this reservation.`
        : (paymentSummary.key === 'approved' ? 'All required payments are already recorded.' : 'No payment action is available yet.');

    const latestSubmissionTitle = latestPayment
        ? getPaymentActionLabel(latestPayment.payment_type, reservation, Number(latestPayment.amount || 0), latestPayment.reschedule_request_id || '')
        : 'No payment submitted yet';
    const latestSubmissionCopy = latestPayment
        ? `${formatCurrency(latestPayment.amount)}${latestPayment.submitted_at ? ` submitted ${formatShortDate(latestPayment.submitted_at)}` : ''}`
        : 'Your first submission will appear here after you send a payment.';

    const receiptTitle = latestReceipt
        ? formatShortDate(latestReceipt.receipt?.issued_at)
        : 'No receipt yet';
    const receiptCopy = latestReceipt
        ? `${formatCurrency(latestReceipt.payment?.amount)} acknowledgement receipt available`
        : 'Receipts appear after admin approves a payment.';

    return `
        <div class="payment-status-header">
            <div class="payment-status-heading">
                <div class="res-section-title">Payment Status</div>
                <div class="res-section-copy">Current state and the next step for this reservation.</div>
            </div>
            <span class="res-section-status ${escapeHtml(paymentSummary.key)}">${escapeHtml(paymentSummary.label)}</span>
        </div>
        <p class="payment-status-explainer">${escapeHtml(nextStepCopy)}</p>
        <div class="payment-status-grid">
            <div class="payment-status-card">
                <span class="payment-status-label">Total Amount</span>
                <strong class="payment-status-value">${escapeHtml(formatCurrency(balance.totalPrice))}</strong>
                <span class="payment-status-note">The full reservation amount recorded in the system.</span>
            </div>
            <div class="payment-status-card">
                <span class="payment-status-label">Approved Payments</span>
                <strong class="payment-status-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                <span class="payment-status-note">${escapeHtml(balance.remainingBalance <= 0 ? 'Everything required has already been approved.' : 'Only admin-approved payments reduce your remaining balance.')}</span>
            </div>
            <div class="payment-status-card">
                <span class="payment-status-label">${escapeHtml(balance.phaseLabel)}</span>
                <strong class="payment-status-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Paid' : formatCurrency(balance.remainingBalance))}</strong>
                <span class="payment-status-note">${escapeHtml(nextActionCopy)}</span>
            </div>
            <div class="payment-status-card">
                <span class="payment-status-label">Pay By</span>
                <strong class="payment-status-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)}</strong>
                <span class="payment-status-note">${escapeHtml(balance.helperText)}</span>
            </div>
            <div class="payment-status-card">
                <span class="payment-status-label">Latest submission</span>
                <strong class="payment-status-value">${escapeHtml(latestSubmissionTitle)}</strong>
                <span class="payment-status-note">${escapeHtml(latestSubmissionCopy)}</span>
            </div>
            <div class="payment-status-card">
                <span class="payment-status-label">Latest receipt</span>
                <strong class="payment-status-value">${escapeHtml(receiptTitle)}</strong>
                <span class="payment-status-note">${escapeHtml(receiptCopy)}</span>
            </div>
        </div>
    `;
}

function renderPaymentHistory(reservation) {
    const payments = getReservationPayments(reservation.reservation_id)
        .slice()
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0));

    if (!payments.length) {
        return '<div class="payment-empty">No payment submissions yet.</div>';
    }

    return `
        <div class="payment-history-list">
            ${payments.map((payment) => {
                const paymentStatus = getPaymentStatusMeta(payment.payment_status);
                const metadata = [
                    formatCurrency(payment.amount),
                    PAYMENT_METHODS[payment.payment_method]?.label || payment.payment_method,
                    payment.submitted_at ? `Submitted ${formatShortDate(payment.submitted_at)}` : 'Submitted'
                ].filter(Boolean).join(' / ');

                const proofLink = payment.proof_url
                    ? `<a class="res-link-btn" href="${escapeHtml(payment.proof_url)}" target="_blank" rel="noopener noreferrer">View Proof</a>`
                    : '';

                return `
                    <div class="payment-history-item">
                        <div class="payment-history-main">
                            <div class="payment-history-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                            <div class="payment-history-meta">${escapeHtml(metadata)}</div>
                        </div>
                        <div class="payment-history-actions">
                            <span class="res-section-status ${escapeHtml(paymentStatus.key)}">${escapeHtml(paymentStatus.label)}</span>
                            ${proofLink}
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderReceiptHistory(reservation) {
    const receipts = getReservationReceipts(reservation.reservation_id);
    if (!receipts.length) {
        return '<div class="receipt-empty">No receipts yet.</div>';
    }

    return `
        <div class="receipt-history-list">
            ${receipts.map(({ payment, receipt }) => `
                <div class="receipt-history-item">
                        <div class="receipt-history-main">
                            <div class="receipt-history-title">${escapeHtml(getPaymentLabel(payment.payment_type))}</div>
                            <div class="receipt-history-meta">${escapeHtml(formatShortDate(receipt.issued_at))} / ${escapeHtml(formatCurrency(payment.amount))}</div>
                        </div>
                    <div class="receipt-history-actions">
                        <button
                            type="button"
                            class="res-link-btn view-receipt-btn"
                            data-reservation-id="${escapeHtml(reservation.reservation_id)}"
                            data-payment-id="${escapeHtml(payment.payment_id)}"
                        >
                            View Receipt
                        </button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderPaymentReferenceTabs(reservation, options = {}) {
    const paymentCount = getReservationPayments(reservation.reservation_id).length;
    const receiptCount = getReservationReceipts(reservation.reservation_id).length;
    const includeTimeline = Boolean(options.includeTimeline);
    const timelineCount = getPaymentTimelineEntries(reservation).length;

    return `
        <div class="payment-reference-shell">
            <div class="payment-reference-tabs" role="tablist" aria-label="Payment reference sections">
                <button
                    type="button"
                    class="payment-reference-tab active"
                    data-payment-panel-tab="history"
                    aria-selected="true"
                >
                    Payment History <span>${escapeHtml(String(paymentCount))}</span>
                </button>
                <button
                    type="button"
                    class="payment-reference-tab"
                    data-payment-panel-tab="receipts"
                    aria-selected="false"
                >
                    Receipts <span>${escapeHtml(String(receiptCount))}</span>
                </button>
                ${includeTimeline ? `
                    <button
                        type="button"
                        class="payment-reference-tab"
                        data-payment-panel-tab="timeline"
                        aria-selected="false"
                    >
                        Status Timeline <span>${escapeHtml(String(timelineCount))}</span>
                    </button>
                ` : ''}
            </div>
            <div class="payment-reference-panel active" data-payment-panel="history">
                ${renderPaymentHistory(reservation)}
            </div>
            <div class="payment-reference-panel" data-payment-panel="receipts" hidden>
                ${renderReceiptHistory(reservation)}
            </div>
            ${includeTimeline ? `
                <div class="payment-reference-panel" data-payment-panel="timeline" hidden>
                    ${renderPaymentTimeline(reservation)}
                </div>
            ` : ''}
        </div>
    `;
}

function renderRescheduleSection(reservation) {
    const latestRequest = getReservationRescheduleRequests(reservation.reservation_id)[0] || null;
    const canReschedule = canRescheduleReservation(reservation);

    if (!latestRequest && !canReschedule) {
        return '<div class="payment-empty">Reschedule is not available for this reservation right now.</div>';
    }

    const summaryRows = latestRequest ? `
        <div class="reschedule-summary">
            <div class="reschedule-summary-row"><strong>Current:</strong> ${escapeHtml(formatDate(reservation.event_date))} at ${escapeHtml(reservation.event_time || 'No time')}</div>
            <div class="reschedule-summary-row"><strong>Requested:</strong> ${escapeHtml(formatDate(latestRequest.requested_date))} at ${escapeHtml(latestRequest.requested_time || 'No time')}</div>
        </div>
    ` : '';

    const statusMeta = latestRequest ? getRescheduleStatusMeta(latestRequest.status) : null;
    const statusBadge = statusMeta
        ? `<span class="res-section-status ${escapeHtml(statusMeta.key)}">${escapeHtml(statusMeta.label)}</span>`
        : '';

    const buttonLabel = latestRequest && String(latestRequest.status || '').toLowerCase() === 'rejected'
        ? 'Submit New Reschedule Request'
        : 'Request Reschedule';

    return `
        <div class="res-section-head">
            <div>
                <div class="res-section-title">Reschedule Request</div>
                <div class="res-section-copy">Choose a new available date first, then pay the reschedule fee to finalize it.</div>
            </div>
            ${statusBadge}
        </div>
        ${summaryRows}
        ${canReschedule ? `<button type="button" class="res-secondary-btn open-reschedule-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">${escapeHtml(buttonLabel)}</button>` : ''}
    `;
}

function renderCompletedPaymentOverview(reservation) {
    const balance = getReservationBalanceDetails(reservation);
    const latestApprovedPayment = getLatestApprovedReservationPayment(reservation.reservation_id);
    const latestReceiptEntry = getReservationReceipts(reservation.reservation_id)[0] || null;
    const latestReceipt = latestReceiptEntry?.receipt || null;
    const latestProofUrl = latestApprovedPayment?.proof_url || '';
    const latestPaymentCopy = latestApprovedPayment
        ? `${getPaymentLabel(latestApprovedPayment.payment_type)} / ${formatShortDate(latestApprovedPayment.verified_at || latestApprovedPayment.submitted_at)}`
        : 'No approved payment yet';
    const latestReceiptCopy = latestReceipt
        ? `${formatShortDate(latestReceipt.issued_at)} acknowledgement receipt available`
        : 'Receipt will appear after admin approval';

    return `
        <div class="payment-overview-layout">
            <div class="payment-overview-main">
                <section class="payment-complete-card">
                    <div class="payment-complete-header">
                        <div class="payment-complete-icon" aria-hidden="true">&#10003;</div>
                        <div class="payment-complete-copy">
                            <div class="payment-complete-title">Payment Completed</div>
                            <p class="payment-complete-text">All required payments for this reservation have already been approved and recorded.</p>
                            <p class="payment-complete-subtext">Thank you. Your reservation is fully paid and your records remain available below.</p>
                        </div>
                    </div>
                    <div class="payment-complete-stats">
                        <div class="payment-complete-stat">
                            <span class="payment-complete-label">Total Amount</span>
                            <strong class="payment-complete-value">${escapeHtml(formatCurrency(balance.totalPrice))}</strong>
                            <span class="payment-complete-note">Reservation total</span>
                        </div>
                        <div class="payment-complete-stat">
                            <span class="payment-complete-label">Approved Payments</span>
                            <strong class="payment-complete-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                            <span class="payment-complete-note">Total approved</span>
                        </div>
                        <div class="payment-complete-stat">
                            <span class="payment-complete-label">Remaining Balance</span>
                            <strong class="payment-complete-value approved">${escapeHtml(formatCurrency(0))}</strong>
                            <span class="payment-complete-note">All paid</span>
                        </div>
                        <div class="payment-complete-stat">
                            <span class="payment-complete-label">Latest Receipt</span>
                            <strong class="payment-complete-value">${escapeHtml(latestReceipt ? formatShortDate(latestReceipt.issued_at) : 'No receipt')}</strong>
                            <span class="payment-complete-note">${escapeHtml(latestReceiptCopy)}</span>
                        </div>
                    </div>
                    <div class="payment-complete-actions">
                        ${latestReceiptEntry ? `
                            <button
                                type="button"
                                class="res-secondary-btn view-receipt-btn"
                                data-reservation-id="${escapeHtml(reservation.reservation_id)}"
                                data-payment-id="${escapeHtml(latestReceiptEntry.payment.payment_id)}"
                            >
                                View Latest Receipt
                            </button>
                        ` : ''}
                        ${latestProofUrl ? `
                            <a
                                class="res-link-btn"
                                href="${escapeHtml(latestProofUrl)}"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                View Latest Proof
                            </a>
                        ` : ''}
                    </div>
                </section>

                <section class="payment-records-board">
                    <div class="res-section-head">
                        <div>
                            <div class="res-section-title">Payment Records</div>
                            <div class="res-section-copy">History, receipts, and the status timeline stay in the main content area once payment is complete.</div>
                        </div>
                    </div>
                    ${renderPaymentReferenceTabs(reservation, { includeTimeline: true })}
                </section>
            </div>

            <aside class="payment-overview-side">
                <section class="payment-side-card payment-side-summary-card">
                    <div class="payment-side-summary-head">
                        <div>
                            <div class="res-section-title">Payment Status</div>
                            <div class="res-section-copy">A compact summary for this completed reservation.</div>
                        </div>
                        <span class="res-section-status approved">Paid in full</span>
                    </div>
                    <div class="payment-side-summary-list">
                        <div class="payment-side-summary-row">
                            <span>Total Amount</span>
                            <strong>${escapeHtml(formatCurrency(balance.totalPrice))}</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Approved Payments</span>
                            <strong>${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Remaining Balance</span>
                            <strong class="approved">${escapeHtml(formatCurrency(0))}</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Status</span>
                            <strong class="approved">Paid in full</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Pay By</span>
                            <strong>Completed</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Latest Submission</span>
                            <strong>${escapeHtml(latestPaymentCopy)}</strong>
                        </div>
                        <div class="payment-side-summary-row">
                            <span>Latest Receipt</span>
                            <strong>${escapeHtml(latestReceipt ? formatShortDate(latestReceipt.issued_at) : 'No receipt')}</strong>
                        </div>
                    </div>
                </section>
            </aside>
        </div>
    `;
}

function renderPendingPaymentOverview(reservation) {
    const balance = getReservationBalanceDetails(reservation);
    // getLatestPendingPayment(), not the base-only getPendingBasePayment()
    // — that made a more recent reschedule/cancellation fee submission
    // invisible here, showing an unrelated older base payment's amount
    // and status instead of the fee actually just paid.
    const pendingPayment = getLatestPendingPayment(reservation.reservation_id) || getLatestReservationPayment(reservation.reservation_id);
    const pendingStatus = getPaymentStatusMeta(pendingPayment?.payment_status || 'pending_review');
    const paymentLabel = pendingPayment ? getPaymentLabel(pendingPayment.payment_type) : 'Payment';
    const paymentMethod = pendingPayment
        ? (PAYMENT_METHODS[pendingPayment.payment_method]?.label || pendingPayment.payment_method || 'Payment method not provided')
        : 'Payment details unavailable';
    const latestReceiptEntry = getReservationReceipts(reservation.reservation_id)[0] || null;
    const referenceValue = pendingPayment?.reference_number ? pendingPayment.reference_number : 'Not provided';
    const nextStepCopy = balance.hasPartialPayment
        ? `Once this ${paymentLabel.toLowerCase()} is approved, your remaining balance summary will refresh automatically.`
        : 'Once this payment is approved, the reservation will continue to the next payment stage automatically.';
    const bannerTitle = paymentLabel.toLowerCase().includes('remaining balance')
        ? 'Remaining Balance Under Review'
        : 'Payment Under Review';
    const bannerCopy = pendingPayment
        ? `Your ${paymentLabel.toLowerCase()} has been submitted and is currently under admin review. You will be notified once it is approved.`
        : 'Your latest payment submission is currently under admin review.';

    return `
        <div class="payment-review-layout">
            <section class="payment-review-banner">
                <div class="payment-review-banner-head">
                    <div class="payment-review-banner-icon" aria-hidden="true">&#9711;</div>
                    <div class="payment-review-banner-copy">
                        <div class="payment-review-banner-title">${escapeHtml(bannerTitle)}</div>
                        <p class="payment-review-banner-text">${escapeHtml(bannerCopy)}</p>
                        <p class="payment-review-banner-subtext">${escapeHtml(nextStepCopy)}</p>
                    </div>
                    <span class="res-section-status ${escapeHtml(pendingStatus.key)}">${escapeHtml(pendingStatus.label)}</span>
                </div>
                <div class="payment-review-summary-grid">
                    <div class="payment-review-summary-card">
                        <span class="payment-review-summary-label">Total Amount</span>
                        <strong class="payment-review-summary-value">${escapeHtml(formatCurrency(balance.totalPrice))}</strong>
                        <span class="payment-review-summary-note">Reservation total</span>
                    </div>
                    <div class="payment-review-summary-card">
                        <span class="payment-review-summary-label">Approved Payments</span>
                        <strong class="payment-review-summary-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                        <span class="payment-review-summary-note">Only approved payments reduce the balance</span>
                    </div>
                    <div class="payment-review-summary-card">
                        <span class="payment-review-summary-label">Next Payment</span>
                        <strong class="payment-review-summary-value">${escapeHtml(pendingPayment ? formatCurrency(pendingPayment.amount) : formatCurrency(balance.remainingBalance))}</strong>
                        <span class="payment-review-summary-note">${escapeHtml(paymentLabel)}</span>
                    </div>
                    <div class="payment-review-summary-card">
                        <span class="payment-review-summary-label">Pay By</span>
                        <strong class="payment-review-summary-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)}</strong>
                        <span class="payment-review-summary-note">${escapeHtml(balance.helperText)}</span>
                    </div>
                </div>
            </section>

            <section class="payment-latest-submission-card">
                <div class="payment-latest-submission-head">
                    <div>
                        <div class="res-section-title">Latest Submission</div>
                        <div class="res-section-copy">This is the payment currently being reviewed by the admin.</div>
                    </div>
                    <span class="res-section-status ${escapeHtml(pendingStatus.key)}">${escapeHtml(pendingStatus.label)}</span>
                </div>
                <div class="payment-latest-submission-body">
                    <div class="payment-latest-submission-main">
                        <div class="payment-latest-submission-title">${escapeHtml(paymentLabel)}</div>
                        <div class="payment-latest-submission-meta">
                            ${escapeHtml(formatCurrency(pendingPayment?.amount || 0))} / ${escapeHtml(paymentMethod)} / ${escapeHtml(pendingPayment?.submitted_at ? `Submitted ${formatShortDate(pendingPayment.submitted_at)}` : 'Submission recorded')}
                        </div>
                    </div>
                    <div class="payment-latest-submission-details">
                        <div class="payment-latest-detail">
                            <span>Reference Number</span>
                            <strong>${escapeHtml(referenceValue)}</strong>
                        </div>
                        <div class="payment-latest-detail">
                            <span>Latest Receipt</span>
                            <strong>${escapeHtml(latestReceiptEntry ? formatShortDate(latestReceiptEntry.receipt.issued_at) : 'Not available yet')}</strong>
                        </div>
                        <div class="payment-latest-detail">
                            <span>What Happens Next</span>
                            <strong>${escapeHtml('Wait for admin approval')}</strong>
                        </div>
                    </div>
                </div>
                <div class="payment-latest-submission-actions">
                    ${pendingPayment?.proof_url ? `
                        <a
                            class="res-link-btn"
                            href="${escapeHtml(pendingPayment.proof_url)}"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            View Proof
                        </a>
                    ` : ''}
                </div>
            </section>

            <section class="payment-records-board">
                <div class="res-section-head">
                    <div>
                        <div class="res-section-title">Payment Records</div>
                        <div class="res-section-copy">Status, history, receipts, and the timeline stay in the main content while this payment is under review.</div>
                    </div>
                </div>
                ${renderPaymentReferenceTabs(reservation, { includeTimeline: true })}
            </section>
        </div>
    `;
}

function getReservationCardTone(statusKey, isPaymentEnabled, remainingBalance, feeOwed = false) {
    if (['cancelled', 'declined'].includes(statusKey)) return 'rejected';
    if (feeOwed || (isPaymentEnabled && remainingBalance > 0)) return 'payment-required';
    if (['approved', 'confirmed', 'rescheduled', 'completed'].includes(statusKey)) return 'approved';
    return 'pending';
}

function buildReservationCard(reservation, view) {
    const balance = getSharedReservationBalanceDetails(reservation, state.paymentsByReservationId, { formatDate });
    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation, balance.remainingBalance));
    const packageName = getReservationPackageName(reservation);
    const location = getReservationLocationLabel(reservation);
    // Not just balance.remainingBalance > 0 — that only reflects the base
    // reservation total, excluding reschedule_fee/cancellation_fee (by
    // design, see getReservationBalanceDetails). A fully-paid reservation
    // with an owed fee had remainingBalance <= 0 and so no "Continue
    // Payment" entry point at all, even though a fee genuinely needed
    // paying. getAvailablePaymentOptions() already enumerates all three
    // (base balance, reschedule fee, cancellation fee) correctly.
    const paymentIsActionable = getAvailablePaymentOptions(reservation).length > 0;
    const cancellationFeeOwed = isCancellationFeeOwed(reservation, getReservationPayments(reservation.reservation_id));
    const rescheduleFeeOwed = isRescheduleFeeOwed(getReservationRescheduleRequests(reservation.reservation_id), getReservationPayments(reservation.reservation_id));
    const review = view === 'past' ? getReservationReview(reservation.reservation_id) : null;
    const cardTone = getReservationCardTone(reservationStatus.key, isSharedReservationPaymentEnabled(reservation), balance.remainingBalance, cancellationFeeOwed || rescheduleFeeOwed);
    const statusIcon = getReservationStatusIcon(reservationStatus.key);

    const detailsUrl = `reservation-details.html?reservation_id=${encodeURIComponent(reservation.reservation_id)}`;

    return `
        <article class="reservation-summary-card tone-${escapeHtml(cardTone)}${view === 'past' ? ' past' : ''}">
            <div class="reservation-card-header">
                <div class="reservation-card-header-left">
                    <div class="reservation-card-title-row">
                        <h3>${escapeHtml(reservation.event_type || 'Event')}</h3>
                        <span class="res-status ${escapeHtml(reservationStatus.key)}"><i class="fa-solid fa-${escapeHtml(statusIcon)}" aria-hidden="true"></i> ${escapeHtml(reservationStatus.label)}</span>
                    </div>
                    <p class="reservation-card-subline">${escapeHtml(packageName)} &middot; ${escapeHtml(reservation.reservation_number || '—')}</p>
                </div>
                <div class="reservation-card-header-right">
                    <span class="reservation-total-label">Total</span>
                    <strong class="reservation-total-value">${escapeHtml(formatCurrency(reservation.total_price))}</strong>
                </div>
            </div>

            <div class="reservation-card-meta">
                <div class="reservation-card-meta-item">
                    <i class="fa-solid fa-calendar" aria-hidden="true"></i>
                    <span>${escapeHtml(formatShortDate(reservation.event_date))}</span>
                </div>
                <div class="reservation-card-meta-item">
                    <i class="fa-solid fa-clock" aria-hidden="true"></i>
                    <span>${escapeHtml(reservation.event_time || 'No time selected')}</span>
                </div>
                <div class="reservation-card-meta-item">
                    <i class="fa-solid fa-users" aria-hidden="true"></i>
                    <span>${escapeHtml(String(reservation.guest_count || 0))} Guests</span>
                </div>
                <div class="reservation-card-meta-item">
                    <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
                    <span>${escapeHtml(location)}</span>
                </div>
            </div>

            ${paymentIsActionable ? `
                <div class="reservation-balance-line ${escapeHtml(cancellationFeeOwed || rescheduleFeeOwed ? 'pending' : balance.toneKey)}">
                    ${cancellationFeeOwed
                        ? `<strong>${escapeHtml(formatCurrency(getCancellationFee(reservation, state.paymentRules)))}</strong> cancellation fee due`
                        : (rescheduleFeeOwed
                            ? `<strong>${escapeHtml(formatCurrency(getRescheduleFee(state.paymentRules)))}</strong> reschedule fee due`
                            : `<strong>${escapeHtml(formatCurrency(balance.remainingBalance))}</strong> due by ${escapeHtml(balance.dueDateLabel)}`)
                    }
                </div>
            ` : ''}

            <div class="reservation-card-footer">
                <div class="reservation-summary-actions">
                    ${paymentIsActionable ? `
                        <button type="button" class="reservation-card-cta open-payments-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Continue Payment <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
                    ` : ''}
                    <a class="reservation-card-cta-secondary" href="${escapeHtml(detailsUrl)}">View details <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>
                    ${review ? `<span class="reservation-reviewed-badge"><i class="fa-solid fa-check" aria-hidden="true"></i> Reviewed</span>` : ''}
                </div>
            </div>
        </article>
    `;
}

function buildReservationEmptyState(view) {
    const copy = view === 'past'
        ? {
            title: 'No past reservations yet',
            message: 'Completed and previous bookings will appear here once you have reservation history.'
        }
        : {
            title: 'No active reservations yet',
            message: 'Upcoming and in-progress bookings will appear here after you make a reservation.'
        };

    return `
        <div class="empty-state reservation-empty-state">
            <span class="reservation-eyebrow">Reservations</span>
            <h3>${copy.title}</h3>
            <p>${copy.message}</p>
            ${view === 'active' ? '<a href="/reservations.html" class="res-book-btn">Book an Event</a>' : ''}
        </div>
    `;
}

function renderReservations() {
    if (!reservationsList) return;

    if (!state.reservations.length) {
        reservationsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">No reservations yet</div>
                <h3>No reservations yet</h3>
                <p>You haven't made any bookings yet. When you do, they'll appear here.</p>
                <a href="/reservations.html" class="res-book-btn">Book an Event</a>
            </div>
        `;
        return;
    }

    const { active, past } = getReservationBuckets();
    const currentView = state.reservationView === 'past' ? 'past' : 'active';
    const currentReservations = currentView === 'past' ? past : active;

    const totalPages = Math.max(1, Math.ceil(currentReservations.length / RESERVATIONS_PAGE_SIZE));
    state.reservationPage = Math.min(Math.max(1, state.reservationPage), totalPages);
    const pageStart = (state.reservationPage - 1) * RESERVATIONS_PAGE_SIZE;
    const pagedReservations = currentReservations.slice(pageStart, pageStart + RESERVATIONS_PAGE_SIZE);
    const rangeStart = pagedReservations.length ? pageStart + 1 : 0;
    const rangeEnd = pageStart + pagedReservations.length;

    const pageNumberButtons = Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNum) => `
        <button
            type="button"
            class="reservation-pagination-btn page-number ${pageNum === state.reservationPage ? 'current' : ''}"
            data-reservation-page="${pageNum}"
            ${pageNum === state.reservationPage ? 'aria-current="page"' : ''}
        >${pageNum}</button>
    `).join('');

    reservationsList.innerHTML = `
        <div class="reservation-hub">
            <div class="reservation-panel">
                <div class="reservation-toolbar">
                    <div class="reservation-toolbar-heading">
                        <h3 class="reservation-toolbar-title">My reservations</h3>
                        <p class="reservation-toolbar-caption">Showing ${rangeStart}&ndash;${rangeEnd} of ${currentReservations.length} ${escapeHtml(currentView)} reservations</p>
                    </div>
                    <div class="reservation-view-switch" role="tablist" aria-label="Reservation views">
                        <button
                            type="button"
                            class="reservation-view-tab ${currentView === 'active' ? 'active' : ''}"
                            data-reservation-view="active"
                            aria-pressed="${currentView === 'active' ? 'true' : 'false'}"
                        >
                            Active <span>${active.length}</span>
                        </button>
                        <button
                            type="button"
                            class="reservation-view-tab ${currentView === 'past' ? 'active' : ''}"
                            data-reservation-view="past"
                            aria-pressed="${currentView === 'past' ? 'true' : 'false'}"
                        >
                            Past <span>${past.length}</span>
                        </button>
                    </div>
                </div>
                <div class="reservation-panel-list">
                    ${pagedReservations.length ? pagedReservations.map((reservation) => buildReservationCard(reservation, currentView)).join('') : buildReservationEmptyState(currentView)}
                </div>
                ${totalPages > 1 ? `
                    <div class="reservation-pagination">
                        <button type="button" class="reservation-pagination-btn" data-reservation-page="prev" aria-label="Previous page" ${state.reservationPage <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                        ${pageNumberButtons}
                        <button type="button" class="reservation-pagination-btn" data-reservation-page="next" aria-label="Next page" ${state.reservationPage >= totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function buildPaymentModuleCard(reservation) {
    const paymentSummary = getPaymentSummary(reservation);
    const balance = getReservationBalanceDetails(reservation);
    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation, balance.remainingBalance));
    const contract = getReservationContract(reservation.reservation_id);
    const isCompletedOverview = isCompletedPaymentOverview(reservation);
    const isPendingOverview = isPendingPaymentOverview(reservation);
    const isOnsite = String(reservation.location_type || '').toLowerCase() === 'onsite';
    const locationLabel = isOnsite ? 'Onsite' : 'Offsite';
    const locationValue = isOnsite ? 'ELI Coffee' : (reservation.venue_location || 'Venue not provided');
    const packageName = reservation.package?.package_name || reservation.package_id || 'No package selected';
    const contentMarkup = isCompletedOverview
        ? renderCompletedPaymentOverview(reservation)
        : isPendingOverview
            ? renderPendingPaymentOverview(reservation)
            : `
                <div class="payment-progress-strip">
                    <div class="payment-progress-card">
                        <span class="payment-progress-label">Approved Payments</span>
                        <strong class="payment-progress-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                        <span class="payment-progress-note">Only approved payments count toward the reservation total.</span>
                    </div>
                    <div class="payment-progress-card">
                        <span class="payment-progress-label">Remaining Balance</span>
                        <strong class="payment-progress-value ${escapeHtml(balance.toneKey)}">${escapeHtml(balance.remainingBalance <= 0 ? 'Paid' : formatCurrency(balance.remainingBalance))}</strong>
                        <span class="payment-progress-note">${escapeHtml(balance.phaseLabel)}</span>
                    </div>
                    <div class="payment-progress-card">
                        <span class="payment-progress-label">Pay By</span>
                        <strong class="payment-progress-value ${escapeHtml(balance.isPastDue ? 'rejected' : 'neutral')}">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)}</strong>
                        <span class="payment-progress-note">${escapeHtml(balance.helperText)}</span>
                    </div>
                </div>
                <div class="payment-workspace">
                    <section class="payment-column payment-column-main">
                        <div class="payment-panel-head">
                            <div>
                                <h4 class="payment-panel-heading">Payment</h4>
                                <p class="payment-panel-subheading">Follow the next required payment step for this reservation.</p>
                            </div>
                        </div>
                        <div class="payment-panel-surface">
                            ${renderPaymentComposer(reservation)}
                        </div>
                    </section>
                    <aside class="payment-column payment-column-side">
                        <section class="payment-side-card payment-status-section">
                            ${renderPaymentStatusContext(reservation)}
                        </section>
                        <section class="payment-side-card payment-reference-section">
                            <div class="res-section-head">
                                <div>
                                    <div class="res-section-title">Payment Records</div>
                                    <div class="res-section-copy">History and receipts stay on demand so the payment action stays focused.</div>
                                </div>
                            </div>
                            ${renderPaymentReferenceTabs(reservation)}
                        </section>
                    </aside>
                </div>
            `;

    return `
        <div class="reservation-card payment-module-card${isCompletedOverview ? ' complete-state' : ''}${isPendingOverview ? ' pending-state' : ''}" data-payment-reservation-id="${escapeHtml(reservation.reservation_id)}">
            <div class="payment-module-shell">
                <div class="payment-module-topbar">
                    <div class="payment-module-topinfo">
                        <div class="payment-module-eventblock">
                            <div class="payment-module-event">${escapeHtml(reservation.event_type || 'Event')}</div>
                            <div class="payment-module-datetime">${escapeHtml(formatDate(reservation.event_date))} at ${escapeHtml(reservation.event_time || 'No time selected')}</div>
                        </div>
                        <div class="payment-module-summary">
                            <div class="payment-module-summary-item">
                                <span class="payment-module-summary-label">Package:</span>
                                <strong class="payment-module-summary-value">${escapeHtml(packageName)}</strong>
                            </div>
                            <div class="payment-module-summary-item">
                                <span class="payment-module-summary-label">Guests:</span>
                                <strong class="payment-module-summary-value">${escapeHtml(String(reservation.guest_count || 0))}</strong>
                            </div>
                            <div class="payment-module-summary-item">
                                <span class="payment-module-summary-label">Total:</span>
                                <strong class="payment-module-summary-value">${escapeHtml(formatCurrency(reservation.total_price))}</strong>
                            </div>
                        </div>
                    </div>
                    <div class="payment-module-topactions">
                        <div class="payment-module-badges">
                            <span class="res-status ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>
                            <span class="res-section-status ${escapeHtml(paymentSummary.key)}">${escapeHtml(paymentSummary.label)}</span>
                        </div>
                        ${contract?.contract_url ? `<a class="res-link-btn payment-contract-btn" href="${escapeHtml(contract.contract_url)}" target="_blank" rel="noopener noreferrer">View Uploaded Signed Contract</a>` : ''}
                    </div>
                </div>
                <div class="payment-module-location-row">
                    <div class="payment-module-location-item">
                        <span class="payment-module-location-label">Location</span>
                        <strong class="payment-module-location-value">${escapeHtml(locationLabel)}</strong>
                    </div>
                    <div class="payment-module-location-item address">
                        <span class="payment-module-location-label">${escapeHtml(isOnsite ? 'Venue' : 'Address')}</span>
                        <strong class="payment-module-location-value">${escapeHtml(locationValue)}</strong>
                    </div>
                </div>
                ${contentMarkup}
            </div>
        </div>
    `;
}

function renderPaymentsModule() {
    if (!paymentsList) return;

    const paymentReservations = state.reservations.filter((reservation) => (
        isSharedReservationPaymentEnabled(reservation)
        || getReservationPayments(reservation.reservation_id).length > 0
        || getReservationReceipts(reservation.reservation_id).length > 0
    ));

    if (!paymentReservations.length) {
        paymentsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">Payments</div>
                <h3>No payments yet</h3>
                <p>Approved reservations that need payment will appear here.</p>
            </div>
        `;
        return;
    }

    paymentsList.innerHTML = paymentReservations.map(buildPaymentModuleCard).join('');
}

function setInlineMessage(container, message, type = '') {
    if (!container) return;
    container.textContent = message;
    container.className = `res-form-message${type ? ` ${type}` : ''}`;
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

async function fetchContracts(reservationIds) {
    if (!reservationIds.length) return {};

    const { data, error } = await supabase
        .from('reservation_contracts')
        .select('reservation_id, contract_url, verified_date, review_status, review_notes, reviewed_at')
        .in('reservation_id', reservationIds);

    if (error) {
        if (
            isReservationContractsColumnMissing(error, 'review_status')
            || isReservationContractsColumnMissing(error, 'review_notes')
            || isReservationContractsColumnMissing(error, 'reviewed_at')
        ) {
            const fallback = await supabase
                .from('reservation_contracts')
                .select('reservation_id, contract_url, verified_date')
                .in('reservation_id', reservationIds);

            if (fallback.error) throw fallback.error;

            return (fallback.data || []).reduce((map, contract) => {
                map[contract.reservation_id] = contract;
                return map;
            }, {});
        }

        throw error;
    }

    return (data || []).reduce((map, contract) => {
        map[contract.reservation_id] = contract;
        return map;
    }, {});
}

async function fetchPayments(reservationIds) {
    if (!reservationIds.length) return {};

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
            verified_at
        `)
        .in('reservation_id', reservationIds)
        .order('submitted_at', { ascending: false });

    if (error) throw error;

    return (data || []).reduce((map, payment) => {
        if (!map[payment.reservation_id]) {
            map[payment.reservation_id] = [];
        }
        map[payment.reservation_id].push(payment);
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

async function fetchRescheduleRequests(reservationIds) {
    if (!reservationIds.length) return {};

    const { data, error } = await supabase
        .from('reschedule_requests')
        .select(`
            reschedule_request_id,
            reservation_id,
            user_id,
            original_date,
            original_time,
            requested_date,
            requested_time,
            status,
            requested_at,
            reviewed_at
        `)
        .in('reservation_id', reservationIds)
        .order('requested_at', { ascending: false });

    if (error) throw error;

    return (data || []).reduce((map, request) => {
        if (!map[request.reservation_id]) {
            map[request.reservation_id] = [];
        }
        map[request.reservation_id].push(request);
        return map;
    }, {});
}

async function fetchReviews(reservationIds) {
    if (!reservationIds.length) return {};

    const { data, error } = await supabase
        .from('reviews')
        .select(`
            review_id,
            reservation_id,
            user_id,
            rating,
            comment,
            created_at
        `)
        .eq('user_id', user.id)
        .in('reservation_id', reservationIds)
        .order('created_at', { ascending: false });

    if (error) {
        if (isMissingReviewsTableError(error)) {
            return {};
        }

        throw error;
    }

    return (data || []).reduce((map, review) => {
        if (!map[review.reservation_id]) {
            map[review.reservation_id] = review;
        }
        return map;
    }, {});
}

async function loadReservations({ silent = false } = {}) {
    if (!silent && reservationsList) {
        reservationsList.innerHTML = '<p style="color:#888;text-align:center;padding:40px 0;">Loading...</p>';
    }

    if (!state.paymentRules) {
        state.paymentRules = await loadPaymentRules(supabase).catch(() => null);
    }
    if (!state.reservationRules) {
        state.reservationRules = await loadReservationRules(supabase).catch(() => ({ ...RESERVATION_RULES_DEFAULTS }));
    }
    if (!state.policyBodies) {
        state.policyBodies = await loadPolicyBodies(supabase, ['cancellation_policy', 'reschedule_policy']).catch(() => ({}));
    }

    try {
        const baseReservationSelect = `
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
        `;
        const reservationResponse = await supabase
            .from('reservations')
            .select(baseReservationSelect)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (reservationResponse.error) throw reservationResponse.error;

        state.reservations = reservationResponse.data || [];
        const reservationIds = state.reservations.map((reservation) => reservation.reservation_id).filter(Boolean);

        state.contractsByReservationId = await fetchContracts(reservationIds);
        state.paymentsByReservationId = await fetchSharedPayments(supabase, reservationIds);
        state.reschedulesByReservationId = await fetchSharedRescheduleRequests(supabase, reservationIds);
        state.reviewsByReservationId = await fetchReviews(reservationIds);

        const paymentIds = Object.values(state.paymentsByReservationId)
            .flat()
            .map((payment) => payment.payment_id)
            .filter(Boolean);

        state.receiptsByPaymentId = await fetchSharedReceipts(supabase, paymentIds);
        renderReservations();
        renderPaymentsModule();
        if (!silent) {
            maybeAutoOpenReservationModal();
        }
    } catch (error) {
        if (silent) {
            console.error('[account] silent auto-refresh of reservations failed:', error);
            return;
        }
        if (reservationsList) {
            const reviewFeatureMessage = getReviewFeatureErrorMessage(error);
            reservationsList.innerHTML = `<p style="color:#c0392b;text-align:center;padding:40px 0;">Failed to load reservations: ${escapeHtml(reviewFeatureMessage)}.</p>`;
        }
        if (paymentsList) {
            paymentsList.innerHTML = '<p style="color:#c0392b;text-align:center;padding:40px 0;">Failed to load payments.</p>';
        }
    }
}

// The standalone reservation-details.html page can't reach this page's
// Reschedule/Cancel modals directly (separate static file, separate DOM) —
// it links back here with ?open=reschedule|cancel&reservation_id=<id> and
// this reopens the existing modal for that reservation instead of
// duplicating the calendar/fee-confirmation logic on a second page.
function maybeAutoOpenReservationModal() {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('open');
    const reservationId = params.get('reservation_id');
    if (!action || !reservationId) return;

    const exists = state.reservations.some((entry) => String(entry.reservation_id) === String(reservationId));
    if (!exists) return;

    if (action === 'reschedule') {
        openRescheduleModal(reservationId);
    } else if (action === 'cancel') {
        openCancelModal(reservationId);
    }

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('open');
    cleanUrl.searchParams.delete('reservation_id');
    window.history.replaceState({}, '', cleanUrl);
}

function openReceiptModal(paymentId, reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    const payment = getReservationPayments(reservationId).find((entry) => String(entry.payment_id) === String(paymentId));
    const receipt = state.receiptsByPaymentId[paymentId];

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
                        <span class="receipt-value">${escapeHtml(state.profile ? getReservationName(state.profile) : 'Customer')}</span>
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
                        <span class="receipt-value">${escapeHtml(reservation.package?.package_name || 'Package')}</span>
                    </div>
                    <div class="receipt-field">
                        <span class="receipt-label">Payment Type</span>
                        <span class="receipt-value">${escapeHtml(getPaymentLabel(payment.payment_type))}</span>
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

    state.receiptModalPaymentId = paymentId;
    receiptModalBackdrop?.classList.remove('hidden');
    receiptModalBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeReceiptModal() {
    state.receiptModalPaymentId = null;
    receiptModalBackdrop?.classList.add('hidden');
    receiptModalBackdrop?.setAttribute('aria-hidden', 'true');
}

function setRescheduleModalMessage(message, isError = false) {
    if (!rescheduleModalMessage) return;
    rescheduleModalMessage.textContent = message;
    rescheduleModalMessage.classList.toggle('error', isError);
}

function formatDateForInput(value) {
    const key = formatDateKey(value);
    return key || '';
}

async function loadRescheduleAvailability(reservation) {
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const range = getCalendarRange(month);
    const [blackoutData, calendarAvailability, advanceNoticeRules] = await Promise.all([
        fetchBlackoutDates(supabase, state.rescheduleModal),
        fetchCalendarAvailability(supabase, {
            fromDate: range.fromDate,
            toDate: range.toDate
        }),
        loadAdvanceNoticeRules(supabase)
    ]);

    state.rescheduleModal.closedDates = blackoutData.closedDates;
    state.rescheduleModal.blackoutDateColumn = blackoutData.blackoutDateColumn;
    state.rescheduleModal.blackoutReasonColumn = blackoutData.blackoutReasonColumn;
    state.rescheduleModal.calendarAvailability = calendarAvailability;
    state.rescheduleModal.advanceNoticeRules = advanceNoticeRules;
    state.rescheduleModal.month = month;
    state.rescheduleModal.selectedDate = '';
    state.rescheduleModal.selectedTime = reservation.event_time || '';
    state.rescheduleModal.availableStartTimes = [];
}

async function loadRescheduleCalendarMonth() {
    const range = getCalendarRange(state.rescheduleModal.month);
    state.rescheduleModal.calendarAvailability = await fetchCalendarAvailability(supabase, {
        fromDate: range.fromDate,
        toDate: range.toDate
    });
}

// Reflects the admin's actual per-weekday Operating Hours + buffer +
// per-scope capacity, live, per time slot — the same RPC the new-booking
// calendar in reservations.html uses (get_available_start_times via
// fetchAvailableStartTimes). Previously this modal built its time buttons
// from a hardcoded 1:00 PM-10:00 PM list and never disabled an individual
// slot for being taken, so an admin's hours/buffer/capacity changes never
// reached this grid at all.
async function loadRescheduleSelectedDateAvailability(reservation) {
    if (!state.rescheduleModal.selectedDate) {
        state.rescheduleModal.availableStartTimes = [];
        return [];
    }

    const rows = await fetchAvailableStartTimes(supabase, {
        eventDate: state.rescheduleModal.selectedDate,
        scope: getBookingScope(reservation),
        durationHours: getReservationDurationHours(reservation),
        excludeReservationId: reservation.reservation_id
    });
    state.rescheduleModal.availableStartTimes = rows;
    return rows;
}

function isRescheduleDateFullyBooked() {
    const rows = state.rescheduleModal.availableStartTimes || [];
    return rows.length === 0 || rows.every((row) => !row.isAvailable);
}

function renderRescheduleTimes() {
    if (!rescheduleTimeGrid) return;

    const selectedTime = state.rescheduleModal.selectedTime;
    const rows = state.rescheduleModal.availableStartTimes || [];

    if (!state.rescheduleModal.selectedDate) {
        rescheduleTimeGrid.innerHTML = '';
        return;
    }

    if (!rows.length) {
        rescheduleTimeGrid.innerHTML = '<p class="reschedule-time-empty">No valid start times for this date within operating hours.</p>';
        return;
    }

    rescheduleTimeGrid.innerHTML = rows.map((row) => `
        <button
            type="button"
            class="reschedule-time-btn ${selectedTime === row.timeLabel ? 'active' : ''} ${!row.isAvailable ? 'disabled' : ''}"
            data-time="${escapeHtml(row.timeLabel)}"
            title="${escapeHtml(row.isAvailable ? `Choose ${row.timeLabel} as your new start time.` : (row.reason || 'Unavailable at this time.'))}"
            ${!row.isAvailable ? 'disabled' : ''}
        >
            ${escapeHtml(row.timeLabel)}
        </button>
    `).join('');
}

function renderRescheduleCalendar() {
    if (!rescheduleCalendarGrid || !rescheduleMonthLabel) return;

    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(state.rescheduleModal.reservationId));
    if (!reservation) return;

    const month = state.rescheduleModal.month;
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    const firstWeekday = start.getDay();
    const daysInMonth = end.getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentReservationDate = formatDateKey(reservation.event_date);

    rescheduleMonthLabel.textContent = month.toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'long'
    });

    const cells = [];
    for (let index = 0; index < firstWeekday; index += 1) {
        cells.push('<div class="reschedule-empty-day"></div>');
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = new Date(month.getFullYear(), month.getMonth(), day);
        const dateKey = [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0')
        ].join('-');
        // date < today (not <=) so "today" is excluded only via the notice
        // window below, same as the booking form's calendar
        // (js/reservations.js) — using <= here made today always read as
        // "past" regardless of the configured minimum notice, which is why
        // this calendar and the booking form's disagreed on the first
        // selectable date by exactly one day.
        const isPast = date < today;
        const isClosed = state.rescheduleModal.closedDates.has(dateKey);
        const isOutsideWindow = !isPast && isOutsideBookingWindow(
            date, today, state.rescheduleModal.advanceNoticeRules, reservation.event_type
        );
        const dateAvailability = state.rescheduleModal.calendarAvailability.get(dateKey) || {
            occupiedScopes: [],
            isFullyBooked: false
        };
        const reservationScope = getBookingScope(reservation);
        const isBooked = dateAvailability.isFullyBooked;
        const isCurrent = currentReservationDate === dateKey;
        const isAvailable = !isPast && !isClosed && !isOutsideWindow && !isBooked && !isCurrent;
        const isSelected = state.rescheduleModal.selectedDate === dateKey;
        const classNames = ['reschedule-day'];
        let label = 'Unavailable';

        if (isAvailable) {
            classNames.push('available');
            label = 'Available';
        } else if (isClosed) {
            classNames.push('closed');
            label = 'Closed';
        } else if (isBooked) {
            classNames.push('booked');
            label = 'This date is fully booked.';
        } else if (isCurrent) {
            // Checked before isOutsideWindow/isPast on purpose — the
            // reservation's own existing date can easily fall within the
            // advance-notice window relative to today, but it isn't a "too
            // soon to book" date for a *new* booking, so it keeps its own
            // distinct label/styling (.current, added below) instead of
            // being swept into the "past" treatment.
            classNames.push('disabled');
            label = 'Current booking date';
        } else if (isOutsideWindow) {
            // Same .past class (and swatch) as the "Too Soon to Book" /
            // "past" entries on the booking form's calendar
            // (reservations.html) — previously this used the same generic
            // 'disabled' class as "fully booked", so a too-soon date was
            // visually indistinguishable from a booked-out one, and the
            // legend below had no matching entry for it at all.
            classNames.push('past');
            const effectiveMinDays = getEffectiveMinAdvanceDaysForReservation(reservation);
            const diffDays = Math.round((date - today) / 86400000);
            label = diffDays < effectiveMinDays
                ? `Too soon to book — needs at least ${effectiveMinDays} day(s) notice.`
                : 'Too far in advance to book.';
        } else if (isPast) {
            classNames.push('past');
            label = 'This date has already passed.';
        } else {
            classNames.push('disabled');
            label = 'Unavailable';
        }

        if (isCurrent) classNames.push('current');
        if (isSelected) classNames.push('selected');

        cells.push(`
            <button
                type="button"
                class="${classNames.join(' ')}"
                data-date="${escapeHtml(dateKey)}"
                aria-label="${escapeHtml(label)} on ${escapeHtml(formatDate(dateKey))}"
                ${isAvailable ? '' : 'disabled'}
            >
                <span>${day}</span>
            </button>
        `);
    }

    rescheduleCalendarGrid.innerHTML = cells.join('');
}

function closeRescheduleModal() {
    state.rescheduleModal.reservationId = null;
    state.rescheduleModal.selectedDate = '';
    state.rescheduleModal.selectedTime = '';
    state.rescheduleModal.calendarAvailability = new Map();
    state.rescheduleModal.availableStartTimes = [];
    state.rescheduleModal.closedDates = new Set();
    rescheduleModalBackdrop?.classList.add('hidden');
    rescheduleModalBackdrop?.setAttribute('aria-hidden', 'true');
    rescheduleModalSubmit?.removeAttribute('disabled');
    setRescheduleModalMessage('');
}

function setCancelModalMessage(message, isError = false) {
    if (!cancelModalMessage) return;
    cancelModalMessage.textContent = message || '';
    cancelModalMessage.className = 'account-modal-message' + (isError ? ' error' : '');
}

function closeCancelModal() {
    state.cancelModal.reservationId = null;
    cancelReservationBackdrop?.classList.add('hidden');
    cancelReservationBackdrop?.setAttribute('aria-hidden', 'true');
    if (cancelModalConfirm) cancelModalConfirm.removeAttribute('disabled');
    setCancelModalMessage('');
}

// Swaps the hardcoded fallback copy inside a policy block for the
// admin-saved override, if one exists — same "override only when present"
// contract as the Terms & Conditions / Data Privacy Policy modal on the
// booking page. Leaves the fallback markup untouched when there's nothing
// saved yet, or the fetch failed.
function applyPolicyOverride(elId, settingKey) {
    const el = document.getElementById(elId);
    const body = state.policyBodies?.[settingKey];
    if (el && body) el.innerHTML = renderPolicyText(body);
}

function openCancelModal(reservationId) {
    const reservation = state.reservations.find((r) => String(r.reservation_id) === String(reservationId));
    if (!reservation) return;

    state.cancelModal.reservationId = reservationId;
    const fee = getCancellationFee(reservation, state.paymentRules);
    if (cancelFeeAmount) cancelFeeAmount.textContent = `₱${fee.toLocaleString()}`;
    if (cancelReasonInput) cancelReasonInput.value = '';
    applyPolicyOverride('cancel-policy-body', 'cancellation_policy');
    setCancelModalMessage('');
    cancelReservationBackdrop?.classList.remove('hidden');
    cancelReservationBackdrop?.setAttribute('aria-hidden', 'false');
}

async function submitCancellationRequest() {
    const reservationId = state.cancelModal.reservationId;
    const reservation = state.reservations.find((r) => String(r.reservation_id) === String(reservationId));
    if (!reservation) return;

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
        const feeAmount = getCancellationFee(reservation, state.paymentRules);
        const holdHours = Number(state.paymentRules?.cancellation_hold_hours) || 48;

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
        await loadReservations();
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

async function openRescheduleModal(reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) return;

    state.rescheduleModal.reservationId = reservationId;
    if (rescheduleCurrentValue) {
        rescheduleCurrentValue.textContent = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;
    }
    const rescheduleFeeAmountEl = document.getElementById('reschedule-fee-amount');
    if (rescheduleFeeAmountEl) rescheduleFeeAmountEl.textContent = `₱${getRescheduleFee(state.paymentRules).toLocaleString()}`;
    applyPolicyOverride('reschedule-policy-body', 'reschedule_policy');

    setRescheduleModalMessage('Loading availability...');
    rescheduleModalBackdrop?.classList.remove('hidden');
    rescheduleModalBackdrop?.setAttribute('aria-hidden', 'false');

    try {
        await loadRescheduleAvailability(reservation);
        renderRescheduleCalendar();
        renderRescheduleTimes();
        setRescheduleModalMessage(`Choose a future available date for the ${getScopeLabel(getBookingScope(reservation))} booking slot, then select your new start time.`);
    } catch (error) {
        setRescheduleModalMessage(`Failed to load availability: ${error.message}`, true);
    }
}

async function submitRescheduleRequest() {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(state.rescheduleModal.reservationId));
    if (!reservation) return;

    if (!state.rescheduleModal.selectedDate) {
        setRescheduleModalMessage('Please choose a new available date first.', true);
        return;
    }

    if (!state.rescheduleModal.selectedTime) {
        setRescheduleModalMessage('Please choose a new event time.', true);
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selectedDateObj = new Date(`${state.rescheduleModal.selectedDate}T00:00:00`);
    if (isOutsideBookingWindow(selectedDateObj, today, state.rescheduleModal.advanceNoticeRules, reservation.event_type)) {
        const effectiveMinDays = getEffectiveMinAdvanceDaysForReservation(reservation);
        const diffDays = Math.round((selectedDateObj - today) / 86400000);
        setRescheduleModalMessage(
            diffDays < effectiveMinDays
                ? `This date is too soon — please choose a date at least ${effectiveMinDays} day(s) from today.`
                : 'This date is too far in advance — please choose a closer date.',
            true
        );
        return;
    }

    rescheduleModalSubmit?.setAttribute('disabled', 'true');
    setRescheduleModalMessage('Submitting your reschedule request...');

    try {
        // Re-checks the specific selected date+time right before submit (not
        // just "is the whole date fully booked") — closes the same race a
        // second customer could otherwise win between this modal opening and
        // the request being sent.
        const rows = await loadRescheduleSelectedDateAvailability(reservation);
        const selectedRow = rows.find((row) => row.timeLabel === state.rescheduleModal.selectedTime);
        if (!selectedRow?.isAvailable) {
            state.rescheduleModal.selectedTime = '';
            renderRescheduleTimes();
            throw new Error(selectedRow?.reason || 'That time is no longer available. Please choose another.');
        }

        // No manager approval step — the calendar this modal uses is the
        // same availability-aware source as the booking form (closed dates,
        // fully-booked dates, and the advance-notice window are already
        // enforced by what's selectable), so a submitted date is already
        // guaranteed valid. Goes straight to awaiting-fee; the manager's
        // only remaining touchpoint is verifying the fee payment.
        const payload = {
            reservation_id: reservation.reservation_id,
            user_id: user.id,
            original_date: reservation.event_date,
            original_time: reservation.event_time,
            requested_date: state.rescheduleModal.selectedDate,
            requested_time: state.rescheduleModal.selectedTime,
            status: 'approved_pending_payment'
        };

        const { error } = await supabase
            .from('reschedule_requests')
            .insert(payload);

        if (error) throw error;

        closeRescheduleModal();
        await loadReservations();
    } catch (error) {
        rescheduleModalSubmit?.removeAttribute('disabled');
        setRescheduleModalMessage(`Failed to submit request: ${error.message}`, true);
    }
}

function activateAccountSection(sectionKey) {
    const normalizedSection = ['profile', 'reservations'].includes(String(sectionKey || '').toLowerCase())
        ? String(sectionKey).toLowerCase()
        : 'profile';
    const navButtons = document.querySelectorAll('.account-tab[data-section]');
    const sections = document.querySelectorAll('.account-section');

    navButtons.forEach((navButton) => {
        navButton.classList.toggle('active', navButton.dataset.section === normalizedSection);
    });
    sections.forEach((section) => {
        section.classList.toggle('active', section.id === `section-${normalizedSection}`);
    });

    if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        if (normalizedSection === 'profile') {
            url.searchParams.delete('section');
        } else {
            url.searchParams.set('section', normalizedSection);
        }
        window.history.replaceState({}, '', url);
    }
}

function getRequestedAccountSection() {
    if (typeof window === 'undefined') return 'profile';

    const section = new URLSearchParams(window.location.search).get('section');
    return ['profile', 'reservations'].includes(String(section || '').toLowerCase())
        ? String(section).toLowerCase()
        : 'profile';
}

function wireReservationActions() {
    reservationsList?.addEventListener('click', async (event) => {
        const viewToggle = event.target.closest('[data-reservation-view]');
        if (viewToggle) {
            const requestedView = viewToggle.dataset.reservationView === 'past' ? 'past' : 'active';
            if (state.reservationView !== requestedView) {
                state.reservationView = requestedView;
                state.reservationPage = 1;
                renderReservations();
            }
            return;
        }

        const pageBtn = event.target.closest('[data-reservation-page]');
        if (pageBtn) {
            if (pageBtn.disabled) return;
            const pageValue = pageBtn.dataset.reservationPage;
            if (pageValue === 'next') {
                state.reservationPage += 1;
            } else if (pageValue === 'prev') {
                state.reservationPage -= 1;
            } else {
                state.reservationPage = Number(pageValue) || 1;
            }
            renderReservations();
            reservationsList.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }

        const rescheduleBtn = event.target.closest('.open-reschedule-btn');
        if (rescheduleBtn) {
            await openRescheduleModal(rescheduleBtn.dataset.reservationId);
            return;
        }

        const cancelBtn = event.target.closest('.open-cancel-btn');
        if (cancelBtn) {
            openCancelModal(cancelBtn.dataset.reservationId);
            return;
        }

        const openPaymentsBtn = event.target.closest('.open-payments-btn');
        if (openPaymentsBtn) {
            const reservationId = openPaymentsBtn.dataset.reservationId;
            window.location.href = buildCustomerPaymentUrl(reservationId);
        }
    });
}

function wirePaymentActions() {
    paymentsList?.addEventListener('click', (event) => {
        const referenceTab = event.target.closest('[data-payment-panel-tab]');
        if (referenceTab) {
            const shell = referenceTab.closest('.payment-reference-shell');
            const targetTab = referenceTab.dataset.paymentPanelTab || 'history';
            shell?.querySelectorAll('[data-payment-panel-tab]').forEach((tabButton) => {
                const isActive = tabButton.dataset.paymentPanelTab === targetTab;
                tabButton.classList.toggle('active', isActive);
                tabButton.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            shell?.querySelectorAll('[data-payment-panel]').forEach((panel) => {
                const isActive = panel.dataset.paymentPanel === targetTab;
                panel.classList.toggle('active', isActive);
                panel.hidden = !isActive;
            });
            return;
        }

        const receiptBtn = event.target.closest('.view-receipt-btn');
        if (receiptBtn) {
            openReceiptModal(receiptBtn.dataset.paymentId, receiptBtn.dataset.reservationId);
        }
    });
}

function wireReceiptModal() {
    receiptModalClose?.addEventListener('click', closeReceiptModal);
    receiptModalDismiss?.addEventListener('click', closeReceiptModal);
    receiptModalBackdrop?.addEventListener('click', (event) => {
        if (event.target === receiptModalBackdrop) closeReceiptModal();
    });
}

function wireRescheduleModal() {
    rescheduleModalClose?.addEventListener('click', closeRescheduleModal);
    rescheduleModalCancel?.addEventListener('click', closeRescheduleModal);
    rescheduleModalSubmit?.addEventListener('click', submitRescheduleRequest);
    rescheduleModalBackdrop?.addEventListener('click', (event) => {
        if (event.target === rescheduleModalBackdrop) closeRescheduleModal();
    });

    reschedulePrevMonth?.addEventListener('click', async () => {
        if (!state.rescheduleModal.reservationId) return;
        state.rescheduleModal.month = new Date(
            state.rescheduleModal.month.getFullYear(),
            state.rescheduleModal.month.getMonth() - 1,
            1
        );
        await loadRescheduleCalendarMonth();
        renderRescheduleCalendar();
    });

    rescheduleNextMonth?.addEventListener('click', async () => {
        if (!state.rescheduleModal.reservationId) return;
        state.rescheduleModal.month = new Date(
            state.rescheduleModal.month.getFullYear(),
            state.rescheduleModal.month.getMonth() + 1,
            1
        );
        await loadRescheduleCalendarMonth();
        renderRescheduleCalendar();
    });

    rescheduleCalendarGrid?.addEventListener('click', async (event) => {
        const dayButton = event.target.closest('.reschedule-day.available');
        if (!dayButton) return;
        const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(state.rescheduleModal.reservationId));
        if (!reservation) return;
        state.rescheduleModal.selectedDate = dayButton.dataset.date || '';
        state.rescheduleModal.selectedTime = '';
        await loadRescheduleSelectedDateAvailability(reservation);
        // The just-picked date may no longer hold the previous reservation
        // time (different scope capacity, buffer, or hours that day), so
        // don't carry it over — let the customer pick fresh from what's
        // actually open on this date.
        renderRescheduleCalendar();
        renderRescheduleTimes();
        setRescheduleModalMessage(
            isRescheduleDateFullyBooked()
                ? 'This date is fully booked.'
                : `Selected ${formatDate(state.rescheduleModal.selectedDate)} for your ${getScopeLabel(getBookingScope(reservation))} booking slot.`
        );
    });

    rescheduleTimeGrid?.addEventListener('click', (event) => {
        const timeButton = event.target.closest('.reschedule-time-btn');
        if (!timeButton) return;
        if (timeButton.hasAttribute('disabled')) return;
        state.rescheduleModal.selectedTime = timeButton.dataset.time || '';
        renderRescheduleTimes();
    });
}

function wireCancelModal() {
    cancelModalClose?.addEventListener('click', closeCancelModal);
    cancelModalDismiss?.addEventListener('click', closeCancelModal);
    cancelModalConfirm?.addEventListener('click', submitCancellationRequest);
    cancelReservationBackdrop?.addEventListener('click', (event) => {
        if (event.target === cancelReservationBackdrop) closeCancelModal();
    });
}

function wireSubmissionFeedbackModal() {
    submissionFeedbackClose?.addEventListener('click', closeSubmissionFeedbackModal);
    submissionFeedbackDismiss?.addEventListener('click', closeSubmissionFeedbackModal);
    submissionFeedbackBackdrop?.addEventListener('click', (event) => {
        if (event.target === submissionFeedbackBackdrop) {
            closeSubmissionFeedbackModal();
        }
    });
}

function getProfileFallback() {
    return {
        user_id: user.id,
        first_name: user.user_metadata?.first_name || '',
        middle_name: user.user_metadata?.middle_name || '',
        last_name: user.user_metadata?.last_name || '',
        email: normalizeEmail(user.email || ''),
        pending_email: null,
        email_change_requested_at: null,
        phone_number: user.user_metadata?.phone_number || '',
        role: 'customer',
        date_registered: user.created_at || ''
    };
}

function getConfirmedProfileEmail(profile) {
    return normalizeEmail(profile?.email || user.email || '');
}

function getPendingProfileEmail(profile) {
    const pendingEmail = normalizeEmail(profile?.pending_email || '');
    const confirmedEmail = getConfirmedProfileEmail(profile);
    return pendingEmail && pendingEmail !== confirmedEmail ? pendingEmail : '';
}

function renderPendingEmailNotice(profile) {
    const pendingEmailNote = document.getElementById('pending-email-note');
    if (!pendingEmailNote) return;

    const pendingEmail = getPendingProfileEmail(profile);
    if (!pendingEmail) {
        pendingEmailNote.hidden = true;
        pendingEmailNote.textContent = '';
        return;
    }

    pendingEmailNote.textContent = `Pending change to ${pendingEmail}. Confirm the email links sent to your inboxes before the new email becomes active.`;
    pendingEmailNote.hidden = false;
}

async function fetchCurrentProfile() {
    let response = await supabase
        .from('profiles')
        .select('user_id, first_name, middle_name, last_name, email, pending_email, email_change_requested_at, phone_number, role, date_registered')
        .eq('user_id', user.id)
        .maybeSingle();

    if (
        response.error
        && (
            isMissingProfileColumnError(response.error, 'pending_email')
            || isMissingProfileColumnError(response.error, 'email_change_requested_at')
        )
    ) {
        state.emailSecurityReady = false;
        response = await supabase
            .from('profiles')
            .select('user_id, first_name, middle_name, last_name, email, phone_number, role, date_registered')
            .eq('user_id', user.id)
            .maybeSingle();

        if (response.error) throw response.error;

        return response.data
            ? {
                ...response.data,
                email: normalizeEmail(response.data.email || ''),
                pending_email: null,
                email_change_requested_at: null
            }
            : null;
    }

    if (response.error) throw response.error;

    state.emailSecurityReady = true;
    return response.data
        ? {
            ...response.data,
            email: normalizeEmail(response.data.email || ''),
            pending_email: normalizeEmail(response.data.pending_email || '')
        }
        : null;
}

async function syncConfirmedEmailToProfile(profile) {
    const authEmail = normalizeEmail(user.email || '');
    const profileEmail = getConfirmedProfileEmail(profile);

    if (!state.emailSecurityReady || !authEmail || !profileEmail || authEmail === profileEmail) {
        return profile;
    }

    const reconciledProfile = {
        ...profile,
        email: authEmail,
        pending_email: null,
        email_change_requested_at: null
    };

    const { error } = await supabase
        .from('profiles')
        .upsert(reconciledProfile, { onConflict: 'user_id' });

    if (error) throw error;

    return reconciledProfile;
}

async function isEmailAlreadyUsed(requestedEmail) {
    const normalizedRequestedEmail = normalizeEmail(requestedEmail);
    if (!normalizedRequestedEmail) return false;

    const { data, error } = await supabase
        .from('profiles')
        .select('user_id, email, pending_email')
        .neq('user_id', user.id);

    if (error) {
        return false;
    }

    return (data || []).some((profile) => {
        const confirmedEmail = normalizeEmail(profile.email || '');
        const pendingEmail = normalizeEmail(profile.pending_email || '');
        return confirmedEmail === normalizedRequestedEmail || pendingEmail === normalizedRequestedEmail;
    });
}

function getEmailConflictMessage() {
    return 'This email is already in use. Please enter a different email address.';
}

function getEmailChangeErrorMessage(error) {
    const message = String(error?.message || '').toLowerCase();
    if (
        message.includes('already registered')
        || message.includes('already been registered')
        || message.includes('already in use')
        || message.includes('user already registered')
        || message.includes('email address is already in use')
        || message.includes('email already in use')
    ) {
        return getEmailConflictMessage();
    }

    return error?.message || 'Unable to request the email change right now.';
}

async function loadProfile() {
    const profileMessage = document.getElementById('profile-msg');
    const firstNameInput = document.getElementById('profile-first-name');
    const middleNameInput = document.getElementById('profile-middle-name');
    const lastNameInput = document.getElementById('profile-last-name');
    const emailInput = document.getElementById('profile-email');
    const phoneInput = document.getElementById('profile-phone');
    const dateInput = document.getElementById('profile-date');

    try {
        const profile = await fetchCurrentProfile();
        const fallbackProfile = getProfileFallback();

        state.profile = await syncConfirmedEmailToProfile(profile || fallbackProfile);
        const displayName = getReservationName(state.profile);
        const confirmedEmail = getConfirmedProfileEmail(state.profile);

        // ── Hero band identity ────────────────────────────────────────────
        const heroAvatar = document.getElementById('hero-avatar');
        const heroGreeting = document.getElementById('hero-greeting');
        const heroRole = document.getElementById('hero-role');

        if (heroAvatar) {
            const fn = state.profile.first_name || '';
            const ln = state.profile.last_name || '';
            heroAvatar.textContent = ((fn[0] || '') + (ln[0] || '')).toUpperCase() || '?';
        }
        if (heroGreeting) {
            const hour = new Date().getHours();
            const tod = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
            heroGreeting.textContent = `Good ${tod}, ${state.profile.first_name || 'there'}`;
        }
        if (heroRole) {
            const r = state.profile.role || 'customer';
            heroRole.textContent = r.charAt(0).toUpperCase() + r.slice(1);
        }

        // ── Read-only display fields ──────────────────────────────────────
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = val || '—';
            el.classList.toggle('is-empty', !val);
        };
        set('display-first-name', state.profile.first_name);
        set('display-middle-name', state.profile.middle_name);
        set('display-last-name', state.profile.last_name);
        set('display-email', confirmedEmail);
        set('display-phone', state.profile.phone_number);
        set('display-date', formatDate(state.profile.date_registered));

        // ── Edit form fields ──────────────────────────────────────────────
        if (firstNameInput) firstNameInput.value = state.profile.first_name || '';
        if (middleNameInput) middleNameInput.value = state.profile.middle_name || '';
        if (lastNameInput) lastNameInput.value = state.profile.last_name || '';
        if (emailInput) emailInput.value = confirmedEmail;
        if (phoneInput) phoneInput.value = state.profile.phone_number || '';
        if (dateInput) dateInput.textContent = formatDate(state.profile.date_registered);
        renderPendingEmailNotice(state.profile);
    } catch (error) {
        setFormMessage(profileMessage, 'Unable to load the latest profile details right now.', 'error');
    }
}

function wireAccountNavigation() {
    const navButtons = document.querySelectorAll('.account-tab[data-section]');

    navButtons.forEach((button) => {
        button.addEventListener('click', () => {
            activateAccountSection(button.dataset.section);
        });
    });

    activateAccountSection(getRequestedAccountSection());
}

function wireProfileForm() {
    const profileForm = document.getElementById('profile-form');
    const profileMessage = document.getElementById('profile-msg');

    profileForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const saveBtn = document.getElementById('save-profile-btn');
        const confirmedEmail = getConfirmedProfileEmail(state.profile);
        const requestedEmail = normalizeEmail(document.getElementById('profile-email')?.value || '');
        const currentPendingEmail = getPendingProfileEmail(state.profile);
        const payload = {
            user_id: user.id,
            first_name: state.profile?.first_name || '',
            middle_name: state.profile?.middle_name || null,
            last_name: state.profile?.last_name || '',
            email: confirmedEmail,
            phone_number: document.getElementById('profile-phone')?.value.trim() || null,
            role: state.profile?.role || 'customer',
            date_registered: state.profile?.date_registered || user.created_at || new Date().toISOString()
        };

        if (state.emailSecurityReady) {
            payload.pending_email = currentPendingEmail || null;
            payload.email_change_requested_at = state.profile?.email_change_requested_at || null;
        }

        if (!payload.first_name || !payload.last_name || !requestedEmail) {
            setFormMessage(profileMessage, 'First name, last name, and email are required.', 'error');
            return;
        }

        setFormMessage(profileMessage, 'Saving profile...');
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

        try {
            const { error: profileError } = await supabase
                .from('profiles')
                .upsert(payload, { onConflict: 'user_id' });

            if (profileError) throw profileError;

            state.profile = {
                ...state.profile,
                ...payload
            };

            const emailChanged = requestedEmail !== confirmedEmail;
            if (!emailChanged) {
                await loadProfile();
                setFormMessage(profileMessage, currentPendingEmail
                    ? `Your profile was updated. Pending change to ${currentPendingEmail} is still waiting for confirmation.`
                    : 'Profile updated successfully.', currentPendingEmail ? 'warning' : 'success');
                return;
            }

            if (currentPendingEmail && requestedEmail === currentPendingEmail) {
                await loadProfile();
                setFormMessage(profileMessage, `Pending change to ${currentPendingEmail} is still waiting for confirmation. Check your inboxes before requesting another email change.`, 'warning');
                return;
            }

            if (!state.emailSecurityReady) {
                await loadProfile();
                setFormMessage(profileMessage, 'Your other profile changes were saved, but secure email change needs the pending_email profile migration before it can be used.', 'warning');
                return;
            }

            const emailInUse = await isEmailAlreadyUsed(requestedEmail);
            if (emailInUse) {
                await loadProfile();
                setFormMessage(profileMessage, `Your other profile changes were saved, but ${getEmailConflictMessage()}`, 'warning');
                return;
            }

            const emailRedirectTo = new URL('/account.html', window.location.href).href;
            const { error: emailError } = await supabase.auth.updateUser({
                email: requestedEmail,
                options: {
                    emailRedirectTo
                }
            });

            if (emailError) {
                await loadProfile();
                setFormMessage(profileMessage, `Your other profile changes were saved, but the email change could not be requested: ${getEmailChangeErrorMessage(emailError)}`, 'warning');
                return;
            }

            const pendingPayload = {
                ...payload,
                pending_email: requestedEmail,
                email_change_requested_at: new Date().toISOString()
            };

            const { error: pendingError } = await supabase
                .from('profiles')
                .upsert(pendingPayload, { onConflict: 'user_id' });

            if (pendingError) {
                await loadProfile();
                setFormMessage(
                    profileMessage,
                    'The confirmation email was requested, but we could not save the pending email state on your profile. Please refresh this page and check both your old and new inboxes before trying again.',
                    'warning'
                );
                return;
            }

            state.profile = {
                ...state.profile,
                ...pendingPayload
            };

            await loadProfile();
            setFormMessage(
                profileMessage,
                `Pending change to ${requestedEmail}. Confirm the email links sent to your inboxes before the new email becomes active.`,
                'warning'
            );
        } catch (error) {
            setFormMessage(profileMessage, `Failed to update profile: ${error.message}`, 'error');
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
        }
    });
}

function wirePasswordForm() {
    const passwordForm = document.getElementById('password-form');
    const passwordMessage = document.getElementById('password-msg');

    passwordForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const updateBtn = document.getElementById('update-password-btn');
        const currentPassword = document.getElementById('current-password')?.value || '';
        const newPassword = document.getElementById('new-password')?.value || '';
        const confirmPassword = document.getElementById('confirm-new-password')?.value || '';

        if (newPassword.length < 8) {
            setFormMessage(passwordMessage, 'New password must be at least 8 characters long.', 'error');
            return;
        }

        if (newPassword !== confirmPassword) {
            setFormMessage(passwordMessage, 'New password and confirmation do not match.', 'error');
            return;
        }

        setFormMessage(passwordMessage, 'Updating password...');
        if (updateBtn) { updateBtn.disabled = true; updateBtn.textContent = 'Updating...'; }

        try {
            const { error: signInError } = await supabase.auth.signInWithPassword({
                email: user.email,
                password: currentPassword
            });

            if (signInError) throw new Error('Current password is incorrect.');

            const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
            if (updateError) throw updateError;

            setFormMessage(passwordMessage, 'Password updated successfully.', 'success');
            passwordForm.reset();
        } catch (error) {
            setFormMessage(passwordMessage, `Failed to update password: ${error.message}`, 'error');
        } finally {
            if (updateBtn) { updateBtn.disabled = false; updateBtn.textContent = 'Update Password'; }
        }
    });
}

function wireLogout() {
    document.getElementById('tab-logout-btn')?.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.href = '/login.html';
    });

    supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') {
            window.location.href = '/login.html';
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (state.receiptModalPaymentId) closeReceiptModal();
            if (state.rescheduleModal.reservationId) closeRescheduleModal();
            if (submissionFeedbackBackdrop && !submissionFeedbackBackdrop.classList.contains('hidden')) {
                closeSubmissionFeedbackModal();
            }
        }
    });
}

function wireEditProfileToggle() {
    const editBtn      = document.getElementById('edit-profile-btn');
    const cancelBtn    = document.getElementById('cancel-edit-btn');
    const readonlyView = document.getElementById('info-readonly-view');
    const editView     = document.getElementById('info-edit-view');

    function enterEditMode() {
        readonlyView?.setAttribute('hidden', '');
        editView?.removeAttribute('hidden');
        if (editBtn) editBtn.innerHTML = '<i class="ti ti-x"></i> Cancel Edit';
    }

    function exitEditMode() {
        editView?.setAttribute('hidden', '');
        readonlyView?.removeAttribute('hidden');
        if (editBtn) editBtn.innerHTML = '<i class="ti ti-edit"></i> Edit Profile';
    }

    // Toggle: if already in edit mode, cancel; otherwise open
    editBtn?.addEventListener('click', () => {
        if (editView && !editView.hasAttribute('hidden')) {
            exitEditMode();
        } else {
            enterEditMode();
        }
    });

    // The "Cancel" button next to Save Changes also exits edit mode
    cancelBtn?.addEventListener('click', exitEditMode);
}

function wireChangePasswordCard() {
    const openBtn    = document.getElementById('change-password-btn');
    const closeBtn   = document.getElementById('close-password-card-btn');
    const card       = document.getElementById('password-card');

    openBtn?.addEventListener('click', () => {
        card?.removeAttribute('hidden');
        card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    closeBtn?.addEventListener('click', () => {
        card?.setAttribute('hidden', '');
        document.getElementById('password-form')?.reset();
        const msg = document.getElementById('password-msg');
        if (msg) { msg.textContent = ''; msg.className = 'form-msg'; }
    });
}

function wireDeleteAccount() {
    document.getElementById('delete-account-btn')?.addEventListener('click', () => {
        // Deletion requires admin-level API access; direct users to contact support.
        showFeedbackModal({
            type: 'info',
            title: 'Contact us to delete your account',
            message: 'To permanently delete your account, please contact us directly at the café or reach out via email. This action cannot be undone.',
            confirmText: 'Got it'
        });
    });
}

wireAccountNavigation();
wireReservationActions();
wirePaymentActions();
wireReceiptModal();
wireRescheduleModal();
wireCancelModal();
wireSubmissionFeedbackModal();
wireProfileForm();
wirePasswordForm();
wireLogout();
wireEditProfileToggle();
wireChangePasswordCard();
wireDeleteAccount();

await Promise.all([
    loadProfile(),
    loadReservations()
]);

initAutoRefresh(() => loadReservations({ silent: true }));