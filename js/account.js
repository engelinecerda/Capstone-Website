import { customerSupabase as supabase } from './supabase.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchReceipts as fetchSharedReceipts,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    getPaymentSummary as getSharedPaymentSummary,
    getReservationBalanceDetails as getSharedReservationBalanceDetails,
    getReservationPayments as getSharedReservationPayments,
    isReservationPaymentEnabled as isSharedReservationPaymentEnabled
} from './customer_payments.js';
import {
    fetchBlackoutDates,
    fetchCalendarAvailability,
    fetchDateAvailability,
    getAvailabilitySummaryMessage,
    getBookingScope as getSharedBookingScope,
    getCalendarRange,
    getScopeLabel,
    isScopeOccupied
} from './reservation_availability.js';

const CLOUDINARY_CONFIG = {
    cloudName: 'dtt707f1w',
    uploadPreset: 'eli_contracts',
    paymentFolder: 'payments',
    contractFolder: 'contracts',
    maxFileSize: 10 * 1024 * 1024
};

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

const PAYMENT_TYPE_META = {
    reservation_fee: { label: 'Reservation Fee', description: 'Fixed reservation fee' },
    down_payment: { label: 'Down Payment', description: '50% of your total amount' },
    full_payment: { label: 'Full Payment', description: 'Settle the remaining balance in full' },
    reschedule_fee: { label: 'Reschedule Fee', description: 'Fixed fee for approved reschedule requests' }
};
const ONSITE_RESERVATION_FEE = 999;
const PAYMENT_BALANCE_DUE_DAYS = 7;
const BUSINESS_TIME_ZONE = 'Asia/Manila';

const PAYMENT_STATUS_META = {
    pending_review: { label: 'Pending Review', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' }
};

const RESCHEDULE_STATUS_META = {
    pending: { label: 'Pending Admin Review', key: 'pending' },
    approved_pending_payment: { label: 'Approved - Waiting for Fee', key: 'info' },
    rejected: { label: 'Rejected', key: 'rejected' },
    completed: { label: 'Completed', key: 'approved' }
};

const TIMES = [
    '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
    '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'
];

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
const reservationDetailsBackdrop = document.getElementById('reservation-details-backdrop');
const reservationDetailsClose = document.getElementById('reservation-details-close');
const reservationDetailsDismiss = document.getElementById('reservation-details-dismiss');
const reservationDetailsView = document.getElementById('reservation-details-view');
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
    contractsByReservationId: {},
    paymentsByReservationId: {},
    receiptsByPaymentId: {},
    reschedulesByReservationId: {},
    reviewsByReservationId: {},
    profile: null,
    emailSecurityReady: true,
    reservationView: 'active',
    reservationDetailsReservationId: null,
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
        selectedDateAvailability: null,
        closedDates: new Set(),
        blackoutDateColumn: null,
        blackoutReasonColumn: null
    }
};

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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

    return message || 'unknown error';
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

function formatDateKey(value) {
    return String(value || '').split('T')[0];
}

function getTimeZoneNowParts(timeZone = BUSINESS_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(new Date()).reduce((map, part) => {
        if (part.type !== 'literal') {
            map[part.type] = part.value;
        }
        return map;
    }, {});

    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        hours: Number(parts.hour || 0),
        minutes: Number(parts.minute || 0)
    };
}

function isDateBeforeToday(value) {
    const dateKey = formatDateKey(value);
    if (!dateKey) return false;

    const todayKey = getTimeZoneNowParts().dateKey;

    return dateKey < todayKey;
}

function parseEventTimeToParts(value) {
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

function getReservationEventDateTime(reservation) {
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

function isReservationEventPast(reservation) {
    const dateKey = formatDateKey(reservation?.event_date);
    if (!dateKey) return false;

    const nowParts = getTimeZoneNowParts();
    if (dateKey < nowParts.dateKey) {
        return true;
    }

    if (dateKey > nowParts.dateKey) {
        return false;
    }

    const eventTimeParts = parseEventTimeToParts(reservation?.event_time) || { hours: 0, minutes: 0 };
    const eventMinutes = (eventTimeParts.hours * 60) + eventTimeParts.minutes;
    const currentMinutes = (nowParts.hours * 60) + nowParts.minutes;

    return eventMinutes <= currentMinutes;
}

function getEffectiveReservationStatus(reservation) {
    const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
    if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
        return normalizedStatus;
    }

    if (isReservationEventPast(reservation) && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
        return 'completed';
    }

    return normalizedStatus;
}

function getReservationStatusMeta(status) {
    const normalizedStatus = String(status || 'pending').toLowerCase();
    const labelMap = {
        pending: 'Pending Verification',
        approved: 'Approved',
        confirmed: 'Approved',
        cancelled: 'Cancelled',
        declined: 'Declined',
        completed: 'Completed',
        rescheduled: 'Rescheduled',
        resubmission_requested: 'Resubmission Requested'
    };

    return {
        key: normalizedStatus,
        label: labelMap[normalizedStatus] || (normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1))
    };
}

