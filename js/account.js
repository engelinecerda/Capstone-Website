import { customerSupabase as supabase } from './supabase.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchReceipts as fetchSharedReceipts,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    getReservationBalanceDetails as getSharedReservationBalanceDetails,
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
    computeContractMeta,
    computeCanReschedule,
    computeCanCancel
} from './reservation_shared.js';
import { loadPolicyBodies, renderPolicyText } from './policy_text.js';

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
const reviewPromptBackdrop = document.getElementById('review-prompt-backdrop');
const reviewPromptClose = document.getElementById('review-prompt-close');
const reviewPromptDismiss = document.getElementById('review-prompt-dismiss');
const reviewPromptSubmit = document.getElementById('review-prompt-submit');
const reviewPromptReservationMeta = document.getElementById('review-prompt-reservation-meta');
const reviewPromptRating = document.getElementById('review-prompt-rating');
const reviewPromptRatingCopy = document.getElementById('review-prompt-rating-copy');
const reviewPromptComment = document.getElementById('review-prompt-comment');
const reviewPromptMessage = document.getElementById('review-prompt-message');
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
    reviewPromptReservationId: null,
    reviewPromptRating: 0,
    reviewPromptEvaluated: false,
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

function getReviewFeatureErrorMessage(error, action = 'use') {
    const message = error?.message || '';
    const details = error?.details || '';
    const code = error?.code || '';
    const combined = `${message} ${details}`;

    if (isMissingReviewsTableError(error) || isMissingColumnError(error, 'reservations', 'review_prompt_dismissed_at')) {
        return 'The review feature is not fully set up in Supabase yet. Apply the review migrations in `supabase/migrations/`, then reload this page.';
    }

    if (code === '23505' || combined.includes('duplicate key value') || combined.includes('unique (reservation_id)')) {
        return 'A review for this reservation was already submitted. Reload the page and check your completed reservation details.';
    }

    if (combined.toLowerCase().includes('row-level security') || code === '42501') {
        return action === 'dismiss'
            ? 'Supabase rejected this review prompt update. Apply the review migrations in `supabase/migrations/` and make sure this reservation belongs to the signed-in customer.'
            : 'Supabase rejected this review submission. Apply the review migrations in `supabase/migrations/`, then make sure the reservation is completed or already past its event date/time in Manila time before submitting again.';
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

function getReservationReviewState(reservation) {
    const review = getReservationReview(reservation?.reservation_id);
    const isCompleted = getEffectiveReservationStatus(reservation) === 'completed';
    const dismissedAt = reservation?.review_prompt_dismissed_at || '';

    return {
        review,
        isCompleted,
        dismissedAt,
        isDismissed: Boolean(dismissedAt) && !review,
        canReview: isCompleted && !review,
        canAutoPrompt: isCompleted && !review && !dismissedAt
    };
}

function getReviewPromptCandidate() {
    return state.reservations
        .filter((reservation) => getReservationReviewState(reservation).canAutoPrompt)
        .sort((left, right) => {
            const leftTime = getReservationEventDateTime(left)?.getTime() || new Date(left?.created_at || 0).getTime() || 0;
            const rightTime = getReservationEventDateTime(right)?.getTime() || new Date(right?.created_at || 0).getTime() || 0;
            return rightTime - leftTime;
        })[0] || null;
}

function getReviewRatingLabel(rating) {
    const normalizedRating = Number(rating || 0);
    if (!normalizedRating) return 'Not rated';
    if (normalizedRating === 1) return '1 out of 5';
    return `${normalizedRating} out of 5`;
}

function buildReviewStarsMarkup(rating, { interactive = false } = {}) {
    const normalizedRating = Math.max(0, Math.min(5, Number(rating || 0)));
    return Array.from({ length: 5 }, (_, index) => {
        const filled = index < normalizedRating;
        if (interactive) {
            const value = index + 1;
            return `
                <button
                    type="button"
                    class="review-star-btn ${value <= normalizedRating ? 'active' : ''}"
                    data-rating-value="${value}"
                    aria-label="${value} star${value === 1 ? '' : 's'}"
                    aria-checked="${value === normalizedRating ? 'true' : 'false'}"
                >
                    &#9733;
                </button>
            `;
        }

        return `<span class="review-display-star ${filled ? 'filled' : ''}" aria-hidden="true">${filled ? '&#9733;' : '&#9734;'}</span>`;
    }).join('');
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

function isReservationPaymentEnabled(reservation) {
    return ['approved', 'confirmed', 'rescheduled', 'completed', 'cancellation_approved'].includes(String(reservation?.status || '').toLowerCase());
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
    if (!isReservationPaymentEnabled(reservation)) {
        return [];
    }

    const reservationId = reservation.reservation_id;
    const balance = getReservationBalanceDetails(reservation);
    const totalPrice = balance.totalPrice;
    const approvedBasePayments = balance.approvedBaseTotal;
    const remainingBalance = balance.remainingBalance;
    const pendingBasePayment = getPendingBasePayment(reservationId);
    const options = [];

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

    // Mirrors the same branch in customer_payments.js's shared
    // getAvailablePaymentOptions() — without this, a reservation that's
    // fully paid before being cancelled has remainingBalance === 0, so
    // nothing above ever fires and the customer has no way to pay the
    // cancellation fee from this list.
    if (String(reservation?.status || '').toLowerCase() === 'cancellation_approved') {
        const hasPendingCancellationFee = getReservationPayments(reservationId).some((payment) => (
            payment.payment_type === 'cancellation_fee'
            && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
        ));
        if (!hasPendingCancellationFee) {
            const cancellationFeeAmount = getCancellationFee(reservation, state.paymentRules);
            options.push(buildPaymentOption(reservation, 'cancellation_fee', cancellationFeeAmount, {
                displayLabel: 'Cancellation Fee',
                displayDescription: 'Required fee to finalize the cancellation of your reservation.'
            }));
        }
    }

    return options.filter((option) => option.amount > 0);
}

function getPaymentSummary(reservation) {
    const reservationId = reservation.reservation_id;
    const balance = getReservationBalanceDetails(reservation);
    const pendingPayment = getPendingBasePayment(reservationId);

    if (pendingPayment) {
        const pendingLabel = getPaymentActionLabel(
            pendingPayment.payment_type,
            reservation,
            Number(pendingPayment.amount || 0),
            pendingPayment.reschedule_request_id || ''
        );
        return {
            label: `${pendingLabel} pending review`,
            key: 'pending',
            sublabel: 'Waiting for admin confirmation'
        };
    }

    if (balance.remainingBalance <= 0) {
        return { label: 'Paid in full', key: 'approved', sublabel: 'All required payments recorded' };
    }

    if (balance.hasPartialPayment) {
        return {
            label: balance.isPastDue ? 'Overdue' : 'Remaining balance due',
            key: balance.toneKey,
            sublabel: `${formatCurrency(balance.remainingBalance)} remaining / Pay by ${balance.dueDateLabel}`
        };
    }

    const approvedRescheduleRequest = getReservationRescheduleRequests(reservationId)
        .find((request) => String(request.status || '').toLowerCase() === 'approved_pending_payment');

    if (approvedRescheduleRequest) {
        return { label: 'Reschedule fee pending', key: 'info', sublabel: 'Complete the reschedule fee to finalize the change' };
    }

    return {
        label: balance.isPastDue ? 'Overdue' : 'Initial payment needed',
        key: balance.toneKey,
        sublabel: balance.dueDateKey ? `Pay by ${balance.dueDateLabel}` : 'Choose your first payment'
    };
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
        && Boolean(getPendingBasePayment(reservation.reservation_id))
        && !availableOptions.length;
}

function getTimelineTimestamp(value, fallback = Number.MAX_SAFE_INTEGER) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isNaN(timestamp) ? fallback : timestamp;
}

function getPaymentTimelineEntries(reservation) {
    const reservationId = reservation.reservation_id;
    const pendingBasePayment = getPendingBasePayment(reservationId);
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

    if (pendingBasePayment) {
        const pendingTimestamp = getTimelineTimestamp(pendingBasePayment.submitted_at);
        entries.push({
            key: 'pending',
            title: `${getPaymentLabel(pendingBasePayment.payment_type)} Submitted`,
            meta: formatShortDate(pendingBasePayment.submitted_at),
            note: `${formatCurrency(pendingBasePayment.amount)} / ${PAYMENT_METHODS[pendingBasePayment.payment_method]?.label || pendingBasePayment.payment_method} / awaiting admin review`,
            proofUrl: pendingBasePayment.proof_url || '',
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
        if (!isReservationPaymentEnabled(reservation)) {
            return '<div class="payment-empty">Payment submission becomes available after admin approves this reservation.</div>';
        }
        const waitingMessage = getPendingBasePayment(reservation.reservation_id)
            ? 'Your latest reservation payment is still pending admin review.'
            : 'No new payment actions are available right now.';
        return `<div class="payment-empty">${escapeHtml(waitingMessage)}</div>`;
    }

    const balance = getReservationBalanceDetails(reservation);
    const isCancellationApproved = String(reservation?.status || '').toLowerCase() === 'cancellation_approved';
    const actionIntro = isCancellationApproved
        ? 'Your cancellation request was approved. Pay the cancellation fee to finalize it.'
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
    const paymentModuleEnabled = isReservationPaymentEnabled(reservation) || paymentEntries.length > 0;
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
                <div class="res-section-copy">Choose a new available date first, then wait for admin review before paying the reschedule fee.</div>
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
    const pendingPayment = getPendingBasePayment(reservation.reservation_id) || getLatestReservationPayment(reservation.reservation_id);
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

function getReservationCardTone(statusKey, isPaymentEnabled, remainingBalance) {
    if (['cancelled', 'declined'].includes(statusKey)) return 'rejected';
    if (isPaymentEnabled && remainingBalance > 0) return 'payment-required';
    if (['approved', 'confirmed', 'rescheduled', 'completed'].includes(statusKey)) return 'approved';
    return 'pending';
}

function buildReservationCard(reservation, view) {
    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation));
    const balance = getSharedReservationBalanceDetails(reservation, state.paymentsByReservationId, { formatDate });
    const packageName = getReservationPackageName(reservation);
    const location = getReservationLocationLabel(reservation);
    const paymentIsActionable = isSharedReservationPaymentEnabled(reservation) && balance.remainingBalance > 0;
    const reviewState = view === 'past' ? getReservationReviewState(reservation) : null;
    const cardTone = getReservationCardTone(reservationStatus.key, isSharedReservationPaymentEnabled(reservation), balance.remainingBalance);
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
                <div class="reservation-balance-line ${escapeHtml(balance.toneKey)}">
                    <strong>${escapeHtml(formatCurrency(balance.remainingBalance))}</strong> due by ${escapeHtml(balance.dueDateLabel)}
                </div>
            ` : ''}

            <div class="reservation-card-footer">
                <div class="reservation-summary-actions">
                    ${paymentIsActionable ? `
                        <button type="button" class="reservation-card-cta open-payments-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Continue Payment <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
                    ` : ''}
                    <a class="reservation-card-cta-secondary" href="${escapeHtml(detailsUrl)}">View details <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>
                    ${reviewState?.review ? `<span class="reservation-reviewed-badge"><i class="fa-solid fa-check" aria-hidden="true"></i> Reviewed</span>` : ''}
                    ${reviewState?.canReview ? `<button type="button" class="res-secondary-btn open-review-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Leave a Review</button>` : ''}
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

function setReviewPromptMessage(message, type = '') {
    if (!reviewPromptMessage) return;
    reviewPromptMessage.textContent = message;
    reviewPromptMessage.classList.remove('error', 'success');
    if (type) {
        reviewPromptMessage.classList.add(type);
    }
}

function setReviewPromptRating(rating) {
    state.reviewPromptRating = Math.max(0, Math.min(5, Number(rating || 0)));

    reviewPromptRating?.querySelectorAll('[data-rating-value]').forEach((button, index) => {
        const value = Number(button.dataset.ratingValue || index + 1);
        const isActive = value <= state.reviewPromptRating;
        const isSelected = value === state.reviewPromptRating;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    });

    if (reviewPromptRatingCopy) {
        reviewPromptRatingCopy.textContent = state.reviewPromptRating
            ? `${getReviewRatingLabel(state.reviewPromptRating)} selected`
            : 'Choose a rating before you submit.';
    }
}

function setReviewPromptBusy(isBusy) {
    reviewPromptClose?.toggleAttribute('disabled', isBusy);
    reviewPromptDismiss?.toggleAttribute('disabled', isBusy);
    reviewPromptSubmit?.toggleAttribute('disabled', isBusy);
}

function openReviewPromptModal(reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    const reviewState = reservation ? getReservationReviewState(reservation) : null;

    if (!reservation || !reviewState?.canReview) {
        return;
    }

    state.reviewPromptReservationId = reservation.reservation_id;
    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    setReviewPromptRating(0);
    if (reviewPromptComment) {
        reviewPromptComment.value = '';
    }
    if (reviewPromptReservationMeta) {
        reviewPromptReservationMeta.innerHTML = `
            <div class="review-reservation-title">${escapeHtml(reservation.event_type || 'Event')}</div>
            <div class="review-reservation-copy">
                ${escapeHtml(getReservationPackageName(reservation))} • ${escapeHtml(formatDate(reservation.event_date))} • ${escapeHtml(reservation.event_time || 'No time selected')}
            </div>
        `;
    }

    reviewPromptBackdrop?.classList.remove('hidden');
    reviewPromptBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeReviewPromptModal() {
    state.reviewPromptReservationId = null;
    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    reviewPromptBackdrop?.classList.add('hidden');
    reviewPromptBackdrop?.setAttribute('aria-hidden', 'true');
}

function openEligibleReviewPrompt() {
    const reservation = getReviewPromptCandidate();
    if (!reservation) return;
    openReviewPromptModal(reservation.reservation_id);
}

async function dismissReviewPrompt() {
    const reservationId = state.reviewPromptReservationId;
    if (!reservationId) return;

    try {
        setReviewPromptBusy(true);
        setReviewPromptMessage('Saving your choice...');

        const { error } = await supabase.rpc('dismiss_reservation_review_prompt', {
            p_reservation_id: reservationId
        });

        if (error) throw error;

        closeReviewPromptModal();
        await loadReservations();
    } catch (error) {
        setReviewPromptBusy(false);
        setReviewPromptMessage(`Failed to update this review prompt: ${getReviewFeatureErrorMessage(error, 'dismiss')}`, 'error');
    }
}

async function submitReservationReview() {
    const reservationId = state.reviewPromptReservationId;
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) {
        setReviewPromptMessage('This reservation could not be found.', 'error');
        return;
    }

    if (!getReservationReviewState(reservation).canReview) {
        setReviewPromptMessage('This reservation is no longer open for review.', 'error');
        return;
    }

    if (!state.reviewPromptRating) {
        setReviewPromptMessage('Choose a rating before you submit your review.', 'error');
        return;
    }

    try {
        setReviewPromptBusy(true);
        setReviewPromptMessage('Submitting your review...');

        const payload = {
            reservation_id: reservationId,
            user_id: user.id,
            rating: state.reviewPromptRating,
            comment: reviewPromptComment?.value.trim() || null
        };

        const { error } = await supabase
            .from('reviews')
            .insert(payload);

        if (error) throw error;

        closeReviewPromptModal();
        await loadReservations();
        openSubmissionFeedbackModal({
            eyebrow: 'Review Submitted',
            title: 'Thank You for the Feedback',
            copy: 'Your review has been saved to your completed reservation.'
        });
    } catch (error) {
        setReviewPromptBusy(false);
        setReviewPromptMessage(`Failed to submit your review: ${getReviewFeatureErrorMessage(error, 'submit')}`, 'error');
    }
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
    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation));
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
        isReservationPaymentEnabled(reservation)
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
        .select('reservation_id, contract_url, verified_date, review_status, review_notes, reviewed_at, resubmitted_at')
        .in('reservation_id', reservationIds);

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

async function loadReservations() {
    if (reservationsList) {
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
        const reservationSelectWithReviewPrompt = `
            ${baseReservationSelect},
            review_prompt_dismissed_at
        `;

        let reservationResponse = await supabase
            .from('reservations')
            .select(reservationSelectWithReviewPrompt)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (reservationResponse.error && isMissingColumnError(reservationResponse.error, 'reservations', 'review_prompt_dismissed_at')) {
            reservationResponse = await supabase
                .from('reservations')
                .select(baseReservationSelect)
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (!reservationResponse.error) {
                reservationResponse.data = (reservationResponse.data || []).map((reservation) => ({
                    ...reservation,
                    review_prompt_dismissed_at: null
                }));
            }
        }

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
        maybeAutoOpenReservationModal();
        if (!state.reviewPromptEvaluated) {
            state.reviewPromptEvaluated = true;
            openEligibleReviewPrompt();
        }
    } catch (error) {
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
    } else if (action === 'review') {
        openReviewPromptModal(reservationId);
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
        const isPastOrToday = date <= today;
        const isClosed = state.rescheduleModal.closedDates.has(dateKey);
        const isOutsideWindow = !isPastOrToday && isOutsideBookingWindow(
            date, today, state.rescheduleModal.advanceNoticeRules, reservation.event_type
        );
        const dateAvailability = state.rescheduleModal.calendarAvailability.get(dateKey) || {
            occupiedScopes: [],
            isFullyBooked: false
        };
        const reservationScope = getBookingScope(reservation);
        const isBooked = dateAvailability.isFullyBooked;
        const isCurrent = currentReservationDate === dateKey;
        const isAvailable = !isPastOrToday && !isClosed && !isOutsideWindow && !isBooked && !isCurrent;
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
        } else if (isOutsideWindow) {
            classNames.push('disabled');
            const effectiveMinDays = getEffectiveMinAdvanceDaysForReservation(reservation);
            const diffDays = Math.round((date - today) / 86400000);
            label = diffDays < effectiveMinDays
                ? `Too soon to book — needs at least ${effectiveMinDays} day(s) notice.`
                : 'Too far in advance to book.';
        } else {
            classNames.push('disabled');
            label = isCurrent ? 'Current booking date' : 'Unavailable';
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
        // No `payment` row is inserted here — same reasoning as before
        // (customer hasn't chosen a payment_method yet, and this reservation
        // isn't even payable until a manager approves the request). This is
        // now a two-gate flow instead of one: request -> manager approves or
        // rejects -> only on approval does js/admin_reservation_details.js
        // create the cancellation_fee row and flip status to
        // 'cancellation_approved', which is what makes
        // js/customer_payments.js's option builder actually offer the fee on
        // the payment page. Nothing is payable at request time.
        const previousStatus = reservation.status;

        const { error: statusError } = await supabase
            .from('reservations')
            .update({ status: 'cancellation_requested', cancellation_reason: reason })
            .eq('reservation_id', reservationId);

        if (statusError) throw statusError;

        // Logged so a manager rejecting this request later knows exactly
        // which status to revert the reservation to, rather than guessing.
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
        await loadReservations();
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

        const payload = {
            reservation_id: reservation.reservation_id,
            user_id: user.id,
            original_date: reservation.event_date,
            original_time: reservation.event_time,
            requested_date: state.rescheduleModal.selectedDate,
            requested_time: state.rescheduleModal.selectedTime,
            status: 'pending'
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

        const reviewBtn = event.target.closest('.open-review-btn');
        if (reviewBtn) {
            openReviewPromptModal(reviewBtn.dataset.reservationId);
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

function wireReviewPromptModal() {
    reviewPromptClose?.addEventListener('click', closeReviewPromptModal);
    reviewPromptDismiss?.addEventListener('click', async () => {
        await dismissReviewPrompt();
    });
    reviewPromptSubmit?.addEventListener('click', async () => {
        await submitReservationReview();
    });
    reviewPromptBackdrop?.addEventListener('click', (event) => {
        if (event.target === reviewPromptBackdrop) {
            closeReviewPromptModal();
        }
    });
    reviewPromptRating?.addEventListener('click', (event) => {
        const starBtn = event.target.closest('[data-rating-value]');
        if (!starBtn) return;
        setReviewPromptRating(starBtn.dataset.ratingValue);
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
            if (state.reviewPromptReservationId) closeReviewPromptModal();
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
        alert('To permanently delete your account, please contact us directly at the café or reach out via email. This action cannot be undone.');
    });
}

wireAccountNavigation();
wireReservationActions();
wirePaymentActions();
wireReceiptModal();
wireRescheduleModal();
wireCancelModal();
wireReviewPromptModal();
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