import { getCancellationFee as getSharedCancellationFee, getRescheduleFee as getSharedRescheduleFee, isCancellationFeeOwed, isRescheduleFeeOwed } from './reservation_shared.js';

const CLOUDINARY_CONFIG = {
    cloudName: 'dtt707f1w',
    // eli_contracts' preset has a fixed Asset Folder of "contracts" (Dynamic
    // Folder Mode), so every upload through it lands in the Console's
    // "contracts" folder regardless of the folder param sent in the
    // request — confirmed directly against the live account. eli_payments
    // is a separate preset with Asset folder "payments" so receipts stop
    // sharing a folder setting with contracts.
    uploadPreset: 'eli_payments',
    paymentFolder: 'payments',
    maxFileSize: 10 * 1024 * 1024
};

// Substring match against a method's free-text label, used only to derive
// the legacy `payment.payment_method` mode string ('gcash'/'maya') that
// validate_payment_submission() still checks reference-number formats
// against, and that some admin display maps still key off. Bank transfer
// is deliberately NOT matched here — it used to be ('bpi', matching the
// row's old literal "BPI" label), which is exactly the bug this map used
// to cause: a label match to one specific bank pinned the whole method to
// that bank's reference-number format. It now falls through to the DB
// `type` ('bank'), which is bank-agnostic by construction and stays
// correct no matter what the row is labeled (Bank Transfer, Bank Deposit,
// etc.) without another code change. 'ewallet'/'cash' fall through the
// same way.
const LEGACY_MODE_MATCH = [
    { match: 'gcash', key: 'gcash' },
    { match: 'maya',  key: 'maya' },
];

function resolveLegacyModeKey(row) {
    if (row.type === 'cash' || row.type === 'card') return row.type;
    const label = String(row.label || '').toLowerCase();
    const match = LEGACY_MODE_MATCH.find(({ match }) => label.includes(match));
    return match?.key || row.type;
}

/**
 * Fetches active payment methods straight from the `payment_method` table —
 * every displayed value (label, account details, QR image, instructions)
 * comes from the row, in `sort_order`. No hardcoded skeleton: add, rename,
 * archive, or reorder a method in admin and it's reflected here with no
 * code change. Returns [] (not a throw) on fetch failure so callers can
 * show an empty-state message.
 */
