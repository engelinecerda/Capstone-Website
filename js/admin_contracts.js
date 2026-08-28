// admin/contracts.js
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges  } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { PAGE_SIZE, paginate, renderPagination, getTotalPages } from './pagination.js';
import { logAudit } from './audit_logger.js';

const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const statusDropdown = document.getElementById('statusDropdown');
const tableMessage = document.getElementById('tableMessage');
const contractsBody = document.getElementById('contractsBody');
const contractsPagination = document.getElementById('contractsPagination');
const chipsRow = document.getElementById('chipsRow');


const statPendingContracts = document.getElementById('statPendingContracts');
const statVerifiedContracts = document.getElementById('statVerifiedContracts');
const statTotalContracts = document.getElementById('statTotalContracts');

const contractDetailsModal = document.getElementById('contractDetailsModal');
const contractDetailsClose = document.getElementById('contractDetailsClose');
const contractReviewAvatar = document.getElementById('contractReviewAvatar');
const contractReviewName = document.getElementById('contractReviewName');
const contractReviewStatusPill = document.getElementById('contractReviewStatusPill');
const contractReviewMeta = document.getElementById('contractReviewMeta');
const contractContextRows = document.getElementById('contractContextRows');
const viewContractLink = document.getElementById('viewContractLink');
const contractSignaturePanel = document.getElementById('contractSignaturePanel');
const contractVerifyRows = document.getElementById('contractVerifyRows');
const contractInlineActions = document.getElementById('contractInlineActions');
const contractStatusRows = document.getElementById('contractStatusRows');
const contractDetailsMessage = document.getElementById('contractDetailsMessage');
const contractFooterActions = document.getElementById('contractFooterActions');

let contractsCache = [];
let contractsFiltered = [];
let contractsCurrentPage = 1;
let allReservationsCount = 0;
let activeContractReservationId = null;
let contractDetailsFlash = null;
let refreshSidebarBadges = () => {};
let currentRole = null;

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
  window.location.replace('/admin/index.html');
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

