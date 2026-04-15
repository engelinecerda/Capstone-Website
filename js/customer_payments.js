const CLOUDINARY_CONFIG = {
    cloudName: 'dtt707f1w',
    uploadPreset: 'eli_contracts',
    paymentFolder: 'payments',
    maxFileSize: 10 * 1024 * 1024
};

export const PAYMENT_METHODS = {
    card: {
        label: 'Card',
        shortLabel: 'Card',
        helper: 'Use the owner-provided debit or credit card payment arrangement, then submit the payment reference and proof here for review.',
        channel: {
            title: 'Owner Card Arrangement',
            rows: [
                { label: 'Account name', value: 'ELI Coffee Events' },
                { label: 'Channel', value: 'Card terminal or payment link' },
                { label: 'Reference', value: 'Use the admin-provided reference number.' }
            ]
        }
    },
    bancnet: {
        label: 'BancNet',
        shortLabel: 'Bank transfer',
        helper: 'Submit your transfer reference number and upload a clear screenshot or receipt.',
        channel: {
            title: 'Owner Bank Account',
            rows: [
                { label: 'Account name', value: 'ELI Coffee Events' },
                { label: 'Bank', value: 'BDO Unibank' },
                { label: 'Account no.', value: '1234 5678 9012' }
            ]
        }
    },
    gcash_maya: {
        label: 'GCash/Maya',
        shortLabel: 'GCash / Maya',
        helper: 'Use your e-wallet reference number and upload your payment proof for admin review.',
        channel: {
            title: 'Owner E-Wallet Channel',
            rows: [
                { label: 'Account name', value: 'ELI Coffee Events' },
                { label: 'Channel', value: 'GCash - 0917 123 4567' },
                { label: 'Reference', value: 'Use the admin-provided reference number.' }
            ]
        }
    },
    cash: {
        label: 'Cash',
        shortLabel: 'Cash',
        helper: 'Schedule the date you will visit the cafe to pay in person. Admin will still confirm the payment manually.',
        channel: null
    }
};

export const PAYMENT_METHOD_ORDER = ['gcash_maya', 'card', 'bancnet', 'cash'];

export const PAYMENT_TYPE_META = {
    reservation_fee: { label: 'Reservation Fee', description: 'Fixed reservation fee' },
    down_payment: { label: 'Down Payment', description: '50% of your total amount' },
    full_payment: { label: 'Full Payment', description: 'Settle the remaining balance in full' },
    reschedule_fee: { label: 'Reschedule Fee', description: 'Fixed fee for approved reschedule requests' }
};

export const PAYMENT_STATUS_META = {
    pending_review: { label: 'Pending Review', key: 'pending' },
    approved: { label: 'Approved', key: 'approved' },
    rejected: { label: 'Rejected', key: 'rejected' }
};

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
        helperText
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
    return ['approved', 'confirmed', 'rescheduled', 'completed'].includes(String(reservation?.status || '').toLowerCase());
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
        rescheduleRequestId: options.rescheduleRequestId || ''
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

    if (!pendingBasePayment && remainingBalance > 0) {
        if (approvedBasePayments > 0) {
            if (!hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'full_payment')) {
                optionsList.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, paymentsByReservationId, {
                    ...options,
                    displayLabel: 'Remaining Balance',
                    displayDescription: balance.dueDateKey
                        ? `Settle the unpaid balance by ${balance.dueDateLabel}.`
                        : 'Settle the unpaid balance for this reservation.'
                }));
            }
        } else {
            if (!hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'reservation_fee')) {
                optionsList.push(buildPaymentOption(reservation, 'reservation_fee', getReservationFeeAmount(reservation, remainingBalance), paymentsByReservationId, {
                    ...options,
                    displayDescription: 'Confirm your reservation with the reservation fee.'
                }));
            }

            const downPaymentAmount = roundCurrency(Math.min(totalPrice * 0.5, remainingBalance));
            if (
                downPaymentAmount > 0
                && downPaymentAmount < remainingBalance
                && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'down_payment')
            ) {
                optionsList.push(buildPaymentOption(reservation, 'down_payment', downPaymentAmount, paymentsByReservationId, {
                    ...options,
                    displayDescription: 'Pay 50% now to confirm the reservation and settle the rest later.'
                }));
            }

            if (!hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'full_payment')) {
                optionsList.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, paymentsByReservationId, {
                    ...options,
                    displayDescription: 'Settle the reservation in one payment.'
                }));
            }
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

    return optionsList.filter((option) => option.amount > 0);
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
    referenceNumber = '',
    paymentDate = null,
    cashPaymentDate = null,
    notes = '',
    proofFile = null,
    formatDate
}) {
    const reservation = (reservations || []).find((entry) => String(entry.reservation_id) === String(reservationId));
    if (!reservation) {
        throw new Error('This reservation could not be found.');
    }

    const availableOptions = getAvailablePaymentOptions(
        reservation,
        paymentsByReservationId,
        reschedulesByReservationId,
        { formatDate }
    );
    const selectedOption = availableOptions.find((option) => (
        option.paymentType === paymentType
        && String(option.rescheduleRequestId || '') === String(rescheduleRequestId || '')
    ));

    if (!selectedOption) {
        throw new Error('This payment option is no longer available. Please refresh the page.');
    }

    const activeMethod = String(paymentMethod || 'card');
    const amount = Number(selectedOption.amount || 0);
    if (!amount || amount <= 0) {
        throw new Error('This payment option does not have a valid amount.');
    }

    if (activeMethod === 'cash') {
        if (!cashPaymentDate) {
            throw new Error('Please choose the date you will visit the cafe to pay in cash.');
        }
    } else {
        if (!referenceNumber) {
            throw new Error('Please enter your reference or transaction number.');
        }
        if (!paymentDate) {
            throw new Error('Please choose the payment date.');
        }
        if (!proofFile) {
            throw new Error('Please upload a proof of payment.');
        }
    }

    const proofUrl = activeMethod === 'cash' ? '' : await uploadPaymentProof(proofFile);
    const payload = {
        reservation_id: reservation.reservation_id,
        reschedule_request_id: selectedOption.rescheduleRequestId || null,
        payment_type: selectedOption.paymentType,
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

    const newPaymentId = insertedRows?.[0]?.payment_id;
    let successMessage = activeMethod === 'cash'
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
    const url = new URL('/payment', window.location.href);
    if (reservationId) {
        url.searchParams.set('reservation_id', reservationId);
    }
    return url.href;
}

export function buildCustomerAccountUrl(section = 'reservations') {
    const url = new URL('/account', window.location.href);
    if (section) {
        url.searchParams.set('section', section);
    }
    return url.href;
}