export async function loadPaymentMethods(supabase) {
    try {
        const { data, error } = await supabase
            .from('payment_method')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: false });

        if (error) throw error;
        if (!data) return [];

        return data.map((row) => {
            // evidence_source is the admin-configured flag (payment_method
            // table) that decides this: 'cafe_issued' methods have the
            // customer pick an arrival date instead of entering a reference
            // number / uploading proof, since the café produces the receipt
            // at the counter rather than the customer submitting evidence.
            // Server-derived from `type` (see the payment_method_evidence_
            // source trigger) so it's always in sync — cash/card today,
            // but adding a new cafe_issued method needs no code change here.
            const isOnsite = row.evidence_source === 'cafe_issued';
            const details = row.type === 'bank'
                ? [
                    { label: 'Account Name', value: row.account_name || '', copyable: true },
                    { label: 'Account Number', value: row.account_number || '', copyable: true },
                ]
                : row.type === 'ewallet'
                ? [
                    { label: 'Account Name', value: row.account_name || '', copyable: true },
                    { label: 'Mobile Number', value: row.phone_number || '', copyable: true },
                ]
                : undefined;

            const onsiteDefaultHelper = row.type === 'card'
                ? 'Pay by card at the cafe on your visit date, using the POS terminal. The admin will confirm your payment manually.'
                : 'Pay in cash at the cafe on your visit date. The admin will confirm your payment manually.';

            return {
                id: row.payment_method_id,
                legacyModeKey: resolveLegacyModeKey(row),
                label: row.label,
                shortLabel: row.label,
                type: isOnsite ? 'onsite' : 'online',
                evidenceSource: row.evidence_source,
                qrImage: row.qr_image || '',
                details,
                payLocation: row.pay_location || '',
                cashWindowDays: row.cash_window_days ?? null,
                helper: isOnsite
                    ? (row.instructions || onsiteDefaultHelper)
                    : 'Scan the QR code or send to the details above. Screenshot your payment confirmation and upload it as proof.'
            };
        });
    } catch (err) {
        return [];
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
// supabase/migrations/20260901_bank_transfer_generic_reference.sql (the
// latest redefinition — originally 20260716_payment_overhaul.sql) —
// that's the "one client+server validation map" split across the two
// languages a browser and Postgres actually share.
//
// 'bank' (Bank Transfer) is intentionally generic, not tied to one bank's
// numbering convention — the system has no way to know in advance which
// bank a customer transferred from, so this only bounds it to "looks like
// a real reference" (alphanumeric, optional hyphens, 6-30 characters),
// wide enough to cover BPI's own old 10-13-character format as a subset.
// GCash/Maya stay provider-specific since those are single-provider
// methods with one knowable format.
export const REFERENCE_NUMBER_PATTERNS = {
    gcash: { regex: /^\d{13}$/, hint: '13 digits', placeholder: 'e.g. 1234567890123' },
    maya: { regex: /^\d{12,13}$/, hint: '12–13 digits', placeholder: 'e.g. 123456789012' },
    bank: { regex: /^[A-Za-z0-9-]{6,30}$/, hint: '6–30 letters, numbers, or hyphens', placeholder: 'e.g. TRX1234567890' }
};

export function validateReferenceNumber(method, value) {
    const pattern = REFERENCE_NUMBER_PATTERNS[method];
    if (!pattern) return true;
    return pattern.regex.test(String(value || '').trim());
}

// deposit_pct used to live here and drive the Custom Amount minimum. It's
// now payment_type.percent_of_total (code='partial_payment') — see
// PAYMENT_TYPE_DEFAULTS / loadPaymentTypes() below, the single source.
export const RESERVATION_RULES_DEFAULTS = {
    min_advance_days: 14,
    max_advance_days: 365,
    min_pax: 20,
    max_pax: 150,
    full_payment_days: 7,
    auto_cancel_days: 5
};

// Mirrors the seed values in
// supabase/migrations/20260723_payment_types_and_method_delete.sql so the
// page still works correctly before an admin has changed anything (or in an
// environment where the migration hasn't run yet).
export const PAYMENT_TYPE_DEFAULTS = {
    reservation_fee: { label: 'Reservation Fee', is_active: true, flat_amount: 999, percent_of_total: null, min_amount: null },
    down_payment:    { label: 'Down Payment',    is_active: true, flat_amount: null, percent_of_total: 50, min_amount: null },
    full_payment:    { label: 'Full Payment',    is_active: true, flat_amount: null, percent_of_total: null, min_amount: null },
    partial_payment: { label: 'Custom Amount',   is_active: true, flat_amount: null, percent_of_total: 30, min_amount: null }
};

/**
 * Reads the `payment_type` table into a { [code]: row } map, merged over
 * PAYMENT_TYPE_DEFAULTS so a missing/inactive-filtered code still has a
 * safe fallback shape. Unlike loadReservationRules, inactive rows ARE
 * included here (with is_active: false) — getAvailablePaymentOptions needs
 * to know a type is off, not just fall back to "on" because the row is
 * missing from the response.
 */
export async function loadPaymentTypes(supabase) {
    try {
        const { data, error } = await supabase
            .from('payment_type')
            .select('*');

        if (error || !data) return { ...PAYMENT_TYPE_DEFAULTS };

        const map = { ...PAYMENT_TYPE_DEFAULTS };
        for (const row of data) {
            if (map[row.code]) map[row.code] = { ...map[row.code], ...row };
        }
        return map;
    } catch {
        return { ...PAYMENT_TYPE_DEFAULTS };
    }
}

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

/**
 * Reads the shared "payment_rules" system_settings row (max_installments,
 * auto_hold_enabled, refund_window_days, currency, and the cancellation fee
 * amounts) — mirrors loadReservationRules's fallback-on-missing-row shape.
 */
export async function loadPaymentRules(supabase) {
    try {
        const { data, error } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'payment_rules')
            .maybeSingle();

        if (error || !data) return null;
        return JSON.parse(data.setting_value);
    } catch {
        return null;
    }
}

const ONSITE_RESERVATION_FEE = 999;

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

// Proof of payment must be submitted within this many days of the actual
// payment date. This is the fallback used only when the admin-configured
// value (system_settings.payment_rules.proof_of_payment_window_days,
// managed on the Payment Settings page) hasn't loaded yet.
export const PAYMENT_DATE_MAX_AGE_DAYS = 3;

