const CLOUDINARY_CONFIG = {
    cloudName: 'dtt707f1w',
    uploadPreset: 'eli_contracts',
    paymentFolder: 'payments',
    maxFileSize: 10 * 1024 * 1024
};

export const PAYMENT_METHODS = {
    gcash: {
        label: 'GCash',
        shortLabel: 'GCash',
        type: 'online',
        qrImage: '/images/qr-gcash.png',
        details: [
            { label: 'Account Name', value: 'Engeline Cerda', copyable: true },
            { label: 'GCash Number', value: '09983839455', copyable: true }
        ],
        helper: 'Scan the QR code or send to the GCash number above. Screenshot your payment confirmation and upload it as proof.'
    },
    maya: {
        label: 'Maya',
        shortLabel: 'Maya',
        type: 'online',
        qrImage: '/images/qr-maya.png',
        details: [
            { label: 'Account Name', value: 'Evangeline Cerda', copyable: true },
            { label: 'Maya Number', value: '09696210379', copyable: true }
        ],
        helper: 'Scan the QR code or send to the Maya number above. Screenshot your payment confirmation and upload it as proof.'
    },
    bpi: {
        label: 'BPI',
        shortLabel: 'Bank (BPI)',
        type: 'online',
        // No baked-in QR fallback for bank transfer — only shown if an
        // admin actually uploads one via the payment_method table.
        qrImage: '',
        details: [
            { label: 'Account Name', value: 'Engeline Cerda', copyable: true },
            { label: 'Account Number', value: '4039941106', copyable: true }
        ],
        helper: 'Transfer to the BPI account above. Upload your transaction receipt or screenshot as proof.'
    },
    card: {
        label: 'Card',
        shortLabel: 'Card',
        type: 'onsite',
        helper: 'Pay by card at the cafe on your visit date. The admin will confirm your payment manually.'
    },
    cash: {
        label: 'Cash',
        shortLabel: 'Cash',
        type: 'onsite',
        helper: 'Pay in cash at the cafe on your visit date. The admin will confirm your payment manually.'
    }
};

export const PAYMENT_METHOD_ORDER = ['gcash', 'maya', 'bpi', 'card', 'cash'];

// Maps a method's free-text `label` to the internal key used in
// PAYMENT_METHODS. Matched by substring (case-insensitive) since admins can
// name a method however they like (e.g. "GCash – Personal").
const DB_LABEL_TO_KEY = [
    { match: 'gcash', key: 'gcash' },
    { match: 'maya',  key: 'maya' },
    { match: 'bpi',   key: 'bpi' },
    { match: 'bank',  key: 'bpi' },
];

const DB_DETAIL_LABEL = {
    gcash: 'GCash Number',
    maya:  'Maya Number',
    bpi:   'Account Number',
};

function resolveMethodKey(row) {
    if (row.type === 'cash') return 'cash';
    const label = String(row.label || '').toLowerCase();
    const match = DB_LABEL_TO_KEY.find(({ match }) => label.includes(match));
    return match?.key || null;
}

/**
 * Fetches active payment methods from the `payment_method` table and patches
 * PAYMENT_METHODS in-place so every reference sees live DB data. Falls back
 * silently to the hardcoded defaults if the fetch fails.
 */
export async function loadDynamicPaymentMethods(supabase) {
    try {
        const { data, error } = await supabase
            .from('payment_method')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: false });

        if (error) throw error;
        if (!data || !data.length) return;

        // Use only the most recently sorted row per resolved key.
        const seen = new Set();
        for (const row of data) {
            const key = resolveMethodKey(row);
            if (!key || seen.has(key)) continue;
            seen.add(key);

            if (key === 'cash') {
                PAYMENT_METHODS.cash = {
                    ...PAYMENT_METHODS.cash,
                    helper: row.instructions || PAYMENT_METHODS.cash.helper,
                };
                continue;
            }

            const accountName   = row.account_name || '';
            const accountNumber = row.account_number || row.phone_number || '';
            const qrImage       = row.qr_image || PAYMENT_METHODS[key].qrImage;

            PAYMENT_METHODS[key] = {
                ...PAYMENT_METHODS[key],
                qrImage,
                details: [
                    { label: 'Account Name',       value: accountName,   copyable: true },
                    { label: DB_DETAIL_LABEL[key], value: accountNumber, copyable: true },
                ],
            };
        }

        console.log('[Payments] Payment methods loaded from DB.');
    } catch (err) {
        console.warn('[Payments] Could not load payment methods from DB, using defaults:', err?.message || err);
    }
}