// Definition-list row — mirrors the .dl-row pattern from
// admin_reservation_details.css (see the CSS file for why it's a local
// copy rather than a shared import). options.full stacks label above
// value instead of a label-left/value-right split, for long values like
// addresses; options.raw skips HTML-escaping for pre-built markup (e.g. a
// status pill); options.muted applies the lighter .dl-value.muted color;
// options.titleAttr adds a title="" (for ellipsis-truncated long values).
function dlRow(label, value, options = {}) {
  const valueClasses = ['dl-value'];
  if (options.muted) valueClasses.push('muted');
  const titleAttr = options.titleAttr ? ` title="${escapeHtml(options.titleAttr)}"` : '';
  return `
    <div class="dl-row${options.full ? ' full' : ''}">
      <span class="dl-label">${escapeHtml(label)}</span>
      <span class="${valueClasses.join(' ')}"${titleAttr}>${options.raw ? value : escapeHtml(value)}</span>
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
    rescheduled: 'Rescheduled'
  };

  return {
    key,
    label: labels[key] || key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  };
}

function getContractReviewMeta(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  const reviewStatus = String(contract?.review_status || '').toLowerCase();

  if (!contract) {
    return {
      key: 'default',
      label: 'Contract missing',
      verification: 'No contract file uploaded yet',
      note: '',
      reviewedAt: '',
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
      reason: 'The reservation cannot be approved until the contract has been verified.'
    };
  }

  return { canApprove: true, reason: '' };
}

function getContractActivityDate(reservation) {
  const contract = reservation?.contracts?.[0] || null;
  return contract?.reviewed_at
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
    if (key === 'approved') {
      counts.approved += 1;
    } else {
      counts.pending += 1;
    }
    return counts;
  }, {
    total: 0,
    pending: 0,
    approved: 0
  });
}

function renderStats(list) {
  const counts = getContractCounts(list);

  if (statPendingContracts) statPendingContracts.textContent = String(counts.pending);
  if (statVerifiedContracts) statVerifiedContracts.textContent = String(counts.approved);
  if (statTotalContracts) statTotalContracts.textContent = String(counts.total);

  if (!chipsRow) return;

  const chipCounts = {
    all: counts.total,
    pending: counts.pending,
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
    reservation.reservation_number,
    contract.note,
    contract.label
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return haystacks.some((value) => value.includes(term));
}

function matchesStatus(reservation, status) {
  if (status === 'all') return true;
  const key = getContractReviewMeta(reservation).key;
  if (status === 'pending') return key !== 'approved';
  return key === status;
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
    const reviewActivity = contract.reviewedAt
      ? `Reviewed ${escapeHtml(contract.reviewedAt)}`
      : `Submitted ${escapeHtml(formatDateTime(reservation.created_at))}`;
    const eventSchedule = `${formatDate(reservation.event_date)} at ${reservation.event_time || 'No time selected'}`;

    return `
      <tr class="reservation-row">
        <td data-label="Customer / Package">
          <div class="reservation-customer">
            <span class="avatar">${escapeHtml(getCustomerInitials(reservation.contact_name, reservation.contact_email))}</span>
            <div class="reservation-customer-copy">
              ${reservation.reservation_number ? `<span class="table-reservation-number">${escapeHtml(reservation.reservation_number)}</span>` : ''}
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

function filterAndRender({ resetPage = true } = {}) {
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const status = statusDropdown?.value || 'all';
  const filtered = contractsCache.filter((reservation) => (
    matchesSearch(reservation, term)
    && matchesStatus(reservation, status)
  ));

  syncActiveChip();
  renderStats(contractsCache);
  contractsFiltered = filtered;
  if (resetPage) {
    contractsCurrentPage = 1;
  } else {
    contractsCurrentPage = Math.min(contractsCurrentPage, getTotalPages(filtered.length, PAGE_SIZE));
  }
  renderContractsPage();

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

function renderContractsPage() {
  renderTable(paginate(contractsFiltered, contractsCurrentPage, PAGE_SIZE));
  renderPagination(contractsPagination, {
    totalItems: contractsFiltered.length,
    currentPage: contractsCurrentPage,
    pageSize: PAGE_SIZE,
    onPageChange: (page) => {
      contractsCurrentPage = page;
      renderContractsPage();
    }
  });
}

async function fetchReservationContracts(reservationIds) {
  if (!reservationIds.length) return [];

  const extendedSelect = 'reservation_id, contract_url, verified_date, template_id, review_status, review_notes, reviewed_at';
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
      reservation_number,
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

const SIGNATURE_CHECK_ICON = {
  detected: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  alert: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
};

// Returns which of the two documented states (plus a transient third one —
// upload has happened but the async verify-contract scan hasn't posted a
// result yet) this contract's review_notes free-text implies. review_notes
// is where the auto-verify Edge Function and the manual-verify path both
// record their outcome — see getContractReviewMeta above and
// handlePerformVerifyContract below.
function getSignatureCheckState(contract) {
  const note = String(contract.contract?.review_notes || '');
  if (/signature detected/i.test(note)) return 'detected';
  if (/no .*signature detected|not detected/i.test(note)) return 'not-detected';
  return 'not-scanned';
}

function renderSignatureCheckPanel(contract) {
  const state = getSignatureCheckState(contract);

  const copy = {
    detected: {
      icon: SIGNATURE_CHECK_ICON.detected,
      title: 'Signature detected — verified automatically',
      sub: 'Open the contract to confirm it matches.'
    },
    'not-detected': {
      icon: SIGNATURE_CHECK_ICON.alert,
      title: 'No signature detected',
      sub: 'Review the contract and verify manually, or request a new upload.'
    },
    'not-scanned': {
      icon: SIGNATURE_CHECK_ICON.alert,
      title: 'Signature check not yet complete',
      sub: 'The automatic scan hasn’t finished yet. Open the contract and verify manually if needed.'
    }
  }[state];

  contractSignaturePanel.className = `signature-check-panel state-${state}`;
  contractSignaturePanel.innerHTML = `
    <span class="signature-check-icon">${copy.icon}</span>
    <span class="signature-check-copy">
      <span class="signature-check-title">${escapeHtml(copy.title)}</span>
      <span class="signature-check-sub">${escapeHtml(copy.sub)}</span>
    </span>
  `;

  return state;
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

  // ── Sticky identity header ──────────────────────────────────────
  contractReviewAvatar.textContent = getCustomerInitials(reservation.contact_name, reservation.contact_email);
  contractReviewName.textContent = reservation.contact_name || 'Unknown customer';
  contractReviewStatusPill.className = `status-pill ${escapeHtml(contract.key)}`;
  contractReviewStatusPill.textContent = contract.label;
  contractReviewMeta.textContent = [
    reservation.reservation_number || 'No reservation number',
    reservation.event_type || 'Event',
    `${formatDate(reservation.event_date)} at ${reservation.event_time || 'no time selected'}`
  ].join(' · ');

  // ── Reservation context card ────────────────────────────────────
  contractContextRows.innerHTML = `
    <div class="dl-grid-2col">
      ${dlRow('Event type', reservation.event_type || 'Event')}
      ${dlRow('Guests', String(reservation.guest_count || 0))}
      ${dlRow('Package', reservation.package?.package_name || 'Package pending')}
      ${dlRow('Total price', formatCurrency(reservation.total_price))}
    </div>
    ${dlRow('Location', location, { full: true, titleAttr: location })}
  `;

  // ── Contract card ────────────────────────────────────────────────
  if (contractRecord?.contract_url) {
    viewContractLink.href = contractRecord.contract_url;
    viewContractLink.classList.remove('hidden');
  } else {
    viewContractLink.classList.add('hidden');
  }

  if (contractRecord?.contract_url) {
    const signatureState = renderSignatureCheckPanel(contract);
    contractSignaturePanel.classList.remove('hidden');

    if (signatureState === 'detected') {
      // TODO(contract-review): an "undo / flag as not verified" action for
      // an auto-verified contract is intentionally deferred — see the
      // implementation prompt this build was scoped from. When it's built,
      // it attaches here (auto-verified branch of the Contract card,
      // probably as a quiet text link next to the Verified row below) and
      // needs a new state transition (verified -> pending_review) that
      // doesn't exist yet in getContractReviewMeta/performContractAction.
      contractVerifyRows.innerHTML = dlRow(
        'Verified',
        contract.reviewedAt || contract.verification || 'Just now',
        { muted: true }
      );
      contractInlineActions.innerHTML = '';
    } else {
      contractVerifyRows.innerHTML = '';
      contractInlineActions.innerHTML = currentRole === 'admin' ? '' : `
        <button type="button" class="contract-action-btn primary" data-action="verify-contract" data-reservation-id="${reservation.reservation_id}">
          Verify contract
        </button>
        <!-- Request resubmission intentionally omitted: the manager-side
             "request resubmission" action and the customer-side re-upload
             flow were removed at the database level in
             supabase/migrations/20260825_remove_contract_resubmission.sql
             (review_status is now constrained to just 'pending_review' /
             'verified', and reservation_contracts.resubmitted_at was
             dropped). Re-adding this button needs that schema decision
             revisited first, not just a UI change. -->
      `;
    }
  } else {
    contractSignaturePanel.classList.add('hidden');
    contractSignaturePanel.innerHTML = '';
    contractVerifyRows.innerHTML = dlRow('Contract file', 'No contract file uploaded yet.', { muted: true });
    contractInlineActions.innerHTML = '';
  }

  // ── Reservation card ─────────────────────────────────────────────
  contractStatusRows.innerHTML = [
    dlRow('Status', `<span class="status-pill ${escapeHtml(reservationStatus.key)}">${escapeHtml(reservationStatus.label)}</span>`, { raw: true }),
    dlRow('Submitted', formatDateTime(reservation.created_at))
  ].join('');

  // ── Pinned footer ────────────────────────────────────────────────
  const showReservationActions = currentRole !== 'admin' && reservationStatus.key === 'pending';

  contractFooterActions.innerHTML = (currentRole === 'admin' || !showReservationActions) ? '' : `
    <button
      type="button"
      class="contract-action-btn decline"
      data-action="decline-reservation"
      data-reservation-id="${reservation.reservation_id}"
    >Decline</button>
    <button
      type="button"
      class="contract-action-btn primary"
      data-action="approve-reservation"
      data-reservation-id="${reservation.reservation_id}"
      ${approvalState.canApprove ? '' : 'disabled'}
      title="${escapeHtml(approvalState.canApprove ? 'Approve the linked reservation.' : approvalState.reason)}"
    >Approve reservation</button>
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
  if (currentRole === 'admin') {
    throw new Error('This action requires the Manager role.');
  }

  const reservationId = button.dataset.reservationId;
  const reservation = getReservationById(reservationId);
  const previousStatus = reservation?.status || null;

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

  if (action === 'verify-contract') {
    if (!reservation) throw new Error('Reservation could not be found.');

    const confirmed = window.confirm(
      'Confirm you have opened the contract PDF and visually verified the signature is present and matches the client name.\n\n'
      + 'This will mark the contract as verified, bypassing the automatic scan, and allow the reservation to be approved.'
    );
    if (!confirmed) return null;

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('reservation_contracts')
      .update({
        review_status: 'verified',
        verified_date: now,
        reviewed_at: now,
        review_notes: 'Manually verified: signature confirmed by staff visual review (automatic scan did not detect it).'
      })
      .eq('reservation_id', reservationId);

    if (error) throw error;

    await logAudit({
      action: 'Manually Verified Contract Signature',
      category: 'contracts',
      details: 'Automatic signature scan did not confirm a signature; verified manually after visual review.',
      entityId: reservationId
    });

    return { message: 'Contract manually verified. The reservation can now be approved.' };
  }

  return { message: '' };
}

async function loadData({ silent = false } = {}) {
  if (!silent) {
    setMessage(tableMessage, 'Loading contracts...');
  }

  try {
    const reservations = await fetchReservations();
    allReservationsCount = reservations.length;
    await refreshSidebarBadges();

    contractsCache = reservations
      .filter((reservation) => getContractReviewMeta(reservation).hasFile)
      .sort((left, right) => new Date(getContractActivityDate(right)) - new Date(getContractActivityDate(left)));

    filterAndRender({ resetPage: !silent });

     if (!silent && activeContractReservationId) {
      if (getReservationById(activeContractReservationId)) {
        renderContractDetailsModal(activeContractReservationId);
      } else {
        closeContractDetailsModal();
      }
    }
  } catch (error) {
    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded contracts:', error.message);
      return;
    }
    setMessage(tableMessage, `Failed to load contracts: ${error.message}`, true);
    await refreshSidebarBadges().catch(() => {});
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
      if (result === null) {
        setContractDetailsMessage('');
        return;
      }
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

let lastAutoRefreshAt = 0;
const AUTO_REFRESH_DEBOUNCE_MS = 3000;
const AUTO_REFRESH_POLL_MS = 60000;

function triggerAutoRefresh() {
  const now = Date.now();
  if (now - lastAutoRefreshAt < AUTO_REFRESH_DEBOUNCE_MS) return;
  lastAutoRefreshAt = now;
  loadData({ silent: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') triggerAutoRefresh();
});
window.addEventListener('focus', triggerAutoRefresh);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) triggerAutoRefresh();
});
setInterval(triggerAutoRefresh, AUTO_REFRESH_POLL_MS);

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {

    currentRole = profile.role;

    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    refreshSidebarBadges = initAdminSidebarBadges(supabase);
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });
    wireFilters();
    wireTableActions();
    wireModals();
    
    await loadData();

    const requestedReservationId = new URLSearchParams(window.location.search).get('reservation');
    if (requestedReservationId && getReservationById(requestedReservationId)) {
      openContractDetailsModal(requestedReservationId);
    }
  }
});