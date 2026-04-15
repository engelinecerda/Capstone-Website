import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';
import { refreshAdminSidebarCounts, setBadgeCount } from './admin_sidebar_counts.js';

const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const refreshBtn = document.getElementById('refreshBtn');
const tableMessage = document.getElementById('tableMessage');
const contractsBody = document.getElementById('contractsBody');
const chipsRow = document.getElementById('chipsRow');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

const statPendingContracts = document.getElementById('statPendingContracts');
const statReplacementContracts = document.getElementById('statReplacementContracts');
const statRequestedContracts = document.getElementById('statRequestedContracts');
const statVerifiedContracts = document.getElementById('statVerifiedContracts');
const statTotalContracts = document.getElementById('statTotalContracts');

const contractDetailsModal = document.getElementById('contractDetailsModal');
const contractDetailsClose = document.getElementById('contractDetailsClose');
const contractDetailsDismiss = document.getElementById('contractDetailsDismiss');
const contractDetailsHero = document.getElementById('contractDetailsHero');
const contractDetailsMeta = document.getElementById('contractDetailsMeta');
const contractSummaryGrid = document.getElementById('contractSummaryGrid');
const contractReviewSection = document.getElementById('contractReviewSection');
const contractActionsSection = document.getElementById('contractActionsSection');
const contractDetailsMessage = document.getElementById('contractDetailsMessage');

let contractsCache = [];
let allReservationsCount = 0;
let activeContractReservationId = null;
let contractDetailsFlash = null;

function countPendingReservations(reservations) {
  return reservations.filter((reservation) => String(reservation?.status || '').toLowerCase() === 'pending').length;
}