export const PAYMENT_TYPE_META = {
    reservation_fee: { label: 'Reservation Fee', description: 'Fixed reservation fee' },
    down_payment: { label: 'Down Payment', description: '50% of your total amount' },
    partial_payment: { label: 'Custom Amount', description: 'Customer-specified partial payment' },
    full_payment: { label: 'Full Payment', description: 'Settle the remaining balance in full' },
    reschedule_fee: { label: 'Reschedule Fee', description: 'Fixed fee for approved reschedule requests' },
    cancellation_fee: { label: 'Cancellation Fee', description: 'Required fee to process the reservation cancellation' }
};

export const PAYMENT_STATUS_META = {
    pending_review: { label: 'Pending Review', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' }
};

// Reference-number format per remote method. These regexes MUST stay in
// sync with validate_payment_submission() in
// supabase/migrations/20260716_payment_overhaul.sql — that's the "one
// client+server validation map" split across the two languages a browser
// and Postgres actually share.
export const REFERENCE_NUMBER_PATTERNS = {
    gcash: { regex: /^\d{13}$/, hint: '13 digits', placeholder: 'e.g. 1234567890123' },
    maya: { regex: /^\d{12,13}$/, hint: '12–13 digits', placeholder: 'e.g. 123456789012' },
    bpi: { regex: /^[A-Za-z0-9]{10,13}$/, hint: '10–13 letters/numbers', placeholder: 'e.g. AB1234567890' }
};

export function validateReferenceNumber(method, value) {
    const pattern = REFERENCE_NUMBER_PATTERNS[method];
    if (!pattern) return true;
    return pattern.regex.test(String(value || '').trim());
}

export const RESERVATION_RULES_DEFAULTS = {
    min_advance_days: 14,
    max_advance_days: 365,
    min_pax: 20,
    max_pax: 150,
    deposit_pct: 30,
    full_payment_days: 7,
    auto_cancel_days: 5,
    contract_resubmission_days: 3
};

export const PAY_AT_CAFE_DEFAULTS = {
    card: 'Card payments are processed on our POS terminal at the counter.',
    cash: 'Pay in cash at the counter.'
};

/**
 * Reads the shared "reservation_rules" system_settings row. Falls back to
 * RESERVATION_RULES_DEFAULTS (kept identical to the trigger function's own
 * fallback) if the row is missing or the fetch fails, so the page still
 * works before an admin has ever saved this settings panel.
 */
export async function loadReservationRules(supabase) {
    try {
        const { data, error } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'reservation_rules')
            .maybeSingle();

        if (error || !data) return { ...RESERVATION_RULES_DEFAULTS };
        return { ...RESERVATION_RULES_DEFAULTS, ...JSON.parse(data.setting_value) };
    } catch {
        return { ...RESERVATION_RULES_DEFAULTS };
    }
}

export async function loadPayAtCafeInstructions(supabase) {
    try {
        const { data, error } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'pay_at_cafe_instructions')
            .maybeSingle();

        if (error || !data) return { ...PAY_AT_CAFE_DEFAULTS };
        return { ...PAY_AT_CAFE_DEFAULTS, ...JSON.parse(data.setting_value) };
    } catch {
        return { ...PAY_AT_CAFE_DEFAULTS };
    }
}

const ONSITE_RESERVATION_FEE = 999;
const PAYMENT_BALANCE_DUE_DAYS = 7;