function getPaymentLabel(paymentType) {
    return PAYMENT_TYPE_META[paymentType]?.label || (paymentType || 'Payment');
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

function getRescheduleStatusMeta(status) {
    return RESCHEDULE_STATUS_META[String(status || 'pending').toLowerCase()] || RESCHEDULE_STATUS_META.pending;
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

function getReservationPackageName(reservation) {
    return reservation.package?.package_name || reservation.package_id || 'No package selected';
}

function getReservationAddOnName(reservation) {
    return reservation.add_on?.package_name || '';
}

function getReservationLocationLabel(reservation) {
    return String(reservation.location_type || '').toLowerCase() === 'onsite'
        ? 'Onsite - ELI Coffee'
        : `Offsite - ${reservation.venue_location || 'Venue not provided'}`;
}

function isReservationContractsColumnMissing(error, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

function getReservationContractMeta(reservationId) {
    const contract = getReservationContract(reservationId);
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    const reviewStatus = String(contract?.review_status || '').toLowerCase();
    const legacyReservationStatus = String(reservation?.status || '').toLowerCase();
    const resubmittedAt = contract?.resubmitted_at ? formatDateTime(contract.resubmitted_at) : '';

    if (reviewStatus === 'verified' || contract?.verified_date) {
        return {
            label: 'Verified contract',
            key: 'approved',
            statusKey: 'verified',
            verification: `Verified ${formatDateTime(contract.verified_date)}`,
            reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
            resubmittedAt,
            note: '',
            hasFile: Boolean(contract?.contract_url),
            contract
        };
    }

    if (reviewStatus === 'resubmission_requested' || (!reviewStatus && legacyReservationStatus === 'resubmission_requested')) {
        return {
            label: 'Resubmission requested',
            key: 'resubmission_requested',
            statusKey: 'resubmission_requested',
            verification: 'Please upload a corrected signed contract.',
            reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
            resubmittedAt,
            note: contract?.review_notes || 'Admin requested a corrected signed contract.',
            hasFile: Boolean(contract?.contract_url),
            contract
        };
    }

    if (reviewStatus === 'pending_review' && contract?.resubmitted_at) {
        return {
            label: 'Replacement submitted',
            key: 'pending',
            statusKey: 'replacement_submitted',
            verification: 'Your corrected contract is waiting for admin review.',
            reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
            resubmittedAt,
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
            resubmittedAt,
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
        resubmittedAt: '',
        note: '',
        hasFile: false,
        contract
    };
}

function getCompactPaymentSummaryLabel(paymentSummary) {
    const label = String(paymentSummary?.label || '').toLowerCase();

    if (label.includes('paid in full')) return 'Paid in Full';
    if (label.includes('remaining balance')) return 'Balance Due';
    if (label.includes('pending review')) return 'Pending Review';
    if (label.includes('reschedule fee')) return 'Reschedule Fee Pending';
    if (label.includes('overdue')) return 'Overdue';
    if (label.includes('initial payment')) return 'Initial Payment';
    if (label.includes('pending')) return 'Pending';
    return paymentSummary?.label || 'Pending';
}

function getCompactContractLabel(contractMeta) {
    const label = String(contractMeta?.label || '').toLowerCase();

    if (label.includes('verified')) return 'Verified';
    if (label.includes('resubmission')) return 'Resubmit';
    if (label.includes('submitted')) return 'Submitted';
    if (label.includes('pending review')) return 'Pending Review';
    if (label.includes('no contract')) return 'No Contract';
    return contractMeta?.label || 'Pending';
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
        canReview: isCompleted && !review && !dismissedAt
    };
}

function getReviewPromptCandidate() {
    return state.reservations
        .filter((reservation) => getReservationReviewState(reservation).canReview)
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

function getApprovedBasePaymentsTotal(reservationId) {
    return getNormalPayments(reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
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

    dueDate.setDate(dueDate.getDate() - PAYMENT_BALANCE_DUE_DAYS);
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
    return ['approved', 'confirmed', 'rescheduled', 'completed'].includes(String(reservation?.status || '').toLowerCase());
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
                options.push(buildPaymentOption(reservation, 'reschedule_fee', 3000, {
                    displayDescription: `${PAYMENT_TYPE_META.reschedule_fee.description} for ${formatDate(request.requested_date)}`,
                    rescheduleRequestId: request.reschedule_request_id
                }));
            }
        });

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
    const normalizedStatus = String(reservation.status || '').toLowerCase();
    const latestOpenRequest = getReservationRescheduleRequests(reservation.reservation_id)
        .find((request) => ['pending', 'approved_pending_payment'].includes(String(request.status || '').toLowerCase()));

    return ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus) && !latestOpenRequest;
}

function renderPaymentComposer(reservation) {
    const options = getAvailablePaymentOptions(reservation);
    const balance = getReservationBalanceDetails(reservation);
    if (!options.length) {
        if (!isReservationPaymentEnabled(reservation)) {
            return '<div class="payment-empty">Payment submission becomes available after admin approves this reservation.</div>';
        }
        const waitingMessage = getPendingBasePayment(reservation.reservation_id)
            ? 'Your latest reservation payment is still pending admin review.'
            : 'No new payment actions are available right now.';
        return `<div class="payment-empty">${escapeHtml(waitingMessage)}</div>`;
    }

    const defaultMethod = 'card';
    const canUseCash = options.some((option) => option.paymentType === 'full_payment');
    const actionIntro = balance.hasPartialPayment
        ? `This reservation is already confirmed. Settle the remaining balance by ${balance.dueDateLabel}.`
        : 'Choose the payment that works for you to confirm this reservation.';
    const methodChips = Object.entries(PAYMENT_METHODS).map(([method, meta]) => `
        <button
            type="button"
            class="res-choice-chip payment-choice-card res-payment-method ${method === defaultMethod ? 'active' : ''}"
            data-method="${escapeHtml(method)}"
            ${method === 'cash' && !canUseCash ? 'disabled' : ''}
        >
            <span class="payment-method-main">
                <strong>${escapeHtml(meta.label)}</strong>
            </span>
            ${method === 'cash' ? '<span class="payment-method-subcopy">Pay in person</span>' : ''}
            <span class="payment-choice-check" aria-hidden="true"></span>
        </button>
    `).join('');

    const optionChips = options.map((option, index) => `
        <button
            type="button"
            class="res-choice-chip payment-choice-card payment-type-card res-payment-type ${index === 0 ? 'active' : ''}"
            data-payment-option="${index}"
            data-payment-type="${escapeHtml(option.paymentType)}"
            data-amount="${escapeHtml(option.amount)}"
            data-reschedule-request-id="${escapeHtml(option.rescheduleRequestId || '')}"
            data-display-label="${escapeHtml(option.displayLabel || option.label)}"
            data-display-description="${escapeHtml(option.displayDescription || option.description)}"
        >
            <div class="payment-type-head">
                <strong>${escapeHtml(option.displayLabel || option.label)}</strong>
            </div>
            <span class="payment-choice-amount">${escapeHtml(formatCurrency(option.amount))}</span>
            <span class="payment-choice-copy">${escapeHtml(option.displayDescription || option.description)}</span>
        </button>
    `).join('');

    return `
        <div class="payment-composer" data-reservation-id="${escapeHtml(reservation.reservation_id)}" data-cash-enabled="${canUseCash ? 'true' : 'false'}">
            <div class="payment-flow-intro">${escapeHtml(actionIntro)}</div>
            <section class="payment-action-card payment-selection-card">
                <div class="payment-panel-minihead">
                    <div class="payment-step-head">
                        <span class="payment-step-number">1</span>
                        <div class="payment-step-body">
                            <div class="payment-step-title">Payment Selection</div>
                            <div class="payment-step-copy">Choose your method, then send the next required payment for this reservation.</div>
                        </div>
                    </div>
                </div>
                <div class="payment-selection-stack">
                    <div class="payment-selection-group">
                        <div class="payment-selection-label">Payment Method</div>
                        <div class="payment-card-grid payment-method-grid">${methodChips}</div>
                    </div>
                    <div class="payment-selection-group">
                        <div class="payment-selection-label">Payment Type</div>
                        <div class="payment-card-grid payment-type-grid">${optionChips}</div>
                    </div>
                </div>
                <div class="payment-selection-summary">
                    <div class="payment-selection-summary-title" data-selection-summary>
                        Selected: ${escapeHtml(PAYMENT_METHODS[defaultMethod].label)} / ${escapeHtml(options[0].displayLabel || options[0].label)} / ${escapeHtml(formatCurrency(options[0].amount))}
                    </div>
                    <div class="payment-selection-summary-note">
                        <span class="payment-selection-summary-icon" aria-hidden="true">&#9432;</span>
                        <span>Amounts are system-defined so customers cannot submit mismatched payment totals.</span>
                    </div>
                </div>
                <div class="payment-method-copy" data-method-helper>${escapeHtml(PAYMENT_METHODS[defaultMethod].helper)}</div>
                <div class="payment-channel-box" data-payment-channel></div>
            </section>
            <section class="payment-action-card payment-details-card">
                <div class="payment-panel-minihead">
                    <div class="payment-step-head">
                        <span class="payment-step-number">2</span>
                        <div class="payment-step-body">
                            <div class="payment-step-title">Payment Details</div>
                            <div class="payment-step-copy">Enter the details that match the payment method you selected.</div>
                        </div>
                    </div>
                </div>
                <div class="payment-form-grid">
                    <div class="payment-form-row">
                        <div class="payment-field payment-reference-field">
                            <label>Reference / transaction number</label>
                            <input type="text" data-field="reference_number" placeholder="e.g. 1234567890">
                        </div>
                        <div class="payment-field payment-amount-field">
                            <label>Amount paid</label>
                            <input type="text" data-field="amount" readonly value="${escapeHtml(formatCurrency(options[0].amount))}">
                        </div>
                    </div>
                    <div class="payment-form-row">
                        <div class="payment-field payment-payment-date-field">
                            <label>Date of payment</label>
                            <input type="date" data-field="payment_date">
                        </div>
                        <div class="payment-field payment-cash-date-field" hidden>
                            <label>Date of arrival at the cafe</label>
                            <input type="date" data-field="cash_payment_date">
                        </div>
                    </div>
                    <div class="payment-field full">
                        <label>Notes (optional)</label>
                        <textarea data-field="notes" placeholder="Add any note for the admin..."></textarea>
                    </div>
                </div>
            </section>
            <section class="payment-submit-dock">
                <div class="payment-step-head payment-step-head-compact payment-submit-head">
                    <span class="payment-step-number">3</span>
                    <div class="payment-step-body">
                        <div class="payment-step-title">Upload &amp; Submit</div>
                        <div class="payment-step-copy">Upload your proof if needed, then send the payment details for review.</div>
                    </div>
                </div>
                <div class="payment-submit-layout">
                    <div class="payment-proof-field">
                        <div class="payment-proof-box payment-proof-dock">
                            <label>Upload proof of payment</label>
                            <label class="payment-upload-control">
                                <input type="file" data-field="proof_file" accept="image/png,image/jpeg,image/jpg,image/webp" hidden>
                                <span class="payment-upload-button">Choose File</span>
                                <span class="payment-upload-name" data-proof-filename>No file chosen</span>
                            </label>
                            <p class="payment-proof-note">Preferred proof: screenshot or image file. Accepted formats: JPG, JPEG, PNG, WEBP. Maximum 10MB.</p>
                        </div>
                    </div>
                    <div class="payment-submit-column">
                        <div class="payment-submit-copy" data-submit-step-copy>Upload your proof if needed, then send the payment details for review.</div>
                        <div class="payment-actions">
                            <button type="button" class="res-primary-btn submit-payment-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Submit Payment</button>
                        </div>
                        <p class="res-form-message" data-form-message></p>
                    </div>
                </div>
            </section>
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

function buildReservationCard(reservation, view) {
    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation));
    const paymentSummary = getSharedPaymentSummary(
        reservation,
        state.paymentsByReservationId,
        state.reschedulesByReservationId,
        { formatDate }
    );
    const balance = getSharedReservationBalanceDetails(reservation, state.paymentsByReservationId, { formatDate });
    const paymentEntries = getSharedReservationPayments(state.paymentsByReservationId, reservation.reservation_id);
    const paymentModuleEnabled = isSharedReservationPaymentEnabled(reservation) || paymentEntries.length > 0;
    const contractMeta = getReservationContractMeta(reservation.reservation_id);
    const packageName = getReservationPackageName(reservation);
    const location = getReservationLocationLabel(reservation);
    const paymentActionLabel = balance.remainingBalance <= 0
        ? 'View Payment'
        : balance.hasPartialPayment
            ? 'Pay Remaining Balance'
            : paymentEntries.length > 0 ? 'Manage Payment' : 'Continue Payment';
    const canManagePayments = paymentModuleEnabled && view === 'active';
    const compactPaymentLabel = getCompactPaymentSummaryLabel(paymentSummary);
    const compactContractLabel = getCompactContractLabel(contractMeta);

    return `
        <article class="reservation-summary-card${view === 'past' ? ' past' : ''}">
            <div class="reservation-summary-main">
                <div class="reservation-summary-top">
                    <div class="reservation-summary-title-row">
                        <h3>${escapeHtml(reservation.event_type || 'Event')}</h3>
                        <span class="res-status ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>
                    </div>
                    <div>
                        <p class="reservation-summary-package">${escapeHtml(packageName)}</p>
                    </div>
                </div>
                <div class="reservation-summary-meta">
                    <div class="reservation-meta-item reservation-meta-item-date">
                        <strong>${escapeHtml(formatShortDate(reservation.event_date))}</strong>
                        <span>${escapeHtml(reservation.event_time || 'No time selected')}</span>
                    </div>
                    <div class="reservation-meta-item">
                        <strong>${escapeHtml(String(reservation.guest_count || 0))} Guests</strong>
                    </div>
                    <div class="reservation-meta-item">
                        <strong>${escapeHtml(location)}</strong>
                    </div>
                </div>
                <div class="reservation-summary-foot">
                    <div class="reservation-summary-info-line">
                        <span class="reservation-inline-group">
                            <span class="reservation-inline-label">Payment</span>
                            <strong class="reservation-inline-value ${escapeHtml(paymentSummary.key)}">${escapeHtml(compactPaymentLabel)}</strong>
                        </span>
                        <span class="reservation-inline-group">
                            <span class="reservation-inline-label">Contract</span>
                            <strong class="reservation-inline-value ${escapeHtml(contractMeta.key)}">${escapeHtml(compactContractLabel)}</strong>
                        </span>
                    </div>
                    <div class="reservation-balance-strip">
                        <div class="reservation-balance-item">
                            <span class="reservation-balance-label">Approved</span>
                            <strong class="reservation-balance-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                        </div>
                        <div class="reservation-balance-item">
                            <span class="reservation-balance-label">Remaining Balance</span>
                            <strong class="reservation-balance-value ${escapeHtml(balance.toneKey)}">${escapeHtml(balance.remainingBalance <= 0 ? 'Paid' : formatCurrency(balance.remainingBalance))}</strong>
                        </div>
                        <div class="reservation-balance-item">
                            <span class="reservation-balance-label">Pay By</span>
                            <strong class="reservation-balance-value ${escapeHtml(balance.isPastDue ? 'rejected' : 'neutral')}">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)}</strong>
                        </div>
                    </div>
                </div>
            </div>
            <div class="reservation-summary-side">
                <div class="reservation-total-block">
                    <span class="reservation-total-label">Total</span>
                    <strong class="reservation-total-value">${escapeHtml(formatCurrency(reservation.total_price))}</strong>
                </div>
                <div class="reservation-summary-actions">
                    <button type="button" class="res-secondary-btn open-reservation-details-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">View Details</button>
                    ${canManagePayments ? `<button type="button" class="res-primary-btn open-payments-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">${escapeHtml(paymentActionLabel)}</button>` : ''}
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
            <div class="empty-icon">Reservations</div>
            <h3>${copy.title}</h3>
            <p>${copy.message}</p>
            ${view === 'active' ? '<a href="/reservations.html" class="res-book-btn">Book an Event</a>' : ''}
        </div>
    `;
}

function buildReservationReviewSection(reservation) {
    const { review, isCompleted, isDismissed, canReview, dismissedAt } = getReservationReviewState(reservation);

    if (!isCompleted) {
        return '';
    }

    if (review) {
        return `
            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Your Review</h3>
                        <p>This reservation is complete and your feedback has already been saved.</p>
                    </div>
                </div>
                <div class="reservation-review-card">
                    <div class="reservation-review-top">
                        <div class="reservation-review-stars" aria-label="${escapeHtml(getReviewRatingLabel(review.rating))}">
                            ${buildReviewStarsMarkup(review.rating)}
                        </div>
                        <span class="reservation-review-score">${escapeHtml(`${Number(review.rating || 0)}/5`)}</span>
                    </div>
                    <div class="reservation-review-copy">${escapeHtml(review.comment || 'No comment added.')}</div>
                    <div class="reservation-review-meta">Submitted on ${escapeHtml(formatDateTime(review.created_at))}</div>
                </div>
            </section>
        `;
    }

    if (isDismissed) {
        return `
            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Your Review</h3>
                        <p>This reservation is complete. You chose not to leave a review for it.</p>
                    </div>
                </div>
                <div class="reservation-inline-note">Review skipped${dismissedAt ? ` on ${escapeHtml(formatDateTime(dismissedAt))}` : ''}.</div>
            </section>
        `;
    }

    if (canReview) {
        return `
            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Your Review</h3>
                        <p>This reservation is complete and you can still leave a review whenever you are ready.</p>
                    </div>
                </div>
                <div class="reservation-inline-note">Share a quick rating and optional comment about this completed reservation.</div>
                <div class="reservation-details-actions">
                    <button type="button" class="res-secondary-btn open-review-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Leave a Review</button>
                </div>
            </section>
        `;
    }

    return '';
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

function renderReservationDetailsModal(reservationId = state.reservationDetailsReservationId) {
    if (!reservationDetailsView || !reservationId) return;

    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) {
        closeReservationDetailsModal();
        return;
    }

    const reservationStatus = getReservationStatusMeta(getEffectiveReservationStatus(reservation));
    const paymentSummary = getSharedPaymentSummary(
        reservation,
        state.paymentsByReservationId,
        state.reschedulesByReservationId,
        { formatDate }
    );
    const balance = getSharedReservationBalanceDetails(reservation, state.paymentsByReservationId, { formatDate });
    const paymentEntries = getSharedReservationPayments(state.paymentsByReservationId, reservation.reservation_id);
    const paymentModuleEnabled = isSharedReservationPaymentEnabled(reservation) || paymentEntries.length > 0;
    const contract = getReservationContract(reservation.reservation_id);
    const contractMeta = getReservationContractMeta(reservation.reservation_id);
    const addOnName = getReservationAddOnName(reservation);
    const canReschedule = canRescheduleReservation(reservation);
    const latestRescheduleRequest = getReservationRescheduleRequests(reservation.reservation_id)[0] || null;

    reservationDetailsView.innerHTML = `
        <div class="reservation-details-shell">
            <section class="reservation-details-hero">
                <div>
                    <div class="reservation-details-name">${escapeHtml(reservation.event_type || 'Event')}</div>
                    <div class="reservation-details-subline">${escapeHtml(getReservationPackageName(reservation))}</div>
                </div>
                <div class="reservation-details-badges">
                    <span class="res-status ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>
                    <span class="reservation-summary-chip ${escapeHtml(paymentSummary.key)}">${escapeHtml(paymentSummary.label)}</span>
                </div>
            </section>

            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Reservation Summary</h3>
                        <p>Everything tied to this booking, including the uploaded contract.</p>
                    </div>
                </div>
                <div class="reservation-details-grid">
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Reservation ID</span>
                        <strong class="reservation-detail-value">${escapeHtml(reservation.reservation_id)}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Submitted</span>
                        <strong class="reservation-detail-value">${escapeHtml(formatDateTime(reservation.created_at))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Event date</span>
                        <strong class="reservation-detail-value">${escapeHtml(formatDate(reservation.event_date))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Start time</span>
                        <strong class="reservation-detail-value">${escapeHtml(reservation.event_time || 'No time selected')}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Guest count</span>
                        <strong class="reservation-detail-value">${escapeHtml(String(reservation.guest_count || 0))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Location</span>
                        <strong class="reservation-detail-value">${escapeHtml(getReservationLocationLabel(reservation))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Package</span>
                        <strong class="reservation-detail-value">${escapeHtml(getReservationPackageName(reservation))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Add-on</span>
                        <strong class="reservation-detail-value">${escapeHtml(addOnName || 'No add-on selected')}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Total amount</span>
                        <strong class="reservation-detail-value">${escapeHtml(formatCurrency(reservation.total_price))}</strong>
                    </div>
                    <div class="reservation-detail-field full">
                        <span class="reservation-detail-label">Special requests</span>
                        <strong class="reservation-detail-value">${escapeHtml(reservation.special_requests || 'No notes provided.')}</strong>
                    </div>
                </div>
            </section>

            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Contract</h3>
                        <p>Signed reservation contracts stay available here for reference and re-upload when admin requests corrections.</p>
                    </div>
                </div>
                <div class="reservation-details-grid">
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Contract status</span>
                        <strong class="reservation-detail-value">${escapeHtml(contractMeta.label)}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Verification</span>
                        <strong class="reservation-detail-value">${escapeHtml(contractMeta.verification)}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Last reviewed</span>
                        <strong class="reservation-detail-value">${escapeHtml(contractMeta.reviewedAt || 'Not reviewed yet')}</strong>
                    </div>
                    ${contractMeta.resubmittedAt ? `
                        <div class="reservation-detail-field">
                            <span class="reservation-detail-label">Replacement sent</span>
                            <strong class="reservation-detail-value">${escapeHtml(contractMeta.resubmittedAt)}</strong>
                        </div>
                    ` : ''}
                    <div class="reservation-detail-field full">
                        <span class="reservation-detail-label">Admin note</span>
                        <strong class="reservation-detail-value">${escapeHtml(contractMeta.note || 'No correction note from admin.')}</strong>
                    </div>
                </div>
                <div class="reservation-details-actions">
                    ${contract?.contract_url
                        ? `<a class="res-primary-btn reservation-link-btn" href="${escapeHtml(contract.contract_url)}" target="_blank" rel="noopener noreferrer">View Signed Uploaded Contract</a>`
                        : '<span class="reservation-inline-note">Your signed upload will appear here once the contract is submitted.</span>'}
                </div>
                ${contractMeta.statusKey === 'resubmission_requested' ? `
                    <div class="reservation-contract-reupload">
                        <div class="reservation-reupload-alert">
                            Admin asked for a corrected signed contract. Upload the updated file here to send it back for review.
                        </div>
                        <div class="payment-proof-box">
                            <label class="payment-field full" for="replacement-contract-file">
                                <span class="reservation-detail-label">Replacement signed contract</span>
                                <div class="payment-upload-control">
                                    <label class="payment-upload-button" for="replacement-contract-file">Choose File</label>
                                    <span class="payment-upload-name" data-contract-filename>No file chosen</span>
                                </div>
                                <input
                                    id="replacement-contract-file"
                                    type="file"
                                    accept=".pdf,.jpg,.jpeg,.png"
                                    data-field="replacement_contract"
                                    data-reservation-id="${escapeHtml(reservation.reservation_id)}"
                                    hidden
                                />
                            </label>
                            <p class="payment-proof-note">Accepted formats: PDF, JPG, JPEG, and PNG. Maximum 10MB. Upload the corrected signed contract only.</p>
                        </div>
                        <div class="reservation-details-actions">
                            <button
                                type="button"
                                class="res-primary-btn"
                                data-action="submit-contract-resubmission"
                                data-reservation-id="${escapeHtml(reservation.reservation_id)}"
                            >
                                Submit Replacement Contract
                            </button>
                        </div>
                        <p class="account-modal-message" data-contract-resubmission-message></p>
                    </div>
                ` : ''}
            </section>

            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Payment Progress</h3>
                        <p>Track what has been approved, what remains, and when the balance should be settled.</p>
                    </div>
                </div>
                <div class="reservation-details-grid">
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Current status</span>
                        <strong class="reservation-detail-value">${escapeHtml(paymentSummary.label)}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Approved payments</span>
                        <strong class="reservation-detail-value">${escapeHtml(formatCurrency(balance.approvedBaseTotal))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Remaining balance</span>
                        <strong class="reservation-detail-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Paid in full' : formatCurrency(balance.remainingBalance))}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Pay by</span>
                        <strong class="reservation-detail-value">${escapeHtml(balance.remainingBalance <= 0 ? 'Completed' : balance.dueDateLabel)}</strong>
                    </div>
                </div>
                <div class="reservation-inline-note">${escapeHtml(balance.helperText)}</div>
                ${paymentModuleEnabled ? `
                    <div class="reservation-details-actions">
                        <button type="button" class="res-primary-btn open-payments-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Open Payment Page</button>
                    </div>
                ` : '<div class="reservation-inline-note">Payments will unlock after admin approves this reservation.</div>'}
            </section>

            <section class="reservation-details-section">
                <div class="reservation-details-section-head">
                    <div>
                        <h3>Reschedule</h3>
                        <p>Request a new date and time only when this booking is eligible.</p>
                    </div>
                </div>
                <div class="reservation-details-grid">
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Latest request</span>
                        <strong class="reservation-detail-value">${escapeHtml(latestRescheduleRequest ? getRescheduleStatusMeta(latestRescheduleRequest.status).label : 'No reschedule request yet')}</strong>
                    </div>
                    <div class="reservation-detail-field">
                        <span class="reservation-detail-label">Requested schedule</span>
                        <strong class="reservation-detail-value">${escapeHtml(latestRescheduleRequest ? `${formatDate(latestRescheduleRequest.requested_date)} at ${latestRescheduleRequest.requested_time || 'No time selected'}` : 'No changes requested')}</strong>
                    </div>
                </div>
                ${canReschedule ? `
                    <div class="reservation-details-actions">
                        <button type="button" class="res-secondary-btn open-reschedule-btn" data-reservation-id="${escapeHtml(reservation.reservation_id)}">Request Reschedule</button>
                    </div>
                ` : ''}
            </section>

            ${buildReservationReviewSection(reservation)}
        </div>
    `;

    state.reservationDetailsReservationId = reservation.reservation_id;
    reservationDetailsBackdrop?.classList.remove('hidden');
    reservationDetailsBackdrop?.setAttribute('aria-hidden', 'false');
}

function closeReservationDetailsModal() {
    state.reservationDetailsReservationId = null;
    reservationDetailsBackdrop?.classList.add('hidden');
    reservationDetailsBackdrop?.setAttribute('aria-hidden', 'true');
}

function syncPaymentComposerState(section) {
    if (!section) return;

    const cashEnabled = section.dataset.cashEnabled === 'true';
    let activeMethod = section.querySelector('.res-payment-method.active')?.dataset.method || 'card';
    let activeTypeChip = section.querySelector('.res-payment-type.active');
    const fullPaymentChip = section.querySelector('.res-payment-type[data-payment-type="full_payment"]');
    const paymentTypeChips = Array.from(section.querySelectorAll('.res-payment-type'));

    if (activeMethod === 'cash' && !cashEnabled) {
        const cashChip = section.querySelector('.res-payment-method[data-method="cash"]');
        const firstNonCashChip = section.querySelector('.res-payment-method:not([data-method="cash"])');
        cashChip?.classList.remove('active');
        firstNonCashChip?.classList.add('active');
        activeMethod = firstNonCashChip?.dataset.method || 'card';
    }

    paymentTypeChips.forEach((chip) => {
        const shouldHide = activeMethod === 'cash' && chip.dataset.paymentType !== 'full_payment';
        chip.hidden = shouldHide;
        if (shouldHide) chip.classList.remove('active');
    });

    if (activeMethod === 'cash' && fullPaymentChip) {
        fullPaymentChip.hidden = false;
        if (!fullPaymentChip.classList.contains('active')) {
            paymentTypeChips.forEach((chip) => chip.classList.remove('active'));
            fullPaymentChip.classList.add('active');
        }
        activeTypeChip = fullPaymentChip;
    } else {
        const visibleActiveChip = paymentTypeChips.find((chip) => !chip.hidden && chip.classList.contains('active'));
        if (!visibleActiveChip) {
            paymentTypeChips.find((chip) => !chip.hidden)?.classList.add('active');
        }
        activeTypeChip = section.querySelector('.res-payment-type.active');
    }

    const amount = Number(activeTypeChip?.dataset.amount || 0);
    const activeDisplayLabel = activeTypeChip?.dataset.displayLabel || getPaymentLabel(activeTypeChip?.dataset.paymentType || '');
    const activeDisplayDescription = activeTypeChip?.dataset.displayDescription || '';
    const methodHelperEl = section.querySelector('[data-method-helper]');
    const channelBoxEl = section.querySelector('[data-payment-channel]');
    const selectionSummaryEl = section.querySelector('[data-selection-summary]');
    const amountInput = section.querySelector('[data-field="amount"]');
    const amountField = section.querySelector('.payment-amount-field');
    const referenceField = section.querySelector('.payment-reference-field');
    const paymentDateField = section.querySelector('.payment-payment-date-field');
    const cashDateField = section.querySelector('.payment-cash-date-field');
    const proofField = section.querySelector('.payment-proof-field');
    const proofInput = section.querySelector('[data-field="proof_file"]');
    const proofFilenameEl = section.querySelector('[data-proof-filename]');
    const submitStepCopy = section.querySelector('[data-submit-step-copy]');

    if (methodHelperEl) {
        const methodHelper = PAYMENT_METHODS[activeMethod]?.helper || '';
        methodHelperEl.textContent = activeMethod === 'cash'
            ? `${methodHelper} Cash is available for full payment only.`
            : methodHelper;
    }

    if (channelBoxEl) {
        const channel = PAYMENT_METHODS[activeMethod]?.channel;
        if (channel && activeMethod !== 'cash') {
            channelBoxEl.hidden = false;
            channelBoxEl.innerHTML = `
                <div class="payment-channel-kicker">Payment Instructions</div>
                <div class="payment-channel-title">Send your payment to:</div>
                <div class="payment-channel-copy">${escapeHtml(channel.title)}</div>
                <ul class="payment-channel-list">
                    ${channel.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
                </ul>
            `;
        } else {
            channelBoxEl.hidden = true;
            channelBoxEl.innerHTML = '';
        }
    }

    if (selectionSummaryEl && activeTypeChip) {
        selectionSummaryEl.textContent = `Selected: ${PAYMENT_METHODS[activeMethod]?.label || activeMethod} / ${activeDisplayLabel} / ${formatCurrency(amount)}`;
    }

    if (amountInput) {
        amountInput.value = formatCurrency(amount);
    }

    const isCash = activeMethod === 'cash';
    if (submitStepCopy) {
        submitStepCopy.textContent = isCash
            ? `${activeDisplayDescription || 'Review the payment details.'} Choose when you will visit the cafe to complete this cash payment.`
            : `${activeDisplayDescription || 'Review the payment details.'} Upload your proof, then send the payment details for review.`;
    }
    if (amountField) {
        amountField.hidden = isCash;
        amountField.style.display = isCash ? 'none' : '';
    }
    if (referenceField) {
        referenceField.hidden = isCash;
        referenceField.style.display = isCash ? 'none' : '';
    }
    if (paymentDateField) {
        paymentDateField.hidden = isCash;
        paymentDateField.style.display = isCash ? 'none' : '';
    }
    if (cashDateField) {
        cashDateField.hidden = !isCash;
        cashDateField.style.display = isCash ? '' : 'none';
    }
    if (proofField) {
        proofField.hidden = isCash;
        proofField.style.display = isCash ? 'none' : '';
    }
    if (isCash && proofInput) {
        proofInput.value = '';
    }
    if (isCash && proofFilenameEl) {
        proofFilenameEl.textContent = 'No file chosen';
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
    const title = currentView === 'past' ? 'Past Reservations' : 'Active Reservations';
    const copy = currentView === 'past'
        ? 'Completed, previous, and archived bookings.'
        : 'Upcoming and currently active bookings.';

    reservationsList.innerHTML = `
        <div class="reservation-hub">
            <div class="reservation-view-switch" role="tablist" aria-label="Reservation views">
                <button
                    type="button"
                    class="reservation-view-tab ${currentView === 'active' ? 'active' : ''}"
                    data-reservation-view="active"
                    aria-pressed="${currentView === 'active' ? 'true' : 'false'}"
                >
                    Active Reservations <span>${active.length}</span>
                </button>
                <button
                    type="button"
                    class="reservation-view-tab ${currentView === 'past' ? 'active' : ''}"
                    data-reservation-view="past"
                    aria-pressed="${currentView === 'past' ? 'true' : 'false'}"
                >
                    Past Reservations <span>${past.length}</span>
                </button>
            </div>
            <div class="reservation-panel">
                <div class="reservation-panel-head">
                    <div>
                        <h3>${title}</h3>
                        <p>${copy}</p>
                    </div>
                </div>
                <div class="reservation-panel-list">
                    ${currentReservations.length ? currentReservations.map((reservation) => buildReservationCard(reservation, currentView)).join('') : buildReservationEmptyState(currentView)}
                </div>
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
    paymentsList.querySelectorAll('.payment-composer').forEach((section) => syncPaymentComposerState(section));
}

function setInlineMessage(container, message, type = '') {
    if (!container) return;
    container.textContent = message;
    container.className = `res-form-message${type ? ` ${type}` : ''}`;
}

function setReservationDetailsMessage(message, isError = false) {
    const messageEl = reservationDetailsView?.querySelector('[data-contract-resubmission-message]');
    if (!messageEl) return;
    messageEl.textContent = message;
    messageEl.classList.remove('error', 'success');
    if (message) {
        messageEl.classList.add(isError ? 'error' : 'success');
    }
}

function openSubmissionFeedbackModal({
    eyebrow = 'Contract Resubmitted',
    title = 'Replacement Contract Submitted',
    copy = 'Your corrected signed contract was sent to the admin for review.'
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

async function uploadPaymentProof(file) {
    if (!file) return '';

    if (file.size > CLOUDINARY_CONFIG.maxFileSize) {
        throw new Error('Proof file must be 10MB or smaller.');
    }

    if (Number(file.size || 0) <= 0) {
        throw new Error('The selected proof file is empty. Please choose a valid image.');
    }

    const mimeType = String(file.type || '').toLowerCase();
    const extension = `.${String(file.name || '').toLowerCase().split('.').pop()}`;
    const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
    const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

    if (!allowedMimeTypes.has(mimeType) && !allowedExtensions.has(extension)) {
        throw new Error('Please upload the proof of payment as a JPG, JPEG, PNG, or WEBP image.');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
    formData.append('folder', CLOUDINARY_CONFIG.paymentFolder);

    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`,
        {
            method: 'POST',
            body: formData
        }
    );

    if (!response.ok) {
        throw new Error('Failed to upload payment proof.');
    }

    const result = await response.json();
    return result.secure_url || '';
}

async function uploadContractFile(file) {
    if (!file) return '';

    if (file.size > CLOUDINARY_CONFIG.maxFileSize) {
        throw new Error('Contract file must be 10MB or smaller.');
    }

    if (Number(file.size || 0) <= 0) {
        throw new Error('The selected contract file is empty. Please choose a valid file.');
    }

    const mimeType = String(file.type || '').toLowerCase();
    const extension = `.${String(file.name || '').toLowerCase().split('.').pop()}`;
    const allowedTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);
    const allowedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

    if (!allowedTypes.has(mimeType) && !allowedExtensions.has(extension)) {
        throw new Error('Please upload the signed contract as a PDF, JPG, JPEG, or PNG file.');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
    formData.append('folder', CLOUDINARY_CONFIG.contractFolder);

    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`,
        {
            method: 'POST',
            body: formData
        }
    );

    if (!response.ok) {
        throw new Error('Failed to upload the replacement signed contract.');
    }

    const result = await response.json();
    return result.secure_url || '';
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
            console.warn('Reviews table is not available in Supabase yet:', error.message);
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

    try {
        const baseReservationSelect = `
            reservation_id,
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
            console.warn('review_prompt_dismissed_at is missing in Supabase; loading reservations without review prompt support.');
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
        if (state.reservationDetailsReservationId) {
            renderReservationDetailsModal(state.reservationDetailsReservationId);
        }
        if (!state.reviewPromptEvaluated) {
            state.reviewPromptEvaluated = true;
            openEligibleReviewPrompt();
        }
    } catch (error) {
        console.error('Failed to load reservations:', error);
        if (reservationsList) {
            const reviewFeatureMessage = getReviewFeatureErrorMessage(error);
            reservationsList.innerHTML = `<p style="color:#c0392b;text-align:center;padding:40px 0;">Failed to load reservations: ${escapeHtml(reviewFeatureMessage)}.</p>`;
        }
        if (paymentsList) {
            paymentsList.innerHTML = '<p style="color:#c0392b;text-align:center;padding:40px 0;">Failed to load payments.</p>';
        }
    }
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
                        <span class="receipt-value">${escapeHtml(document.getElementById('sidebar-name')?.textContent || 'Customer')}</span>
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
    const [blackoutData, calendarAvailability] = await Promise.all([
        fetchBlackoutDates(supabase, state.rescheduleModal),
        fetchCalendarAvailability(supabase, {
            fromDate: range.fromDate,
            toDate: range.toDate
        })
    ]);

    state.rescheduleModal.closedDates = blackoutData.closedDates;
    state.rescheduleModal.blackoutDateColumn = blackoutData.blackoutDateColumn;
    state.rescheduleModal.blackoutReasonColumn = blackoutData.blackoutReasonColumn;
    state.rescheduleModal.calendarAvailability = calendarAvailability;
    state.rescheduleModal.month = month;
    state.rescheduleModal.selectedDate = '';
    state.rescheduleModal.selectedTime = reservation.event_time || '';
    state.rescheduleModal.selectedDateAvailability = null;
}

async function loadRescheduleCalendarMonth() {
    const range = getCalendarRange(state.rescheduleModal.month);
    state.rescheduleModal.calendarAvailability = await fetchCalendarAvailability(supabase, {
        fromDate: range.fromDate,
        toDate: range.toDate
    });
}

async function loadRescheduleSelectedDateAvailability(reservation) {
    if (!state.rescheduleModal.selectedDate) {
        state.rescheduleModal.selectedDateAvailability = null;
        return null;
    }

    const availability = await fetchDateAvailability(supabase, {
        eventDate: state.rescheduleModal.selectedDate,
        scope: getBookingScope(reservation),
        durationHours: getReservationDurationHours(reservation),
        excludeReservationId: reservation.reservation_id
    });
    state.rescheduleModal.selectedDateAvailability = availability;
    return availability;
}

function renderRescheduleTimes() {
    if (!rescheduleTimeGrid) return;

    const selectedTime = state.rescheduleModal.selectedTime;
    const selectedAvailability = state.rescheduleModal.selectedDateAvailability || {
        occupiedScopes: [],
        scopeTaken: false,
        blockedTimes: []
    };
    const blockedTimes = new Set(selectedAvailability.blockedTimes || []);
    rescheduleTimeGrid.innerHTML = TIMES.map((time) => `
        <button
            type="button"
            class="reschedule-time-btn ${selectedTime === time ? 'active' : ''} ${blockedTimes.has(time) || !state.rescheduleModal.selectedDate ? 'disabled' : ''}"
            data-time="${escapeHtml(time)}"
            ${blockedTimes.has(time) || !state.rescheduleModal.selectedDate ? 'disabled' : ''}
        >
            ${escapeHtml(time)}
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
        const dateAvailability = state.rescheduleModal.calendarAvailability.get(dateKey) || {
            occupiedScopes: [],
            isFullyBooked: false
        };
        const reservationScope = getBookingScope(reservation);
        const isBooked = reservationScope ? isScopeOccupied(dateAvailability.occupiedScopes, reservationScope) : false;
        const isCurrent = currentReservationDate === dateKey;
        const isAvailable = !isPastOrToday && !isClosed && !isBooked && !isCurrent;
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
            label = getAvailabilitySummaryMessage(dateAvailability.occupiedScopes, reservationScope);
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
    state.rescheduleModal.selectedDateAvailability = null;
    state.rescheduleModal.closedDates = new Set();
    rescheduleModalBackdrop?.classList.add('hidden');
    rescheduleModalBackdrop?.setAttribute('aria-hidden', 'true');
    rescheduleModalSubmit?.removeAttribute('disabled');
    setRescheduleModalMessage('');
}

async function openRescheduleModal(reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) return;

    state.rescheduleModal.reservationId = reservationId;
    if (rescheduleCurrentValue) {
        rescheduleCurrentValue.textContent = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;
    }

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

    rescheduleModalSubmit?.setAttribute('disabled', 'true');
    setRescheduleModalMessage('Submitting your reschedule request...');

    try {
        const latestAvailability = await loadRescheduleSelectedDateAvailability(reservation);
        if (latestAvailability?.scopeTaken) {
            state.rescheduleModal.selectedTime = '';
            renderRescheduleTimes();
            throw new Error(getAvailabilitySummaryMessage(latestAvailability.occupiedScopes, getBookingScope(reservation)));
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

async function submitPayment(section, reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    const messageEl = section?.querySelector('[data-form-message]');
    if (!section || !reservation) return;

    const activeMethod = section.querySelector('.res-payment-method.active')?.dataset.method || 'card';
    const activeOption = section.querySelector('.res-payment-type.active');

    if (!activeOption) {
        setInlineMessage(messageEl, 'Please choose a payment type first.', 'error');
        return;
    }

    const amount = Number(activeOption.dataset.amount || 0);
    const paymentType = activeOption.dataset.paymentType || '';
    const rescheduleRequestId = activeOption.dataset.rescheduleRequestId || null;
    const referenceNumber = section.querySelector('[data-field="reference_number"]')?.value.trim() || '';
    const paymentDate = section.querySelector('[data-field="payment_date"]')?.value || null;
    const cashPaymentDate = section.querySelector('[data-field="cash_payment_date"]')?.value || null;
    const notes = section.querySelector('[data-field="notes"]')?.value.trim() || '';
    const proofFile = section.querySelector('[data-field="proof_file"]')?.files?.[0] || null;

    if (!amount || amount <= 0) {
        setInlineMessage(messageEl, 'This payment option does not have a valid amount.', 'error');
        return;
    }

    if (activeMethod === 'cash') {
        if (!cashPaymentDate) {
            setInlineMessage(messageEl, 'Please choose the date you will visit the cafe to pay in cash.', 'error');
            return;
        }
    } else {
        if (!referenceNumber) {
            setInlineMessage(messageEl, 'Please enter your reference or transaction number.', 'error');
            return;
        }
        if (!paymentDate) {
            setInlineMessage(messageEl, 'Please choose the payment date.', 'error');
            return;
        }
        if (!proofFile) {
            setInlineMessage(messageEl, 'Please upload a proof of payment.', 'error');
            return;
        }
    }

    const submitBtn = section.querySelector('.submit-payment-btn');
    submitBtn?.setAttribute('disabled', 'true');
    setInlineMessage(
        messageEl,
        activeMethod === 'cash'
            ? 'Submitting payment details...'
            : 'Submitting payment details and processing OCR...'
    );

    try {
        const proofUrl = activeMethod === 'cash' ? '' : await uploadPaymentProof(proofFile);

        const payload = {
            reservation_id: reservation.reservation_id,
            reschedule_request_id: rescheduleRequestId || null,
            payment_type: paymentType,
            payment_method: activeMethod,
            amount,
            payment_status: 'pending_review',
            reference_number: activeMethod === 'cash' ? null : referenceNumber,
            payment_date: activeMethod === 'cash' ? null : paymentDate,
            notes: notes || null,
            proof_url: proofUrl || null,
            cash_payment_date: activeMethod === 'cash' ? cashPaymentDate : null,
            submitted_at: new Date().toISOString()
        };

        const { data: insertedRows, error } = await supabase
            .from('payment')
            .insert(payload)
            .select('payment_id')
            .limit(1);

        if (error) throw error;

        // ── OCR: fire-and-forget — failure never blocks the customer ──────────
        const newPaymentId = insertedRows?.[0]?.payment_id;
        let successMessage = 'Payment details submitted for admin review.';

        if (proofUrl && newPaymentId) {
            const { data: ocrData, error: ocrError } = await supabase.functions.invoke('ocr-payment', {
                body: { payment_id: newPaymentId, image_url: proofUrl }
            });

            if (ocrError) {
                console.warn('OCR invoke failed:', ocrError.message);
                successMessage = 'Payment details submitted for admin review, but OCR could not be processed yet.';
            } else if (ocrData?.saved === false) {
                console.warn('OCR save failed:', ocrData?.error || 'Unknown OCR save error');
                successMessage = 'Payment details submitted for admin review, but OCR could not be saved yet.';
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        setInlineMessage(messageEl, successMessage, 'success');
        await loadReservations();
    } catch (error) {
        submitBtn?.removeAttribute('disabled');
        setInlineMessage(messageEl, `Failed to submit payment: ${error.message}`, 'error');
    }
}

async function submitReplacementContract(reservationId) {
    const reservation = state.reservations.find((entry) => String(entry.reservation_id) === String(reservationId));
    const contract = getReservationContract(reservationId);
    const contractMeta = getReservationContractMeta(reservationId);
    const fileInput = reservationDetailsView?.querySelector(`[data-field="replacement_contract"][data-reservation-id="${reservationId}"]`);
    const submitBtn = reservationDetailsView?.querySelector(`[data-action="submit-contract-resubmission"][data-reservation-id="${reservationId}"]`);
    const replacementFile = fileInput?.files?.[0] || null;

    if (!reservation || !contract) {
        setReservationDetailsMessage('This reservation contract could not be found.', true);
        return;
    }

    if (contractMeta.statusKey !== 'resubmission_requested') {
        setReservationDetailsMessage('Contract replacement is only available after admin requests a resubmission.', true);
        return;
    }

    if (!replacementFile) {
        setReservationDetailsMessage('Please choose the corrected signed contract first.', true);
        return;
    }

    setReservationDetailsMessage('Uploading replacement contract...');
    submitBtn?.setAttribute('disabled', 'true');

    try {
        const contractUrl = await uploadContractFile(replacementFile);
        const resubmittedAt = new Date().toISOString();
        const updatePayload = {
            contract_url: contractUrl,
            review_status: 'pending_review',
            review_notes: null,
            reviewed_at: null,
            verified_date: null,
            resubmitted_at: resubmittedAt
        };

        let updateResult = await supabase
            .from('reservation_contracts')
            .update(updatePayload)
            .eq('reservation_id', reservationId)
            .select('reservation_id')
            .maybeSingle();

        if (updateResult.error && isReservationContractsColumnMissing(updateResult.error, 'resubmitted_at')) {
            const fallbackPayload = {
                contract_url: contractUrl,
                review_status: 'pending_review',
                review_notes: null,
                reviewed_at: null,
                verified_date: null
            };

            updateResult = await supabase
                .from('reservation_contracts')
                .update(fallbackPayload)
                .eq('reservation_id', reservationId)
                .select('reservation_id')
                .maybeSingle();
        }

        const { data, error } = updateResult;

        if (error) throw error;
        if (!data) {
            throw new Error('Your reservation contract could not be updated.');
        }

        setReservationDetailsMessage('Replacement contract submitted for admin review.');
        await loadReservations();
        openSubmissionFeedbackModal();
    } catch (error) {
        submitBtn?.removeAttribute('disabled');
        setReservationDetailsMessage(`Failed to submit replacement contract: ${error.message}`, true);
    }
}

function activateAccountSection(sectionKey) {
    const normalizedSection = ['profile', 'reservations'].includes(String(sectionKey || '').toLowerCase())
        ? String(sectionKey).toLowerCase()
        : 'profile';
    const navButtons = document.querySelectorAll('.account-nav-item[data-section]');
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
                renderReservations();
            }
            return;
        }

        const detailsBtn = event.target.closest('.open-reservation-details-btn');
        if (detailsBtn) {
            renderReservationDetailsModal(detailsBtn.dataset.reservationId);
            return;
        }

        const rescheduleBtn = event.target.closest('.open-reschedule-btn');
        if (rescheduleBtn) {
            await openRescheduleModal(rescheduleBtn.dataset.reservationId);
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
            closeReservationDetailsModal();
            window.location.href = buildCustomerPaymentUrl(reservationId);
        }
    });
}

function wireReservationDetailsModal() {
    reservationDetailsClose?.addEventListener('click', closeReservationDetailsModal);
    reservationDetailsDismiss?.addEventListener('click', closeReservationDetailsModal);
    reservationDetailsBackdrop?.addEventListener('click', (event) => {
        if (event.target === reservationDetailsBackdrop) {
            closeReservationDetailsModal();
        }
    });

    reservationDetailsView?.addEventListener('click', async (event) => {
        const openPaymentsBtn = event.target.closest('.open-payments-btn');
        if (openPaymentsBtn) {
            const reservationId = openPaymentsBtn.dataset.reservationId;
            closeReservationDetailsModal();
            window.location.href = buildCustomerPaymentUrl(reservationId);
            return;
        }

        const rescheduleBtn = event.target.closest('.open-reschedule-btn');
        if (rescheduleBtn) {
            closeReservationDetailsModal();
            await openRescheduleModal(rescheduleBtn.dataset.reservationId);
            return;
        }

        const reviewBtn = event.target.closest('.open-review-btn');
        if (reviewBtn) {
            closeReservationDetailsModal();
            openReviewPromptModal(reviewBtn.dataset.reservationId);
            return;
        }

        const contractSubmitBtn = event.target.closest('[data-action="submit-contract-resubmission"]');
        if (contractSubmitBtn) {
            await submitReplacementContract(contractSubmitBtn.dataset.reservationId);
        }
    });

    reservationDetailsView?.addEventListener('change', (event) => {
        const fileInput = event.target.closest('[data-field="replacement_contract"]');
        if (!fileInput) return;

        const filenameEl = reservationDetailsView.querySelector('[data-contract-filename]');
        const file = fileInput.files?.[0];
        if (filenameEl) {
            filenameEl.textContent = file?.name || 'No file chosen';
        }
    });
}

function wirePaymentActions() {
    paymentsList?.addEventListener('click', async (event) => {
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

        const methodChip = event.target.closest('.res-payment-method');
        if (methodChip) {
            const section = methodChip.closest('.payment-composer');
            section?.querySelectorAll('.res-payment-method').forEach((chip) => chip.classList.remove('active'));
            methodChip.classList.add('active');
            syncPaymentComposerState(section);
            return;
        }

        const typeChip = event.target.closest('.res-payment-type');
        if (typeChip) {
            const section = typeChip.closest('.payment-composer');
            section?.querySelectorAll('.res-payment-type').forEach((chip) => chip.classList.remove('active'));
            typeChip.classList.add('active');
            syncPaymentComposerState(section);
            return;
        }

        const receiptBtn = event.target.closest('.view-receipt-btn');
        if (receiptBtn) {
            openReceiptModal(receiptBtn.dataset.paymentId, receiptBtn.dataset.reservationId);
            return;
        }

        const submitBtn = event.target.closest('.submit-payment-btn');
        if (submitBtn) {
            const section = submitBtn.closest('.payment-composer');
            await submitPayment(section, submitBtn.dataset.reservationId);
        }
    });

    paymentsList?.addEventListener('change', (event) => {
        const fileInput = event.target.closest('[data-field="proof_file"]');
        if (!fileInput) return;

        const section = fileInput.closest('.payment-proof-box');
        const filenameEl = section?.querySelector('[data-proof-filename]');
        const file = fileInput.files?.[0];

        if (filenameEl) {
            filenameEl.textContent = file?.name || 'No file chosen';
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
        state.rescheduleModal.selectedTime = reservation.event_time || '';
        const availability = await loadRescheduleSelectedDateAvailability(reservation);
        renderRescheduleCalendar();
        renderRescheduleTimes();
        setRescheduleModalMessage(
            availability?.scopeTaken
                ? getAvailabilitySummaryMessage(availability.occupiedScopes, getBookingScope(reservation))
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
        console.warn('Profile email pre-check fallback:', error);
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
    const sidebarName = document.getElementById('sidebar-name');
    const sidebarEmail = document.getElementById('sidebar-email');
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

        if (sidebarName) sidebarName.textContent = displayName;
        if (sidebarEmail) sidebarEmail.textContent = confirmedEmail;
        if (firstNameInput) firstNameInput.value = state.profile.first_name || '';
        if (middleNameInput) middleNameInput.value = state.profile.middle_name || '';
        if (lastNameInput) lastNameInput.value = state.profile.last_name || '';
        if (emailInput) emailInput.value = confirmedEmail;
        if (phoneInput) phoneInput.value = state.profile.phone_number || '';
        if (dateInput) dateInput.value = formatDate(state.profile.date_registered);
        renderPendingEmailNotice(state.profile);
    } catch (error) {
        console.error('Failed to load profile:', error);
        setFormMessage(profileMessage, 'Unable to load the latest profile details right now.', 'error');
    }
}

function wireAccountNavigation() {
    const navButtons = document.querySelectorAll('.account-nav-item[data-section]');

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
        }
    });
}

function wirePasswordForm() {
    const passwordForm = document.getElementById('password-form');
    const passwordMessage = document.getElementById('password-msg');

    passwordForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const currentPassword = document.getElementById('current-password')?.value || '';
        const newPassword = document.getElementById('new-password')?.value || '';
        const confirmPassword = document.getElementById('confirm-new-password')?.value || '';

        if (newPassword.length < 8) {
            passwordMessage.textContent = 'New password must be at least 8 characters long.';
            return;
        }

        if (newPassword !== confirmPassword) {
            passwordMessage.textContent = 'New password and confirmation do not match.';
            return;
        }

        passwordMessage.textContent = 'Updating password...';

        try {
            const { error: signInError } = await supabase.auth.signInWithPassword({
                email: user.email,
                password: currentPassword
            });

            if (signInError) throw new Error('Current password is incorrect.');

            const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
            if (updateError) throw updateError;

            passwordMessage.textContent = 'Password updated successfully.';
            passwordForm.reset();
        } catch (error) {
            passwordMessage.textContent = `Failed to update password: ${error.message}`;
        }
    });
}

function wireLogout() {
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
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
            if (state.reservationDetailsReservationId) closeReservationDetailsModal();
            if (state.receiptModalPaymentId) closeReceiptModal();
            if (state.rescheduleModal.reservationId) closeRescheduleModal();
            if (state.reviewPromptReservationId) closeReviewPromptModal();
            if (submissionFeedbackBackdrop && !submissionFeedbackBackdrop.classList.contains('hidden')) {
                closeSubmissionFeedbackModal();
            }
        }
    });
}

wireAccountNavigation();
wireReservationActions();
wireReservationDetailsModal();
wirePaymentActions();
wireReceiptModal();
wireRescheduleModal();
wireReviewPromptModal();
wireSubmissionFeedbackModal();
wireProfileForm();
wirePasswordForm();
wireLogout();

await Promise.all([
    loadProfile(),
    loadReservations()
]);