export function getMinPaymentDateKey(windowDays = PAYMENT_DATE_MAX_AGE_DAYS) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(windowDays ?? PAYMENT_DATE_MAX_AGE_DAYS));
    return buildLocalDateKey(cutoff);
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

// Excludes cancellation_fee/reschedule_fee the same way public.
// reservation_payment_summary does (see 20260725_payment_ledger.sql) — a
// penalty fee isn't progress toward paying off the reservation total.
// reschedule_fee rows are already excluded above via reschedule_request_id,
// but cancellation_fee rows carry no reschedule_request_id, so without this
// filter an approved cancellation fee would inflate "amount paid" and
// understate the remaining balance shown to the customer.
const NON_BASE_PAYMENT_TYPES = new Set(['cancellation_fee', 'reschedule_fee']);

export function getApprovedBasePaymentsTotal(paymentsByReservationId, reservationId) {
    return getNormalPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'approved')
        .filter((payment) => !NON_BASE_PAYMENT_TYPES.has(payment.payment_type))
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

export function getPendingBasePayment(paymentsByReservationId, reservationId) {
    return getNormalPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

// Unlike getPendingBasePayment above (deliberately base-only — it gates
// whether NEW base payment options should be offered, and a pending
// reschedule/cancellation fee shouldn't block that), this covers EVERY
// payment type. Used anywhere the UI needs to answer "what payment is the
// customer currently waiting on?" — base-only used to mean a more recent
// reschedule_fee/cancellation_fee submission (or its approval) was
// invisible to those displays, which either showed an unrelated older
// base payment's amount instead of the fee just paid, or kept a stale
// "pending" status/label showing even after that fee was actually
// approved.
export function getLatestPendingPayment(paymentsByReservationId, reservationId) {
    return getReservationPayments(paymentsByReservationId, reservationId)
        .filter((payment) => String(payment.payment_status || '').toLowerCase() === 'pending_review')
        .sort((left, right) => new Date(right.submitted_at || 0) - new Date(left.submitted_at || 0))[0] || null;
}

// fullPaymentDays defaults to RESERVATION_RULES_DEFAULTS.full_payment_days
// (7) so callers that haven't loaded reservation_rules yet keep the exact
// prior behavior — pass options.reservationRules?.full_payment_days from
// loadReservationRules() to make this reflect the live admin-configured
// value instead (matches public.get_full_payment_days() on the DB side).
export function getReservationBalanceDueDate(reservation, fullPaymentDays = RESERVATION_RULES_DEFAULTS.full_payment_days) {
    const eventDateKey = String(reservation?.event_date || '').split('T')[0];
    if (!eventDateKey) return null;

    const dueDate = new Date(`${eventDateKey}T00:00:00`);
    if (Number.isNaN(dueDate.getTime())) return null;

    const days = Number.isFinite(Number(fullPaymentDays)) ? Number(fullPaymentDays) : RESERVATION_RULES_DEFAULTS.full_payment_days;
    dueDate.setDate(dueDate.getDate() - days);
    return dueDate;
}

export function getReservationBalanceDetails(reservation, paymentsByReservationId, options = {}) {
    const reservationId = reservation?.reservation_id;
    const totalPrice = roundCurrency(Number(reservation?.total_price || 0));
    const approvedBaseTotal = roundCurrency(getApprovedBasePaymentsTotal(paymentsByReservationId, reservationId));
    const remainingBalance = roundCurrency(Math.max(totalPrice - approvedBaseTotal, 0));
    const dueDate = getReservationBalanceDueDate(reservation, options.reservationRules?.full_payment_days);
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
    return ['approved', 'confirmed', 'rescheduled', 'completed', 'cancellation_approved'].includes(String(reservation?.status || '').toLowerCase());
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
    // payment_type.label (admin-editable on the Payment Settings page) wins
    // over the PAYMENT_TYPE_META fallback when available, so a rename takes
    // effect on this "what can I pay next" list immediately.
    const dbLabel = options.paymentTypes?.[paymentType]?.label;
    const baseDescription = PAYMENT_TYPE_META[paymentType]?.description || '';

    return {
        paymentType,
        amount,
        label: dbLabel || PAYMENT_TYPE_META[paymentType]?.label || displayLabel,
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

// Onsite fee is admin-configurable (payment_type.flat_amount, code =
// 'reservation_fee'). Offsite stays a separate fixed ₱5,000 — the
// payment_type table only has one flat_amount per code, no onsite/offsite
// split, so this half of the fee intentionally isn't migrated into it.
function getReservationFeeAmount(reservation, remainingBalance, paymentTypes) {
    const locationType = String(reservation?.location_type || '').toLowerCase();

    if (locationType === 'onsite') {
        const flatAmount = Number(paymentTypes?.reservation_fee?.flat_amount ?? ONSITE_RESERVATION_FEE);
        return roundCurrency(Math.min(flatAmount, remainingBalance));
    }

    return roundCurrency(Math.min(5000, remainingBalance));
}

export function getAvailablePaymentOptions(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const reservationId = reservation.reservation_id;
    const optionsList = [];

    // Checked before the isReservationPaymentEnabled gate below, which
    // excludes 'cancelled' on purpose (a cancelled reservation shouldn't
    // offer to pay the rest of the event balance) — but the cancellation
    // fee itself is exactly what's owed once cancelled, so it can't be
    // gated behind the same check or it would never appear.
    if (isCancellationFeeOwed(reservation, getReservationPayments(paymentsByReservationId, reservationId))) {
        optionsList.push(buildPaymentOption(reservation, 'cancellation_fee', getSharedCancellationFee(reservation, options.paymentRules), paymentsByReservationId, {
            ...options,
            displayLabel: 'Cancellation Fee',
            displayDescription: 'Required fee to finalize the cancellation of your reservation.'
        }));
    }

    if (!isReservationPaymentEnabled(reservation)) {
        return optionsList.filter((option) => option.amount > 0 || option.paymentType === 'partial_payment');
    }

    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, options);
    const totalPrice = balance.totalPrice;
    const approvedBasePayments = balance.approvedBaseTotal;
    const remainingBalance = balance.remainingBalance;
    const pendingBasePayment = getPendingBasePayment(paymentsByReservationId, reservationId);
    const paymentTypes = options.paymentTypes || PAYMENT_TYPE_DEFAULTS;

    // Every base-payment option is now computed fresh from the CURRENT
    // remaining balance (not gated behind "is this the first payment?"), so
    // Reservation Fee / Down Payment / Full Payment / Custom Amount can all
    // appear together on a second or third payment too — whichever of them
    // haven't already been used or aren't already pending review. An
    // inactive payment_type row is never shown regardless of the above.
    if (!pendingBasePayment && remainingBalance > 0) {
        const reservationFeeAmount = getReservationFeeAmount(reservation, remainingBalance, paymentTypes);
        if (
            paymentTypes.reservation_fee?.is_active !== false
            && reservationFeeAmount > 0
            && reservationFeeAmount < remainingBalance
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'reservation_fee')
        ) {
            optionsList.push(buildPaymentOption(reservation, 'reservation_fee', reservationFeeAmount, paymentsByReservationId, {
                ...options,
                paymentTypes,
                displayDescription: 'Confirm your reservation with the reservation fee.'
            }));
        }

        // Percent of the ORIGINAL total, minus what's already been paid —
        // not percent of what's remaining (that would compound: a customer
        // who already paid the ₱999 reservation fee against a 50% deposit
        // on ₱10,000 owes ₱4,001, not ₱5,000).
        const downPaymentPct = Number(paymentTypes.down_payment?.percent_of_total ?? 50);
        const downPaymentAmount = roundCurrency(Math.min((totalPrice * downPaymentPct / 100) - approvedBasePayments, remainingBalance));
        if (
            paymentTypes.down_payment?.is_active !== false
            && downPaymentAmount > 0
            && downPaymentAmount < remainingBalance
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'down_payment')
        ) {
            optionsList.push(buildPaymentOption(reservation, 'down_payment', downPaymentAmount, paymentsByReservationId, {
                ...options,
                paymentTypes,
                displayDescription: 'Pay a percentage of your total now and settle the rest later.'
            }));
        }

        if (
            paymentTypes.full_payment?.is_active !== false
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'full_payment')
        ) {
            optionsList.push(buildPaymentOption(reservation, 'full_payment', remainingBalance, paymentsByReservationId, {
                ...options,
                paymentTypes,
                displayDescription: approvedBasePayments > 0
                    ? (balance.dueDateKey ? `Settle the unpaid balance by ${balance.dueDateLabel}.` : 'Settle the unpaid balance for this reservation.')
                    : 'Settle the reservation in one payment.'
            }));
        }

        if (
            paymentTypes.partial_payment?.is_active !== false
            && !hasPendingOrApprovedPayment(paymentsByReservationId, reservationId, 'partial_payment')
        ) {
            const customPct = Number(paymentTypes.partial_payment?.percent_of_total ?? RESERVATION_RULES_DEFAULTS.deposit_pct ?? 30);
            const customFloor = Number(paymentTypes.partial_payment?.min_amount ?? 0);
            // min(floor, remaining) matters: without the cap, a customer with
            // less remaining than the floor could never submit their final
            // payment.
            const minAmount = roundCurrency(Math.min(Math.max(totalPrice * customPct / 100, customFloor), remainingBalance));
            optionsList.push(buildPaymentOption(reservation, 'partial_payment', 0, paymentsByReservationId, {
                ...options,
                paymentTypes,
                displayLabel: paymentTypes.partial_payment?.label || 'Custom Amount',
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
                const rescheduleFeeAmount = getSharedRescheduleFee(options.paymentRules);
                optionsList.push(buildPaymentOption(reservation, 'reschedule_fee', rescheduleFeeAmount, paymentsByReservationId, {
                    ...options,
                    displayDescription: `${PAYMENT_TYPE_META.reschedule_fee.description} for ${safeFormatDate(options.formatDate, request.requested_date)}`,
                    rescheduleRequestId: request.reschedule_request_id
                }));
            }
        });

    return optionsList.filter((option) => option.amount > 0 || option.paymentType === 'partial_payment');
}

// ── Payment page state — single source of truth ────────────────────────
// Answers "can this reservation be paid right now, for how much, and why"
// for every caller that needs it (account.js's Payment Status badge,
// payment.js's hero figure and its choice of which focus card to render).
// This used to be re-derived independently in each of those places and
// drifted apart twice in one review cycle: getPaymentSummary existed as
// two separate copies (account.js + this one) that disagreed about
// cancelled reservations, and payment.js's card-routing didn't check
// cancellation-fee-owed at all — making an owed fee genuinely unpayable
// through the UI despite getAvailablePaymentOptions() correctly listing it.
// Consolidated here once; getPaymentSummary below is now a thin projection
// of this for callers that only need the badge shape.
//
// Fixes one more real bug as a side effect of correct-once ordering: the
// old inline version returned "Paid in full" the moment
// balance.remainingBalance <= 0, before ever checking for an approved
// reschedule request awaiting its fee — so a reservation with its base
// balance settled but a reschedule fee still owed showed as fully paid.
//
// mode is the discriminator every caller should branch on:
//   'awaiting_approval'    - reservation not yet approved; nothing payable
//   'pending_review'       - a payment (any type) is awaiting admin review
//   'cancellation_fee_due' - cancelled, fee unpaid — the only thing payable
//   'cancelled_settled'    - cancelled, nothing left to pay
//   'reschedule_fee_due'   - an approved reschedule is awaiting its fee
//   'paid_in_full'         - base balance fully paid, nothing else owed
//   'balance_due'          - base balance (still) owed, reservation active
export function getPaymentPageState(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const reservationId = reservation.reservation_id;
    const payments = getReservationPayments(paymentsByReservationId, reservationId);
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, options);

    if (isCancellationFeeOwed(reservation, payments)) {
        const amountDue = getSharedCancellationFee(reservation, options.paymentRules);
        return {
            mode: 'cancellation_fee_due',
            submittable: true,
            amountDue,
            balance,
            label: 'Cancellation fee due',
            key: 'rejected',
            sublabel: `${safeFormatCurrency(amountDue)} required to finalize your cancellation`
        };
    }

    if (String(reservation?.status || '').toLowerCase() === 'cancelled') {
        return {
            mode: 'cancelled_settled',
            submittable: false,
            amountDue: 0,
            balance,
            label: 'Cancelled',
            key: 'cancelled',
            sublabel: 'This reservation has been cancelled'
        };
    }

    const pendingPayment = getLatestPendingPayment(paymentsByReservationId, reservationId);
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
            mode: 'pending_review',
            submittable: false,
            amountDue: Number(pendingPayment.amount || 0),
            balance,
            label: `${pendingLabel} pending review`,
            key: 'pending',
            sublabel: 'Waiting for admin confirmation'
        };
    }

    // Mirrors getAvailablePaymentOptions()'s own gate exactly — a
    // reservation still awaiting its initial admin approval has nothing
    // submittable yet, regardless of what its (already-computed, real)
    // total_price/balance figures would otherwise suggest.
    if (!isReservationPaymentEnabled(reservation)) {
        return {
            mode: 'awaiting_approval',
            submittable: false,
            amountDue: 0,
            balance,
            label: 'Awaiting approval',
            key: 'pending',
            sublabel: 'Payment becomes available once your reservation is approved.'
        };
    }

    const rescheduleRequests = reschedulesByReservationId?.[reservationId] || [];
    if (isRescheduleFeeOwed(rescheduleRequests, payments)) {
        const amountDue = getSharedRescheduleFee(options.paymentRules);
        return {
            mode: 'reschedule_fee_due',
            submittable: true,
            amountDue,
            balance,
            label: 'Reschedule fee pending',
            key: 'info',
            sublabel: 'Complete the reschedule fee to finalize the change'
        };
    }

    if (balance.remainingBalance <= 0) {
        return {
            mode: 'paid_in_full',
            submittable: false,
            amountDue: 0,
            balance,
            label: 'Paid in full',
            key: 'approved',
            sublabel: 'All required payments recorded'
        };
    }

    return {
        mode: 'balance_due',
        submittable: true,
        amountDue: balance.remainingBalance,
        balance,
        label: balance.isPastDue ? 'Overdue' : (balance.hasPartialPayment ? 'Remaining balance due' : 'Initial payment needed'),
        key: balance.toneKey,
        sublabel: balance.hasPartialPayment
            ? `${safeFormatCurrency(balance.remainingBalance)} remaining / Pay by ${balance.dueDateLabel}`
            : (balance.dueDateKey ? `Pay by ${balance.dueDateLabel}` : 'Choose your first payment')
    };
}