const BASE_CUSTOMER_RESERVATION_SELECT = `
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
    package:package_id ( package_name, package_type ),
    add_on:add_on_id ( package_name, package_type )
`;

function safeFormatDate(formatDate, value) {
    if (typeof formatDate === 'function') {
        return formatDate(value);
    }
    return String(value || 'No date');
}

function safeFormatCurrency(value) {
    return `₱${Number(value || 0).toLocaleString()}`;
}

function isMissingColumnError(error, tableName, columnName) {
    const message = error?.message || '';
    return message.includes(`Could not find the '${columnName}' column`)
        || message.includes(`column ${tableName}.${columnName} does not exist`);
}

export function buildLocalDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

export function getTodayDateKey() {
    return buildLocalDateKey(new Date());
}

export function roundCurrency(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

export function getPaymentLabel(paymentType) {
    return PAYMENT_TYPE_META[paymentType]?.label || (paymentType || 'Payment');
}

export function getPaymentStatusMeta(status) {
    return PAYMENT_STATUS_META[String(status || 'pending_review').toLowerCase()] || PAYMENT_STATUS_META.pending_review;
}

export function getReservationPayments(paymentsByReservationId, reservationId) {
    return paymentsByReservationId?.[reservationId] || [];
}

export function getReservationReceipts(paymentsByReservationId, receiptsByPaymentId, reservationId) {
    return getReservationPayments(paymentsByReservationId, reservationId)
        .map((payment) => ({
            payment,
            receipt: receiptsByPaymentId?.[payment.payment_id] || null
        }))
        .filter((entry) => entry.receipt && String(entry.payment.payment_status || '').toLowerCase() === 'approved')
        .sort((left, right) => new Date(right.receipt.issued_at || 0) - new Date(left.receipt.issued_at || 0));
}

export function getNormalPayments(paymentsByReservationId, reservationId) {
    return getReservationPayments(paymentsByReservationId, reservationId).filter((payment) => !payment.reschedule_request_id);
}

export function getApprovedBasePaymentsTotal(paymentsByReservationId, reservationId) {
    return getNormalPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

export function getPendingBasePayment(paymentsByReservationId, reservationId) {
    return getNormalPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

export function getReservationBalanceDueDate(reservation) {
    const eventDateKey = String(reservation?.event_date || '').split('T')[0];
    if (!eventDateKey) return null;

    const dueDate = new Date(`${eventDateKey}T00:00:00`);
    if (Number.isNaN(dueDate.getTime())) return null;

    dueDate.setDate(dueDate.getDate() - PAYMENT_BALANCE_DUE_DAYS);
    return dueDate;
}

export function getReservationBalanceDetails(reservation, paymentsByReservationId, options = {}) {
    const reservationId = reservation?.reservation_id;
    const totalPrice = roundCurrency(Number(reservation?.total_price || 0));
    const approvedBaseTotal = roundCurrency(getApprovedBasePaymentsTotal(paymentsByReservationId, reservationId));
    const remainingBalance = roundCurrency(Math.max(totalPrice - approvedBaseTotal, 0));
    const dueDate = getReservationBalanceDueDate(reservation);
    const dueDateKey = dueDate ? buildLocalDateKey(dueDate) : '';
    const dueDateLabel = dueDateKey ? safeFormatDate(options.formatDate, dueDateKey) : 'No due date';
    const isPastDue = Boolean(remainingBalance > 0 && dueDateKey && getTodayDateKey() > dueDateKey);
    const hasPartialPayment = approvedBaseTotal > 0 && remainingBalance > 0;

    // Grace deadline = due date + auto_cancel_days (System Settings). Only
    // meaningful once a due date exists; used by the overdue status strip
    // and the pay-at-café arrival-date max bound.
    const autoCancelDays = Number(options.reservationRules?.auto_cancel_days ?? RESERVATION_RULES_DEFAULTS.auto_cancel_days);
    const graceDeadline = dueDate ? new Date(dueDate.getTime() + autoCancelDays * 24 * 60 * 60 * 1000) : null;
    const graceDeadlineKey = graceDeadline ? buildLocalDateKey(graceDeadline) : '';
    const graceDeadlineLabel = graceDeadlineKey ? safeFormatDate(options.formatDate, graceDeadlineKey) : '';

    let phaseLabel = 'Initial Payment';
    let stateLabel = 'Initial payment needed';
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
        helperText,
        graceDeadline,
        graceDeadlineKey,
        graceDeadlineLabel
    };
}

export function getPaymentActionLabel(paymentType, reservation, amount, rescheduleRequestId, paymentsByReservationId, options = {}) {
    if (paymentType === 'full_payment' && !rescheduleRequestId) {
        const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, options);
        if (balance.approvedBaseTotal > 0 && amount < balance.totalPrice) {
            return 'Remaining Balance';
        }
    }

    return getPaymentLabel(paymentType);
}

export function isReservationPaymentEnabled(reservation) {
    return ['approved', 'confirmed', 'rescheduled', 'completed', 'cancellation_requested'].includes(String(reservation?.status || '').toLowerCase());
}

function buildPaymentOption(reservation, paymentType, amount, paymentsByReservationId, options = {}) {
    const displayLabel = options.displayLabel || getPaymentActionLabel(
        paymentType,
        reservation,
        amount,
        options.rescheduleRequestId || '',
        paymentsByReservationId,
        options
    );
    const baseDescription = PAYMENT_TYPE_META[paymentType]?.description || '';

    return {
        paymentType,
        amount,
        label: PAYMENT_TYPE_META[paymentType]?.label || displayLabel,
        displayLabel,
        description: baseDescription,
        displayDescription: options.displayDescription || baseDescription,
        rescheduleRequestId: options.rescheduleRequestId || '',
        minAmount: options.minAmount,
        maxAmount: options.maxAmount
    };
}

function hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, paymentType) {
    return getNormalPayments(paymentsByReservationId, reservationId).some((payment) => (
        payment.payment_type === paymentType
        && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
    ));
}