function setMessage(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function redirectLogin() {
  window.location.replace('/admin');
}

async function validateAdmin() {
  const { session, profile } = await verifyAdminSession(supabase);
  if (!session) {
    await supabase.auth.signOut();
    return redirectLogin();
  }

  populatePortalIdentity({
    profile,
    session,
    nameEl: sidebarNameEl,
    emailEl: sidebarEmailEl,
    roleEl: sidebarRolePillEl,
    fallbackLabel: 'Admin'
  });
  return session;
}

function formatDate(value) {
  if (!value) return 'No date';
  return new Date(value).toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatDateKey(value) {
  return String(value || '').split('T')[0];
}

function parseEventTimeToParts(timeValue) {
  const value = String(timeValue || '').trim();
  if (!value) return null;

  const directMatch = value.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (directMatch) {
    return {
      hours: Number(directMatch[1]),
      minutes: Number(directMatch[2])
    };
  }

  const parsed = new Date(`1970-01-01 ${value}`);
  if (Number.isNaN(parsed.getTime())) return null;

  return {
    hours: parsed.getHours(),
    minutes: parsed.getMinutes()
  };
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

function getEffectiveReservationStatus(reservation) {
  const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
    return normalizedStatus;
  }

  const eventDateTime = getReservationEventDateTime(reservation);
  if (eventDateTime && eventDateTime.getTime() < Date.now() && ['approved', 'confirmed', 'rescheduled'].includes(normalizedStatus)) {
    return 'completed';
  }

  if (normalizedStatus === 'confirmed') {
    return 'approved';
  }

  return normalizedStatus;
}

function formatDateTime(value) {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

function getCustomerInitials(name, email = '') {
  const initials = String(name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return initials || String(email || 'C').charAt(0).toUpperCase();
}

function buildDetailCard(label, value, options = {}) {
  const classes = ['detail-card'];
  if (options.full) classes.push('full');
  const valueClass = options.subtle ? 'detail-value subtle' : 'detail-value';
  return `
    <div class="${classes.join(' ')}">
      <span class="detail-label">${escapeHtml(label)}</span>
      <div class="${valueClass}">${options.raw ? value : escapeHtml(value)}</div>
    </div>
  `;
}

function isMissingColumnError(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

function formatReservationStatus(status) {
  const normalizedKey = String(status || 'pending').toLowerCase();
  const key = normalizedKey === 'confirmed' ? 'approved' : normalizedKey;
  const labels = {
    pending: 'Pending',
    approved: 'Approved',
    declined: 'Declined',
    completed: 'Completed',
    cancelled: 'Cancelled',
    rescheduled: 'Rescheduled',
    resubmission_requested: 'Resubmission Requested'
  };

  return {
    key,
    label: labels[key] || key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  };
}

function getContractReviewMeta(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  const reviewStatus = String(contract?.review_status || '').toLowerCase();
  const reservationStatus = String(reservation?.status || '').toLowerCase();
  const resubmittedAt = contract?.resubmitted_at ? formatDateTime(contract.resubmitted_at) : '';

  if (!contract) {
    return {
      key: 'default',
      label: 'Contract missing',
      verification: 'No contract file uploaded yet',
      note: '',
      reviewedAt: '',
      resubmittedAt: '',
      hasFile: false,
      contract
    };
  }

  if (reviewStatus === 'verified' || contract?.verified_date) {
    return {
      key: 'approved',
      label: 'Verified contract',
      verification: contract?.verified_date ? formatDateTime(contract.verified_date) : 'Verified',
      note: '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'resubmission_requested' || (!reviewStatus && reservationStatus === 'resubmission_requested')) {
    return {
      key: 'resubmission_requested',
      label: 'Resubmission requested',
      verification: 'Waiting for customer re-upload',
      note: contract?.review_notes || 'Customer needs to upload a corrected signed contract.',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt: '',
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'pending_review' && contract?.resubmitted_at) {
    return {
      key: 'resubmitted',
      label: 'Replacement submitted',
      verification: 'Corrected contract is ready for review',
      note: '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  if (reviewStatus === 'pending_review' || contract?.contract_url) {
    return {
      key: 'pending',
      label: 'Pending review',
      verification: 'Awaiting contract review',
      note: contract?.review_notes || '',
      reviewedAt: contract?.reviewed_at ? formatDateTime(contract.reviewed_at) : '',
      resubmittedAt,
      hasFile: Boolean(contract.contract_url),
      contract
    };
  }

  return {
    key: 'default',
    label: 'Contract missing',
    verification: 'No contract file uploaded yet',
    note: '',
    reviewedAt: '',
    resubmittedAt: '',
    hasFile: false,
    contract
  };
}

function getReservationApprovalState(reservation) {
  const contract = getContractReviewMeta(reservation);
  if (!contract.hasFile) {
    return {
      canApprove: false,
      reason: 'The reservation cannot be approved until the customer uploads a signed contract.'
    };
  }

  if (contract.key !== 'approved') {
    return {
      canApprove: false,
      reason: 'Verify the signed contract first before approving the reservation.'
    };
  }

  return { canApprove: true, reason: '' };
}

function getContractActivityDate(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  return contract?.resubmitted_at
    || contract?.reviewed_at
    || contract?.verified_date
    || reservation?.created_at
    || 0;
}

function getReservationById(reservationId) {
  return contractsCache.find((reservation) => String(reservation.reservation_id) === String(reservationId)) || null;
}

function getContractCounts(list) {
  return list.reduce((counts, reservation) => {
    const key = getContractReviewMeta(reservation).key;
    counts.total += 1;
    if (key === 'pending') counts.pending += 1;
    if (key === 'resubmitted') counts.resubmitted += 1;
    if (key === 'resubmission_requested') counts.resubmissionRequested += 1;
    if (key === 'approved') counts.approved += 1;
    return counts;
  }, {
    total: 0,
    pending: 0,
    resubmitted: 0,
    resubmissionRequested: 0,
    approved: 0
  });
}

function renderStats(list) {
  const counts = getContractCounts(list);

  if (statPendingContracts) statPendingContracts.textContent = String(counts.pending);
  if (statReplacementContracts) statReplacementContracts.textContent = String(counts.resubmitted);
  if (statRequestedContracts) statRequestedContracts.textContent = String(counts.resubmissionRequested);
  if (statVerifiedContracts) statVerifiedContracts.textContent = String(counts.approved);
  if (statTotalContracts) statTotalContracts.textContent = String(counts.total);
  setBadgeCount(navContractCount, counts.pending + counts.resubmitted);

  if (!chipsRow) return;

  const chipCounts = {
    all: counts.total,
    pending: counts.pending,
    resubmitted: counts.resubmitted,
    resubmission_requested: counts.resubmissionRequested,
    approved: counts.approved
  };

  chipsRow.querySelectorAll('.chip').forEach((chip) => {
    const status = chip.dataset.status || 'all';
    const label = chip.textContent.split(' (')[0];
    chip.textContent = `${label} (${chipCounts[status] || 0})`;
  });
}

function matchesSearch(reservation, term) {
  if (!term) return true;
  const contract = getContractReviewMeta(reservation);
  const haystacks = [
    reservation.contact_name,
    reservation.contact_email,
    reservation.package?.package_name,
    reservation.event_type,
    reservation.venue_location,
    contract.note,
    contract.label
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return haystacks.some((value) => value.includes(term));
}

function matchesStatus(reservation, status) {
  if (status === 'all') return true;
  return getContractReviewMeta(reservation).key === status;
}

function renderTable(list) {
  if (!contractsBody) return;

  if (!list.length) {
    contractsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No submitted contracts matched the current filter.</td>
      </tr>
    `;
    return;
  }

  contractsBody.innerHTML = list.map((reservation) => {
    const contract = getContractReviewMeta(reservation);
          const reservationStatus = formatReservationStatus(getEffectiveReservationStatus(reservation));
    const reviewActivity = contract.resubmittedAt
      ? `Replacement submitted ${escapeHtml(contract.resubmittedAt)}`
      : contract.reviewedAt
        ? `Reviewed ${escapeHtml(contract.reviewedAt)}`
        : `Submitted ${escapeHtml(formatDateTime(reservation.created_at))}`;
    const eventSchedule = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;

    return `
      <tr class="reservation-row">
        <td data-label="Customer / Package">
          <div class="reservation-customer">
            <span class="reservation-avatar">${escapeHtml(getCustomerInitials(reservation.contact_name, reservation.contact_email))}</span>
            <div class="reservation-customer-copy">
              <span class="table-main">${escapeHtml(reservation.contact_name || 'Unknown customer')}</span>
              <span class="table-sub">${escapeHtml(reservation.contact_email || 'No email on file')}</span>
              <span class="table-meta">${escapeHtml(reservation.package?.package_name || 'Package pending')}</span>
            </div>
          </div>
        </td>
        <td data-label="Event Schedule">
          <div class="table-date">
            <span class="table-date-main">${escapeHtml(formatDate(reservation.event_date))}</span>
            <span class="table-date-time">${escapeHtml(reservation.event_time || 'No time selected')}</span>
            <span class="table-sub">${escapeHtml(reservation.event_type || 'Event')}</span>
          </div>
        </td>
        <td class="table-status-cell" data-label="Reservation Status">
          <div class="status-stack">
            <span class="status-pill ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>
          </div>
        </td>
        <td class="table-status-cell" data-label="Contract Status">
          <div class="status-stack">
            <span class="status-pill ${escapeHtml(contract.key)}">${escapeHtml(contract.label)}</span>
            <span class="table-sub">${escapeHtml(contract.verification)}</span>
            ${contract.note ? `<span class="table-note">${escapeHtml(contract.note)}</span>` : ''}
          </div>
        </td>
        <td data-label="Review Activity">
          <div class="contract-activity-stack">
            <span class="table-main">${reviewActivity}</span>
            <span class="table-sub">${escapeHtml(eventSchedule)}</span>
          </div>
        </td>
        <td class="actions actions-single" data-label="Action">
          <button class="action-btn view" data-action="review-contract" data-reservation-id="${reservation.reservation_id}">Review Contract</button>
        </td>
      </tr>
    `;
  }).join('');
}

function syncActiveChip() {
  if (!chipsRow) return;
  const selectedStatus = statusDropdown?.value || 'all';
  chipsRow.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.status === selectedStatus);
  });
}

function filterAndRender() {
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const status = statusDropdown?.value || 'all';
  const filtered = contractsCache.filter((reservation) => (
    matchesSearch(reservation, term)
    && matchesStatus(reservation, status)
  ));

  syncActiveChip();
  renderStats(contractsCache);
  renderTable(filtered);

  if (!contractsCache.length) {
    setMessage(tableMessage, 'No submitted contracts are available yet.');
  } else if (!filtered.length) {
    setMessage(tableMessage, 'No submitted contracts matched the current filter.');
  } else {
    setMessage(
      tableMessage,
      `Showing ${filtered.length} of ${contractsCache.length} submitted contract(s).`
    );
  }
}

async function fetchReservationContracts(reservationIds) {
  if (!reservationIds.length) return [];

  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at, resubmitted_at';
  const fallbackSelect = 'reservation_id, contract_url, verified_date, template_id';

  const { data, error } = await supabase
    .from('reservation_contracts')
    .select(extendedSelect)
    .in('reservation_id', reservationIds);

  if (!error) {
    return data || [];
  }

  if (
    isMissingColumnError(error, 'review_status')
    || isMissingColumnError(error, 'review_notes')
    || isMissingColumnError(error, 'reviewed_at')
    || isMissingColumnError(error, 'resubmitted_at')
  ) {
    const fallback = await supabase
      .from('reservation_contracts')
      .select(fallbackSelect)
      .in('reservation_id', reservationIds);

    if (fallback.error) throw fallback.error;
    return fallback.data || [];
  }

  throw error;
}

async function fetchReservations() {
  const { data: reservations, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      contact_name,
      contact_email,
      contact_phone,
      status,
      event_type,
      event_date,
      event_time,
      guest_count,
      location_type,
      venue_location,
      total_price,
      created_at,
      package:package_id ( package_name )
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const list = reservations || [];
  const reservationIds = list.map((reservation) => reservation.reservation_id).filter(Boolean);
  const contracts = await fetchReservationContracts(reservationIds);

  const contractsByReservationId = (contracts || []).reduce((map, contract) => {
    map[contract.reservation_id] = contract;
    return map;
  }, {});

  return list.map((reservation) => ({
    ...reservation,
    contracts: contractsByReservationId[reservation.reservation_id]
      ? [contractsByReservationId[reservation.reservation_id]]
      : []
  }));
}

async function logReservationStatusChange(reservationId, previousStatus, newStatus) {
  const { error } = await supabase
    .from('reservation_status')
    .insert({
      reservation_id: reservationId,
      previous_status: previousStatus || null,
      new_status: newStatus,
      changed_at: new Date().toISOString()
    });

  if (error) throw error;
}

async function updateReservationStatus(reservationId, status, previousStatus = null) {
  const normalizedPreviousStatus = String(previousStatus || '').toLowerCase();
  const normalizedNextStatus = String(status || '').toLowerCase();

  if (normalizedPreviousStatus && normalizedPreviousStatus === normalizedNextStatus) {
    return;
  }

  const { error } = await supabase
    .from('reservations')
    .update({ status })
    .eq('reservation_id', reservationId);

  if (error) throw error;

  await logReservationStatusChange(reservationId, previousStatus, status);
}

async function markReservationContractVerified(reservationId) {
  const { data, error } = await supabase
    .from('reservation_contracts')
    .update({
      review_status: 'verified',
      review_notes: null,
      reviewed_at: new Date().toISOString(),
      verified_date: new Date().toISOString()
    })
    .eq('reservation_id', reservationId)
    .not('contract_url', 'is', null)
    .select('reservation_id')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error('No uploaded contract was found for this reservation.');
  }
}

async function requestReservationContractResubmission(reservationId, reviewNotes) {
  const trimmedNotes = String(reviewNotes || '').trim();
  if (!trimmedNotes) {
    throw new Error('Please enter the contract correction note before requesting resubmission.');
  }

  const reviewedAt = new Date().toISOString();
  let response = await supabase
    .from('reservation_contracts')
    .update({
      review_status: 'resubmission_requested',
      review_notes: trimmedNotes,
      reviewed_at: reviewedAt,
      verified_date: null,
      resubmitted_at: null
    })
    .eq('reservation_id', reservationId)
    .not('contract_url', 'is', null)
    .select('reservation_id')
    .maybeSingle();

  if (response.error && isMissingColumnError(response.error, 'resubmitted_at')) {
    response = await supabase
      .from('reservation_contracts')
      .update({
        review_status: 'resubmission_requested',
        review_notes: trimmedNotes,
        reviewed_at: reviewedAt,
        verified_date: null
      })
      .eq('reservation_id', reservationId)
      .not('contract_url', 'is', null)
      .select('reservation_id')
      .maybeSingle();
  }

  const { data, error } = response;

  if (error) throw error;
  if (!data) {
    throw new Error('No uploaded contract was found for this reservation.');
  }
}

function setContractDetailsMessage(message = '', isError = false) {
  if (!contractDetailsMessage) return;
  contractDetailsMessage.textContent = message;
  contractDetailsMessage.classList.toggle('error', isError);
}

function closeContractDetailsModal() {
  activeContractReservationId = null;
  contractDetailsFlash = null;
  contractDetailsModal?.classList.add('hidden');
  contractDetailsModal?.setAttribute('aria-hidden', 'true');
  setContractDetailsMessage('');
}

function renderContractDetailsModal(reservationId = activeContractReservationId) {
  const reservation = getReservationById(reservationId);
  if (!reservation) return;

  activeContractReservationId = reservationId;

  const contract = getContractReviewMeta(reservation);
  const contractRecord = contract.contract;
  const reservationStatus = formatReservationStatus(reservation.status);
  const approvalState = getReservationApprovalState(reservation);
  const location = reservation.location_type === 'onsite'
    ? 'Onsite - ELI Coffee'
    : `Offsite - ${reservation.venue_location || 'Venue not provided'}`;

  contractDetailsHero.innerHTML = `
    <div class="reservation-hero-main">
      <span class="reservation-hero-avatar">${escapeHtml(getCustomerInitials(reservation.contact_name, reservation.contact_email))}</span>
      <div class="reservation-hero-copy">
        <div class="reservation-hero-name">${escapeHtml(reservation.contact_name || 'Unknown customer')}</div>
        <div class="reservation-hero-sub">${escapeHtml(reservation.contact_email || 'No email on file')}</div>
        <span class="reservation-hero-package">${escapeHtml(reservation.package?.package_name || 'Package pending')}</span>
      </div>
    </div>
    <div class="detail-badge-stack">
      <span class="status-pill ${escapeHtml(contract.key)}">${escapeHtml(contract.label)}</span>
      <span class="status-pill ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>
    </div>
  `;

  contractDetailsMeta.innerHTML = [
    buildDetailCard('Event Schedule', `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`),
    buildDetailCard('Latest Activity', contract.resubmittedAt || contract.reviewedAt || formatDateTime(getContractActivityDate(reservation))),
    buildDetailCard('Reservation Submitted', formatDateTime(reservation.created_at))
  ].join('');

  contractSummaryGrid.innerHTML = [
    buildDetailCard('Event Type', reservation.event_type || 'Event'),
    buildDetailCard('Location', location),
    buildDetailCard('Guests', String(reservation.guest_count || 0)),
    buildDetailCard('Total Price', formatCurrency(reservation.total_price)),
    buildDetailCard('Reservation Status', `<span class="status-pill ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>`, { raw: true }),
    buildDetailCard('Contract Status', `<span class="status-pill ${escapeHtml(contract.key)}">${escapeHtml(contract.label)}</span>`, { raw: true }),
    contract.reviewedAt ? buildDetailCard('Reviewed', contract.reviewedAt) : '',
    contract.resubmittedAt ? buildDetailCard('Replacement Submitted', contract.resubmittedAt) : '',
    contract.note ? buildDetailCard('Latest Review Note', contract.note, { full: true }) : ''
  ].filter(Boolean).join('');

  contractReviewSection.innerHTML = `
    <div class="details-grid compact-grid">
      ${buildDetailCard('Verification', contract.verification, { subtle: contract.key !== 'approved' })}
      ${buildDetailCard('Contract File', contractRecord?.contract_url ? 'Uploaded and ready to open' : 'Missing', { subtle: !contractRecord?.contract_url })}
    </div>
    <div class="details-action-row">
      ${contractRecord?.contract_url
        ? `<a class="action-btn view" href="${contractRecord.contract_url}" target="_blank" rel="noopener noreferrer">View Contract</a>`
        : '<span class="details-empty-inline">No contract file uploaded yet.</span>'}
    </div>
  `;

  const showReservationActions = ['pending', 'resubmission_requested'].includes(reservationStatus.key);

  contractActionsSection.innerHTML = `
    <div class="action-stack">
      <div class="details-action-row">
        ${['pending', 'resubmitted'].includes(contract.key)
          ? `<button class="action-btn approve" data-action="verify-contract" data-reservation-id="${reservation.reservation_id}">Approve Contract</button>`
          : ''}
        ${showReservationActions
          ? `<button
              class="action-btn approve"
              data-action="approve-reservation"
              data-reservation-id="${reservation.reservation_id}"
              ${approvalState.canApprove ? '' : 'disabled'}
              title="${escapeHtml(approvalState.canApprove ? 'Approve the linked reservation.' : approvalState.reason)}"
            >Approve Reservation</button>`
          : ''}
        ${showReservationActions
          ? `<button class="action-btn decline" data-action="decline-reservation" data-reservation-id="${reservation.reservation_id}">Decline Reservation</button>`
          : ''}
      </div>
      ${contract.key !== 'approved' ? `
        <label class="modal-field contract-note-field">
          <span class="modal-label">Correction note for the customer</span>
          <textarea
            class="modal-textarea"
            rows="4"
            data-contract-review-note="${reservation.reservation_id}"
            placeholder="Explain what the customer needs to fix before uploading the contract again."
          >${escapeHtml(contract.key === 'resubmission_requested' ? (contractRecord?.review_notes || '') : '')}</textarea>
        </label>
        <div class="details-action-row">
          <button class="action-btn request" data-action="request-contract-resubmission" data-reservation-id="${reservation.reservation_id}">Request Resubmission</button>
        </div>
      ` : ''}
    </div>
  `;

  if (contractDetailsFlash) {
    setContractDetailsMessage(contractDetailsFlash.message, contractDetailsFlash.isError);
    contractDetailsFlash = null;
  } else {
    setContractDetailsMessage('');
  }
}

function openContractDetailsModal(reservationId) {
  renderContractDetailsModal(reservationId);
  contractDetailsModal?.classList.remove('hidden');
  contractDetailsModal?.setAttribute('aria-hidden', 'false');
}

async function performContractAction(action, button) {
  const reservationId = button.dataset.reservationId;
  const reservation = getReservationById(reservationId);
  const previousStatus = reservation?.status || null;

  if (action === 'verify-contract') {
    await markReservationContractVerified(reservationId);
    return { message: 'Contract approved. You can now approve the reservation.' };
  }

  if (action === 'request-contract-resubmission') {
    const noteInput = contractActionsSection?.querySelector(`[data-contract-review-note="${reservationId}"]`);
    await requestReservationContractResubmission(reservationId, noteInput?.value || '');
    return { message: 'Customer has been asked to re-upload the signed contract.' };
  }

  if (action === 'approve-reservation') {
    const approvalState = getReservationApprovalState(reservation);
    if (!approvalState.canApprove) {
      throw new Error(approvalState.reason);
    }

    await updateReservationStatus(reservationId, 'approved', previousStatus);
    return { message: 'Reservation approved.' };
  }

  if (action === 'decline-reservation') {
    await updateReservationStatus(reservationId, 'declined', previousStatus);
    return { message: 'Reservation declined.' };
  }

  return { message: '' };
}

async function loadData() {
  setMessage(tableMessage, 'Loading contracts...');

  try {
    const reservations = await fetchReservations();
    allReservationsCount = reservations.length;
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });

    contractsCache = reservations
      .filter((reservation) => getContractReviewMeta(reservation).hasFile)
      .sort((left, right) => new Date(getContractActivityDate(right)) - new Date(getContractActivityDate(left)));

    filterAndRender();

    if (activeContractReservationId) {
      if (getReservationById(activeContractReservationId)) {
        renderContractDetailsModal(activeContractReservationId);
      } else {
        closeContractDetailsModal();
      }
    }
  } catch (error) {
    setMessage(tableMessage, `Failed to load contracts: ${error.message}`, true);
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    }).catch(() => {});
    renderStats([]);
    renderTable([]);
  }
}

function wireFilters() {
  searchInput?.addEventListener('input', filterAndRender);
  statusDropdown?.addEventListener('change', filterAndRender);
  chipsRow?.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    statusDropdown.value = button.dataset.status || 'all';
    filterAndRender();
  });
}

function wireTableActions() {
  contractsBody?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    if (action === 'review-contract') {
      openContractDetailsModal(button.dataset.reservationId);
    }
  });
}

function wireModals() {
  contractDetailsClose?.addEventListener('click', closeContractDetailsModal);
  contractDetailsDismiss?.addEventListener('click', closeContractDetailsModal);
  contractDetailsModal?.addEventListener('click', async (event) => {
    if (event.target === contractDetailsModal) {
      closeContractDetailsModal();
      return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    if (!action || action === 'review-contract') return;

    try {
      setContractDetailsMessage('Updating contract...');
      const result = await performContractAction(action, button);
      contractDetailsFlash = { message: result.message || 'Updated.', isError: false };
      await loadData();
      setMessage(tableMessage, result.message || 'Updated.');
    } catch (error) {
      setContractDetailsMessage(error.message, true);
      setMessage(tableMessage, `Failed to update contract: ${error.message}`, true);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeContractReservationId) {
      closeContractDetailsModal();
    }
  });
}

logoutBtn?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  redirectLogin();
});

refreshBtn?.addEventListener('click', loadData);

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') redirectLogin();
});

(async function init() {
  await validateAdmin();
  wireFilters();
  wireTableActions();
  wireModals();
  await loadData();
})();
