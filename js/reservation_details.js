import { customerSupabase as supabase } from './supabase.js';
import {
    buildCustomerPaymentUrl,
    fetchPayments as fetchSharedPayments,
    fetchRescheduleRequests as fetchSharedRescheduleRequests,
    getReservationBalanceDetails,
    isReservationPaymentEnabled
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
    computeCanCancel
} from './reservation_shared.js';

const CLOUDINARY_CONFIG = {
    cloudName: 'dtt707f1w',
    uploadPreset: 'eli_contracts',
    contractFolder: 'contracts',
    maxFileSize: 10 * 1024 * 1024
};

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

    const [contract, paymentsByReservationId, reschedulesByReservationId, cancellationInfo, review] = await Promise.all([
        fetchContract(reservationId),
        fetchSharedPayments(supabase, [reservationId]),
        fetchSharedRescheduleRequests(supabase, [reservationId]),
        fetchCancellationInfo(reservationId),
        fetchReview(reservationId)
    ]);

    pageData = {
        reservation,
        contract,
        payments: paymentsByReservationId[reservationId] || [],
        rescheduleRequests: reschedulesByReservationId[reservationId] || [],
        paymentsByReservationId,
        cancellationInfo,
        review
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

// Four-step stepper: Submitted -> Verification -> Payment -> Confirmed.
// Completed steps show a timestamp sublabel; the active step sets an
// expectation ("In review — 1 to 2 days") instead of a dead-end word like
// "Locked"; future steps carry no sublabel at all.
function buildStepperSteps(reservation, contractMeta, balance, payments) {
    const verificationDone = isReservationPaymentEnabled(reservation);
    const paymentDone = balance.remainingBalance <= 0;
    const isResubmission = contractMeta.statusKey === 'resubmission_requested';
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
                : (isResubmission ? 'Corrected contract needed' : 'In review — 1 to 2 days')
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

function buildStepperMarkup(steps) {
    return `
        <ol class="rd-stepper">
            ${steps.map((step, index) => `
                <li class="rd-step ${escapeHtml(step.state)}">
                    <span class="rd-step-track">
                        <span class="rd-step-dot" aria-hidden="true">${step.state === 'done' ? '<i class="fa-solid fa-check"></i>' : ''}</span>
                        ${index < steps.length - 1 ? '<span class="rd-step-connector"></span>' : ''}
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

    if (contractMeta.statusKey === 'resubmission_requested') {
        return {
            tone: 'amber',
            icon: 'circle-exclamation',
            body: contractMeta.note || 'Please upload a corrected signed contract so we can verify your booking.'
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
    if (contractMeta.statusKey === 'resubmission_requested') return 'resubmission_requested';
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

function buildContractResubmissionBlock(contractMeta) {
    if (contractMeta.statusKey !== 'resubmission_requested') return '';

    return `
        <div class="rd-contract-reupload">
            <p class="rd-contract-reupload-alert">Admin asked for a corrected signed contract. Upload the updated file to send it back for review.</p>
            <div class="payment-proof-box">
                <label class="payment-field full" for="replacement-contract-file">
                    <span class="rd-dl-label-plain">Replacement signed contract</span>
                    <div class="payment-upload-control">
                        <label class="payment-upload-button" for="replacement-contract-file">Choose file</label>
                        <span class="payment-upload-name" data-contract-filename>No file chosen</span>
                    </div>
                    <input id="replacement-contract-file" type="file" accept=".pdf,.jpg,.jpeg,.png" data-field="replacement_contract" hidden />
                </label>
                <p class="payment-proof-note">Accepted formats: PDF, JPG, JPEG, and PNG. Maximum 10MB.</p>
            </div>
            <button type="button" class="rd-btn-solid" data-action="submit-contract-resubmission">Submit replacement contract</button>
            <p class="account-modal-message" data-contract-resubmission-message></p>
        </div>
    `;
}

function buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl) {
    const paymentDone = balance.remainingBalance <= 0;
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
                    <span>${paymentDone ? 'Paid in full' : `Balance due by ${escapeHtml(balance.dueDateLabel)}`}</span>
                    <span>${escapeHtml(paymentDone ? formatCurrency(0) : formatCurrency(balance.remainingBalance))}</span>
                </div>
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
                ${buildContractResubmissionBlock(contractMeta)}
            </div>

            ${showPaymentCta ? `
                <button
                    type="button"
                    class="rd-pay-cta ${locked ? 'locked' : 'primary'}"
                    ${locked ? 'disabled aria-describedby="rd-pay-caption"' : ''}
                    data-payment-url="${escapeHtml(paymentUrl)}"
                >
                    ${locked ? '<i class="fa-solid fa-lock" aria-hidden="true"></i>' : ''} Continue payment
                </button>
                ${locked ? `<p class="rd-pay-caption" id="rd-pay-caption">Unlocks after your contract is verified</p>` : ''}
            ` : ''}
        </section>
    `;
}

function buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus) {
    if (['cancelled', 'declined', 'completed'].includes(effectiveStatus)) return '';

    const latestRequest = rescheduleRequests[0] || null;
    const openRescheduleUrl = `/account.html?section=reservations&open=reschedule&reservation_id=${encodeURIComponent(reservation.reservation_id)}`;
    const openCancelUrl = `/account.html?section=reservations&open=cancel&reservation_id=${encodeURIComponent(reservation.reservation_id)}`;

    if (!latestRequest && !canReschedule && !canCancel) return '';

    if (!latestRequest) {
        return `
            <div class="rd-reschedule-row">
                <div class="rd-reschedule-row-left">
                    <i class="fa-solid fa-calendar-days" aria-hidden="true"></i>
                    <span>Need to change your event date?</span>
                </div>
                <div class="rd-reschedule-row-actions">
                    ${canReschedule ? `<a class="rd-btn-outline" href="${escapeHtml(openRescheduleUrl)}">Request reschedule</a>` : ''}
                    ${canCancel ? `<a class="rd-cancel-link" href="${escapeHtml(openCancelUrl)}">Cancel reservation</a>` : ''}
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
            ${(canReschedule || canCancel) ? `
                <div class="rd-reschedule-row-actions">
                    ${canReschedule ? `<a class="rd-btn-outline" href="${escapeHtml(openRescheduleUrl)}">Request reschedule</a>` : ''}
                    ${canCancel ? `<a class="rd-cancel-link" href="${escapeHtml(openCancelUrl)}">Cancel reservation</a>` : ''}
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
    const { reservation, contract, payments, rescheduleRequests, paymentsByReservationId, cancellationInfo, review } = pageData;
    const effectiveStatus = getEffectiveReservationStatus(reservation);
    const reservationStatus = getReservationStatusMeta(effectiveStatus);
    const statusIcon = getReservationStatusIcon(effectiveStatus);
    const balance = getReservationBalanceDetails(reservation, paymentsByReservationId, { formatDate });
    const contractMeta = computeContractMeta(contract, reservation.status);
    const canReschedule = computeCanReschedule(reservation.status, rescheduleRequests);
    const canCancel = computeCanCancel(reservation.status, payments);
    const isTerminalCancelled = ['cancelled', 'declined'].includes(effectiveStatus);
    const paymentUrl = buildCustomerPaymentUrl(reservationId);

    const showBalanceSummary = !isTerminalCancelled;
    const paymentDone = balance.remainingBalance <= 0;

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
                        <span class="rd-balance-label">${paymentDone ? 'Paid in full' : 'Balance due'}</span>
                        <div class="rd-balance-amount-row">
                            <strong class="rd-balance-amount">${escapeHtml(paymentDone ? formatCurrency(balance.totalPrice) : formatCurrency(balance.remainingBalance))}</strong>
                            ${!paymentDone ? `<span class="rd-balance-due-date">by ${escapeHtml(formatShortDate(balance.dueDateKey))}</span>` : ''}
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
            ${buildPaymentContractPanel(reservation, contract, contractMeta, balance, effectiveStatus, paymentUrl)}
        </div>

        ${buildRescheduleRow(reservation, rescheduleRequests, canReschedule, canCancel, effectiveStatus)}
        ${buildReviewRow(effectiveStatus, review)}
    `;
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

    const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`, {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        throw new Error('Failed to upload the replacement signed contract.');
    }

    const result = await response.json();
    return result.secure_url || '';
}

function setContractMessage(message, isError = false) {
    const messageEl = pageContainer.querySelector('[data-contract-resubmission-message]');
    if (!messageEl) return;
    messageEl.textContent = message;
    messageEl.classList.remove('error', 'success');
    if (message) {
        messageEl.classList.add(isError ? 'error' : 'success');
    }
}

async function submitReplacementContract() {
    const { reservation, contract } = pageData;
    const contractMeta = computeContractMeta(contract, reservation.status);
    const fileInput = pageContainer.querySelector('[data-field="replacement_contract"]');
    const submitBtn = pageContainer.querySelector('[data-action="submit-contract-resubmission"]');
    const replacementFile = fileInput?.files?.[0] || null;

    if (!contract) {
        setContractMessage('This reservation contract could not be found.', true);
        return;
    }

    const allowedForUpload = ['resubmission_requested', 'missing'];
    if (!allowedForUpload.includes(contractMeta.statusKey)) {
        setContractMessage('Contract upload is not available for this reservation right now.', true);
        return;
    }

    if (!replacementFile) {
        setContractMessage('Please choose the corrected signed contract first.', true);
        return;
    }

    setContractMessage('Uploading replacement contract...');
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
        if (!data) throw new Error('Your reservation contract could not be updated.');

        // ── Auto-verify: ask the edge function to detect the signature ──
        setContractMessage('Verifying contract signature...');
        let autoVerified = false;
        try {
            const { data: verifyData, error: verifyError } = await supabase.functions.invoke('verify-contract', {
                body: { reservation_id: reservationId, contract_url: contractUrl }
            });
            if (!verifyError && verifyData?.verified === true) {
                autoVerified = true;
            }
        } catch (verifyErr) {
            console.warn('[verify-contract] invocation threw:', verifyErr?.message || verifyErr);
        }
        // ──────────────────────────────────────────────────────────────

        await loadPageData();
        render();
        setContractMessage(
            autoVerified
                ? 'Your signed contract was automatically verified.'
                : 'Your corrected signed contract was sent to the admin for review.'
        );
    } catch (error) {
        submitBtn?.removeAttribute('disabled');
        setContractMessage(`Failed to submit replacement contract: ${error.message}`, true);
    }
}

async function init() {
    try {
        await loadPageData();
        render();
    } catch (error) {
        console.error('Failed to load reservation:', error);
        pageContainer.innerHTML = `<p style="color:#c0392b;text-align:center;padding:40px 0;">${escapeHtml(error.message || 'Failed to load this reservation.')}</p>`;
    }
}

pageContainer?.addEventListener('click', async (event) => {
    const submitBtn = event.target.closest('[data-action="submit-contract-resubmission"]');
    if (submitBtn) {
        await submitReplacementContract();
        return;
    }

    const payBtn = event.target.closest('.rd-pay-cta');
    if (payBtn && !payBtn.disabled) {
        const url = payBtn.dataset.paymentUrl;
        if (url) window.location.href = url;
    }
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

init();

supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        window.location.href = '/login.html';
    }
});