function getReservationFeeAmount(reservation, remainingBalance) {
    const locationType = String(reservation?.location_type || '').toLowerCase();

    if (locationType === 'onsite') {
        return roundCurrency(Math.min(ONSITE_RESERVATION_FEE, remainingBalance));
    }

    return roundCurrency(Math.min(5000, remainingBalance));
}

export function getAvailablePaymentOptions(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    if (!isReservationPaymentEnabled(reservation)) {
        return [];
    }

    const reservationId = reservation.reservation_id;
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, options);
    const totalPrice = balance.totalPrice;
    const approvedBasePayments = balance.approvedBaseTotal;
    const remainingBalance = balance.remainingBalance;
    const pendingBasePayment = getPendingBasePayment(paymentsByReservationId, reservationId);
    const optionsList = [];

    // Every base-payment option is now computed fresh from the CURRENT
    // remaining balance (not gated behind "is this the first payment?"), so
    // Reservation Fee / Down Payment / Full Payment / Custom Amount can all
    // appear together on a second or third payment too — whichever of them
    // haven't already been used or aren't already pending review.
    if (!pendingBasePayment && remainingBalance > 0) {
        const reservationFeeAmount = getReservationFeeAmount(reservation, remainingBalance);
        if (
            reservationFeeAmount > 0
            && reservationFeeAmount < remainingBalance
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'reservation_fee')
        ) {
            optionsList.push(buildPaymentOption(reservation, 'reservation_fee', reservationFeeAmount, paymentsByReservationId, {
                ...options,
                displayDescription: 'Confirm your reservation with the reservation fee.'
            }));
        }

        const downPaymentAmount = roundCurrency(Math.min(remainingBalance * 0.5, remainingBalance));
        if (
            downPaymentAmount > 0
            && downPaymentAmount < remainingBalance
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'down_payment')
        ) {
            optionsList.push(buildPaymentOption(reservation, 'down_payment', downPaymentAmount, paymentsByReservationId, {
                ...options,
                displayDescription: 'Pay half of your remaining balance now and settle the rest later.'
            }));
        }

        if (!hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'full_payment')) {
            optionsList.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, paymentsByReservationId, {
                ...options,
                displayDescription: approvedBasePayments > 0
                    ? (balance.dueDateKey ? `Settle the unpaid balance by ${balance.dueDateLabel}.` : 'Settle the unpaid balance for this reservation.')
                    : 'Settle the reservation in one payment.'
            }));
        }

        if (!hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'partial_payment')) {
            const depositPct = Number(options.reservationRules?.deposit_pct ?? RESERVATION_RULES_DEFAULTS.deposit_pct);
            const minAmount = roundCurrency(Math.min(totalPrice * depositPct / 100, remainingBalance));
            optionsList.push(buildPaymentOption(reservation, 'partial_payment', 0, paymentsByReservationId, {
                ...options,
                displayLabel: 'Custom Amount',
                displayDescription: `Enter any amount between ${safeFormatCurrency(minAmount)} and ${safeFormatCurrency(remainingBalance)}.`,
                minAmount,
                maxAmount: remainingBalance
            }));
        }
    }

    const rescheduleRequests = reschedulesByReservationId?.[reservationId] || [];
    rescheduleRequests
        .filter((request) => String(request.status || '').toLowerCase() === 'approved_pending_payment')
        .forEach((request) => {
            const hasExistingRescheduleFee = getReservationPayments(paymentsByReservationId, reservationId).some((payment) => (
                String(payment.reschedule_request_id || '') === String(request.reschedule_request_id)
                && ['pending_review', 'approved'].includes(String(payment.payment_status || '').toLowerCase())
            ));

            if (!hasExistingRescheduleFee) {
                optionsList.push(buildPaymentOption(reservation, 'reschedule_fee', 3000, paymentsByReservationId, {
                    ...options,
                    displayDescription: `${PAYMENT_TYPE_META.reschedule_fee.description} for ${safeFormatDate(options.formatDate, request.requested_date)}`,
                    rescheduleRequestId: request.reschedule_request_id
                }));
            }
        });

    if (String(reservation?.status || '').toLowerCase() === 'cancellation_requested') {
        const hasPendingCancellationFee = getReservationPayments(paymentsByReservationId, reservationId).some((p) =>
            p.payment_type === 'cancellation_fee' &&
            ['pending_review', 'approved'].includes(String(p.payment_status || '').toLowerCase())
        );
        if (!hasPendingCancellationFee) {
            const cancellationFeeAmount = String(reservation.location_type || '').toLowerCase() === 'offsite' ? 2000 : 500;
            optionsList.push(buildPaymentOption(reservation, 'cancellation_fee', cancellationFeeAmount, paymentsByReservationId, {
                ...options,
                displayDescription: 'Required fee to process the cancellation of your reservation.'
            }));
        }
    }

    return optionsList.filter((option) => option.amount > 0 || option.paymentType === 'partial_payment');
}