// Thin projection of getPaymentPageState for callers that only need the
// badge shape (label/key/sublabel) — kept so every existing call site
// (account.js, payment.js) needs zero changes to its return-value handling.
export function getPaymentSummary(reservation, paymentsByReservationId, reschedulesByReservationId, options = {}) {
    const { label, key, sublabel } = getPaymentPageState(reservation, paymentsByReservationId, reschedulesByReservationId, options);
    return { label, key, sublabel };
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
        && Boolean(getLatestPendingPayment(paymentsByReservationId, reservation.reservation_id))
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
            reviewed_at,
            hold_expires_at
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
    selectedMethod,
    paymentType,
    rescheduleRequestId = null,
    customAmount = null,
    referenceNumber = '',
    paymentDate = null,
    cashPaymentDate = null,
    notes = '',
    proofFile = null,
    formatDate,
    reservationRules = null,
    paymentTypes = null,
    paymentRules = null
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
        { formatDate, reservationRules, paymentTypes }
    );
    const selectedOption = availableOptions.find((option) => (
        option.paymentType === paymentType
        && String(option.rescheduleRequestId || '') === String(rescheduleRequestId || '')
    ));

    if (!selectedOption) {
        throw new Error('This payment option is no longer available. Please refresh the page.');
    }
    if (!selectedMethod) {
        throw new Error('Please choose a payment method.');
    }

    const isOnsite = selectedMethod.type === 'onsite';
    const legacyModeKey = selectedMethod.legacyModeKey;
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
        if (!validateReferenceNumber(legacyModeKey, referenceNumber)) {
            const hint = REFERENCE_NUMBER_PATTERNS[legacyModeKey]?.hint || 'the correct format';
            throw new Error(`Please enter a valid ${selectedMethod.label || legacyModeKey} reference number (${hint}).`);
        }
        if (!paymentDate) {
            throw new Error('Please choose the payment date.');
        }
        if (paymentDate > getTodayDateKey()) {
            throw new Error('The payment date cannot be in the future.');
        }
        const proofWindowDays = paymentRules?.proof_of_payment_window_days ?? PAYMENT_DATE_MAX_AGE_DAYS;
        if (paymentDate < getMinPaymentDateKey(proofWindowDays)) {
            throw new Error(`The payment date must be within the last ${proofWindowDays} days. Please contact us if your payment is older than that.`);
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
        payment_method: legacyModeKey,
        payment_method_id: selectedMethod.id,
        payment_method_label: selectedMethod.label || null,
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
            successMessage = 'Payment details submitted for admin review, but OCR could not be processed yet.';
        } else if (ocrData?.saved === false) {
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