export function getPaymentSummary(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const reservationId = reservation.reservation_id;
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, options);
    const pendingPayment = getPendingBasePayment(paymentsByReservationId, reservationId);

    if (pendingPayment) {
        const pendingLabel = getPaymentActionLabel(
            pendingPayment.payment_type,
            reservation,
            Number(pendingPayment.amount || 0),
            pendingPayment.reschedule_request_id || '',
            paymentsByReservationId,
            options
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
            sublabel: `${safeFormatCurrency(balance.remainingBalance)} remaining / Pay by ${balance.dueDateLabel}`
        };
    }

    const approvedRescheduleRequest = (reschedulesByReservationId?.[reservationId] || [])
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

export function getLatestReservationPayment(paymentsByReservationId, reservationId) {
    return getReservationPayments(paymentsByReservationId, reservationId)
        .slice()
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

export function getLatestApprovedReservationPayment(paymentsByReservationId, reservationId) {
    return getReservationPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .slice()
        .sort((left, right) => new Date(right.verified_at || right.submitted_at || 0) - new Date(left.verified_at || left.submitted_at || 0))[0] || null;
}

export function isCompletedPaymentOverview(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const paymentSummary = getPaymentSummary(reservation, paymentsByReservationId, reschedulesByReservationId, options);
    const availableOptions = getAvailablePaymentOptions(reservation, paymentsByReservationId, reschedulesByReservationId, options);
    return paymentSummary.key === 'approved' && !availableOptions.length;
}

export function isPendingPaymentOverview(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const paymentSummary = getPaymentSummary(reservation, paymentsByReservationId, reschedulesByReservationId, options);
    const availableOptions = getAvailablePaymentOptions(reservation, paymentsByReservationId, reschedulesByReservationId, options);
    return paymentSummary.key === 'pending'
        && Boolean(getPendingBasePayment(paymentsByReservationId, reservation.reservation_id))
        && !availableOptions.length;
}

export async function uploadPaymentProof(file) {
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

export async function fetchPayments(supabase, reservationIds) {
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

export async function fetchReceipts(supabase, paymentIds) {
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

export async function fetchRescheduleRequests(supabase, reservationIds) {
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

export async function fetchCustomerReservations(supabase, userId, options = {}) {
    const includeReviewPrompt = Boolean(options.includeReviewPrompt);
    const selectClause = includeReviewPrompt
        ? `${BASE_CUSTOMER_RESERVATION_SELECT}, review_prompt_dismissed_at`
        : BASE_CUSTOMER_RESERVATION_SELECT;

    let response = await supabase
        .from('reservations')
        .select(selectClause)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (
        includeReviewPrompt
        && response.error
        && isMissingColumnError(response.error, 'reservations', 'review_prompt_dismissed_at')
    ) {
        response = await supabase
            .from('reservations')
            .select(BASE_CUSTOMER_RESERVATION_SELECT)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (!response.error) {
            response.data = (response.data || []).map((reservation) => ({
                ...reservation,
                review_prompt_dismissed_at: null
            }));
        }
    }

    if (response.error) throw response.error;
    return response.data || [];
}

export async function loadCustomerPaymentBundle(supabase, userId, options = {}) {
    const reservations = await fetchCustomerReservations(supabase, userId, options);
    const reservationIds = reservations.map((reservation) => reservation.reservation_id).filter(Boolean);
    const [paymentsByReservationId, reschedulesByReservationId] = await Promise.all([
        fetchPayments(supabase, reservationIds),
        fetchRescheduleRequests(supabase, reservationIds)
    ]);
    const paymentIds = Object.values(paymentsByReservationId)
        .flat()
        .map((payment) => payment.payment_id)
        .filter(Boolean);
    const receiptsByPaymentId = await fetchReceipts(supabase, paymentIds);

    return {
        reservations,
        paymentsByReservationId,
        receiptsByPaymentId,
        reschedulesByReservationId
    };
}

export async function submitCustomerPayment({
    supabase,
    reservations,
    paymentsByReservationId,
    reschedulesByReservationId,
    reservationId,
    paymentMethod,
    paymentType,
    rescheduleRequestId = null,
    customAmount = null,
    referenceNumber = '',
    paymentDate = null,
    cashPaymentDate = null,
    notes = '',
    proofFile = null,
    formatDate,
    reservationRules = null
}) {
    const reservation = (reservations || []).find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) {
        throw new Error('This reservation could not be found.');
    }

    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, { formatDate, reservationRules });
    const availableOptions = getAvailablePaymentOptions(
        reservation,
        paymentsByReservationId,
        reschedulesByReservationId,
        { formatDate, reservationRules }
    );
    const selectedOption = availableOptions.find((option) => (
        option.paymentType === paymentType
        && String(option.rescheduleRequestId || '') === String(rescheduleRequestId || '')
    ));

    if (!selectedOption) {
        throw new Error('This payment option is no longer available. Please refresh the page.');
    }

    const activeMethod = String(paymentMethod || 'gcash');
    const isOnsite = PAYMENT_METHODS[activeMethod]?.type === 'onsite';
    const isCustomAmount = selectedOption.paymentType === 'partial_payment';

    let amount = Number(selectedOption.amount || 0);
    if (isCustomAmount) {
        amount = roundCurrency(Number(customAmount));
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Please enter a valid custom payment amount.');
        }
        if (amount < selectedOption.minAmount) {
            throw new Error(`Custom payment amount must be at least ${safeFormatCurrency(selectedOption.minAmount)}.`);
        }
        if (amount > selectedOption.maxAmount) {
            throw new Error(`Custom payment amount cannot exceed the remaining balance of ${safeFormatCurrency(selectedOption.maxAmount)}.`);
        }
    }
    if (!amount || amount <= 0) {
        throw new Error('This payment option does not have a valid amount.');
    }

    if (isOnsite) {
        if (!cashPaymentDate) {
            throw new Error('Please choose your planned date of arrival for payment.');
        }
        const todayKey = getTodayDateKey();
        if (cashPaymentDate < todayKey) {
            throw new Error('The planned arrival date cannot be in the past.');
        }
        const eventDateKey = String(reservation.event_date || '').split('T')[0];
        const latestAllowedKey = [balance.graceDeadlineKey, eventDateKey].filter(Boolean).sort()[0] || '';
        if (latestAllowedKey && cashPaymentDate > latestAllowedKey) {
            throw new Error('The planned arrival date must be on or before the payment grace deadline or event date, whichever is earlier.');
        }
    } else {
        if (!referenceNumber) {
            throw new Error('Please enter your reference or transaction number.');
        }
        if (!validateReferenceNumber(activeMethod, referenceNumber)) {
            const hint = REFERENCE_NUMBER_PATTERNS[activeMethod]?.hint || 'the correct format';
            throw new Error(`Please enter a valid ${PAYMENT_METHODS[activeMethod]?.label || activeMethod} reference number (${hint}).`);
        }
        if (!paymentDate) {
            throw new Error('Please choose the payment date.');
        }
        if (paymentDate > getTodayDateKey()) {
            throw new Error('The payment date cannot be in the future.');
        }
        if (!proofFile) {
            throw new Error('Please upload a proof of payment.');
        }
    }

    const proofUrl = isOnsite ? '' : await uploadPaymentProof(proofFile);
    const payload = {
        reservation_id: reservation.reservation_id,
        reschedule_request_id: selectedOption.rescheduleRequestId || null,
        payment_type: selectedOption.paymentType,
        payment_method: activeMethod,
        amount,
        payment_status: 'pending_review',
        reference_number: isOnsite ? null : referenceNumber,
        payment_date: isOnsite ? null : paymentDate,
        notes: notes || null,
        proof_url: proofUrl || null,
        cash_payment_date: isOnsite ? cashPaymentDate : null,
        submitted_at: new Date().toISOString()
    };

    const { data: insertedRows, error } = await supabase
        .from('payment')
        .insert(payload)
        .select('payment_id')
        .limit(1);

    if (error) throw error;

    const newPaymentId = insertedRows?.[0]?.payment_id;
    let successMessage = isOnsite
        ? 'Payment details submitted for admin review.'
        : 'Payment details submitted for admin review.';

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

    return {
        paymentId: newPaymentId || null,
        payload,
        successMessage
    };
}

export function buildCustomerPaymentUrl(reservationId) {
    const url = new URL('/payment.html', window.location.href);
    if (reservationId) {
        url.searchParams.set('reservation_id', reservationId);
    }
    return url.href;
}

export function buildCustomerAccountUrl(section = 'reservations') {
    const url = new URL('/account.html', window.location.href);
    if (section) {
        url.searchParams.set('section', section);
    }
    return url.href;
}
