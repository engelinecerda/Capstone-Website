// admin/contracts.js
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges  } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { renderPagination, getTotalPages, getPageRange } from './pagination.js';
import { logAudit } from './audit_logger.js';
import { initAutoRefresh } from './auto_refresh.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

const sidebarNameEl = document.getElementById('sidebarName');
const sidebarEmailEl = document.getElementById('sidebarEmail');
const sidebarRolePillEl = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
// The status chips are the only status filter; the page opens on "Pending" so the
// contracts that need review are shown first.
let activeStatus = 'pending';
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

// Server-side pagination: the database returns one page of contracts at a time
// (get_admin_contracts_page), already filtered by status and search, and the
// stat-card / chip counts come from get_admin_contract_counts(). The browser
// never holds the full contract list.
const CONTRACTS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

let visibleContracts = [];        // the rows of the page on screen
let contractsCurrentPage = 1;
let contractsTotal = 0;           // contracts matching the active filters
let contractsOverallTotal = 0;    // all contracts with a file (ignores filters)
let activeSearch = '';            // the search term currently applied
let latestRequestId = 0;          // lets a newer request supersede an older one
let searchDebounceTimer = null;
let activeReservationRecord = null; // the open review window's contract when it is not on the page on screen
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
  window.location.replace('/admin');
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

// This page doesn't fetch reservation_payment_summary, so it has no way
// to confirm a reservation is paid in full — it no longer infers
// 'completed' from the event date alone (that requires balance data, see
// js/reservation_status.js). An already-persisted 'completed' status
// still passes straight through above.
function getEffectiveReservationStatus(reservation) {
  const normalizedStatus = String(reservation?.status || 'pending').toLowerCase();
  if (['completed', 'cancelled', 'declined'].includes(normalizedStatus)) {
    return normalizedStatus;
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

function getReservationById(reservationId) {
  const match = (reservation) => String(reservation?.reservation_id) === String(reservationId);
  return visibleContracts.find(match)
    || (match(activeReservationRecord) ? activeReservationRecord : null);
}

function renderStats(counts) {
  const safeCounts = {
    total: Number(counts?.total) || 0,
    pending: Number(counts?.pending) || 0,
    approved: Number(counts?.approved) || 0
  };

  if (statPendingContracts) statPendingContracts.textContent = String(safeCounts.pending);
  if (statVerifiedContracts) statVerifiedContracts.textContent = String(safeCounts.approved);
  if (statTotalContracts) statTotalContracts.textContent = String(safeCounts.total);

  if (!chipsRow) return;

  const chipCounts = {
    all: safeCounts.total,
    pending: safeCounts.pending,
    approved: safeCounts.approved
  };

  chipsRow.querySelectorAll('.chip').forEach((chip) => {
    const status = chip.dataset.status || 'all';
    const label = chip.textContent.split(' (')[0];
    chip.textContent = `${label} (${chipCounts[status] || 0})`;
  });
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
  chipsRow.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.status === activeStatus);
  });
}

function getActiveStatus() {
  return activeStatus;
}

function getEmptyMessage() {
  if (!contractsOverallTotal) return 'No submitted contracts are available yet.';
  return 'No submitted contracts matched the current filter.';
}

function renderContractsView() {
  syncActiveChip();
  renderTable(visibleContracts);
  renderPagination(contractsPagination, {
    totalItems: contractsTotal,
    currentPage: contractsCurrentPage,
    pageSize: CONTRACTS_PAGE_SIZE,
    onPageChange: (page) => {
      contractsCurrentPage = page;
      loadData({ full: false });
    }
  });

  // With rows on screen the pagination bar below the table already says
  // "Showing x-y of N", so the message line stays empty (same as the
  // Reservations page) instead of repeating a count that reads like "all
  // of them are shown". It only speaks when there is nothing to show.
  setMessage(tableMessage, contractsTotal ? '' : getEmptyMessage());
}

// One page of contracts (already filtered by status / search in the
// database), each row carrying its contract record. The RPC takes
// limit/offset, which is the same window .range(from, to) would select.
// Shaped here to what the rest of this file expects: the package as
// { package_name } and the contract as a one-item contracts array.
function shapeContractRow(row) {
  const { package_name: packageName, contract, ...reservation } = row;
  return {
    ...reservation,
    package: packageName ? { package_name: packageName } : null,
    contracts: contract ? [contract] : []
  };
}

async function fetchContractsPage(page, { status, search }) {
  const { from } = getPageRange(page, CONTRACTS_PAGE_SIZE);
  const { data, error } = await supabase.rpc('get_admin_contracts_page', {
    p_status: status,
    p_search: search || null,
    p_reservation_id: null,
    p_limit: CONTRACTS_PAGE_SIZE,
    p_offset: from
  });

  if (error) throw error;

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    total: Number(data?.total) || 0,
    rows: rows.map(shapeContractRow)
  };
}

// If the requested page no longer exists (contracts were removed or changed
// status since the last load, so there are fewer pages now), fall back to the
// last page that does exist instead of showing an empty table.
async function fetchPageWithClamp(page, filters) {
  let result = await fetchContractsPage(page, filters);
  const lastPage = getTotalPages(result.total, CONTRACTS_PAGE_SIZE);

  if (page > lastPage) {
    page = lastPage;
    result = await fetchContractsPage(page, filters);
  }

  return { ...result, page };
}

// One contract by reservation id, whatever the filters or page on screen.
// Used for the "?reservation=<id>" deep link and to keep the review window
// open after an action moves its contract off the page on screen.
async function fetchContractByReservationId(reservationId) {
  const { data, error } = await supabase.rpc('get_admin_contracts_page', {
    p_status: 'all',
    p_search: null,
    p_reservation_id: reservationId,
    p_limit: 1,
    p_offset: 0
  });

  if (error) throw error;

  const row = Array.isArray(data?.rows) ? data.rows[0] : null;
  return row ? shapeContractRow(row) : null;
}

// Makes sure the contract for the review window is available: from the page
// on screen if it is there, otherwise fetched on its own.
async function ensureReservationLoaded(reservationId) {
  if (!reservationId) return null;

  if (visibleContracts.some((reservation) => String(reservation.reservation_id) === String(reservationId))) {
    activeReservationRecord = null;
    return getReservationById(reservationId);
  }

  activeReservationRecord = await fetchContractByReservationId(reservationId);
  return getReservationById(reservationId);
}

// Stat cards and status chips. They describe ALL contracts, never the current
// search or page.
async function fetchContractCounts() {
  const { data, error } = await supabase.rpc('get_admin_contract_counts');
  if (error) throw error;
  return data || {};
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

async function updateReservationStatus(reservationId, status, previousStatus = null, reservationNumber = null) {
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

  // reservation_status (above) is the status history; this adds who did it to
  // the audit trail. Only approve / decline are audited here.
  if (normalizedNextStatus === 'approved' || normalizedNextStatus === 'declined') {
    await logAudit({
      action: normalizedNextStatus === 'approved' ? 'Approved Reservation' : 'Declined Reservation',
      category: 'reservation',
      details: `${normalizedNextStatus === 'approved' ? 'Approved' : 'Declined'} reservation${reservationNumber ? ` ${reservationNumber}` : ''}`
        + (previousStatus ? ` (was ${previousStatus})` : ''),
      entityId: reservationId
    });
  }
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
  activeReservationRecord = null;
  contractDetailsFlash = null;
  contractDetailsModal?.classList.add('hidden');
  contractDetailsModal?.setAttribute('aria-hidden', 'true');
  setContractDetailsMessage('');
  unlockBodyScroll();
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
  lockBodyScroll();
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

    await updateReservationStatus(reservationId, 'approved', previousStatus, reservation?.reservation_number);
    return { message: 'Reservation approved.' };
  }

  if (action === 'decline-reservation') {
    await updateReservationStatus(reservationId, 'declined', previousStatus, reservation?.reservation_number);
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
      category: 'contract',
      details: 'Automatic signature scan did not confirm a signature; verified manually after visual review.',
      entityId: reservationId
    });

    return { message: 'Contract manually verified. The reservation can now be approved.' };
  }

  return { message: '' };
}

// silent=true is used by the auto-refresh trigger: it skips the "Loading..."
// message so existing rows stay on screen, and on failure it keeps the
// last-good data and fails quietly instead of blanking the table.
// full=false is used for page changes, searches and filter changes, which
// don't affect the stat cards or chips, so only the page itself is fetched.
// Every call takes a request id; if a newer call starts before this one
// finishes, this one's result is discarded so a slow, older response can
// never overwrite a newer one.
async function loadData({ silent = false, full = true } = {}) {
  const requestId = ++latestRequestId;

  if (!silent) {
    setMessage(tableMessage, 'Loading contracts...');
  }

  try {
    const [pageResult, counts] = await Promise.all([
      fetchPageWithClamp(contractsCurrentPage, { status: getActiveStatus(), search: activeSearch }),
      full ? fetchContractCounts() : Promise.resolve(null)
    ]);
    if (requestId !== latestRequestId) return;

    if (full) {
      await refreshSidebarBadges();
      if (requestId !== latestRequestId) return;
    }

    contractsCurrentPage = pageResult.page;
    contractsTotal = pageResult.total;
    visibleContracts = pageResult.rows;

    if (counts) {
      contractsOverallTotal = Number(counts.total) || 0;
      renderStats(counts);
    }

    // Keep the open review window current. Its contract may have moved off
    // the page on screen (e.g. verified while the Pending filter is on), so
    // it is fetched on its own when needed.
    if (!silent && activeContractReservationId) {
      await ensureReservationLoaded(activeContractReservationId);
      if (requestId !== latestRequestId) return;
    }

    renderContractsView();

    if (!silent && activeContractReservationId) {
      if (getReservationById(activeContractReservationId)) {
        renderContractDetailsModal(activeContractReservationId);
      } else {
        closeContractDetailsModal();
      }
    }
  } catch (error) {
    if (requestId !== latestRequestId) return;

    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded contracts:', error.message);
      return;
    }
    setMessage(tableMessage, `Failed to load contracts: ${error.message}`, true);
    if (full) {
      await refreshSidebarBadges().catch(() => {});
    }
    contractsTotal = 0;
    visibleContracts = [];
    renderStats(null);
    renderTable([]);
    renderPagination(contractsPagination, {
      totalItems: 0,
      currentPage: 1,
      pageSize: CONTRACTS_PAGE_SIZE,
      onPageChange: () => {}
    });
  }
}

// A changed filter or search always starts again from page 1.
function reloadFromFirstPage() {
  contractsCurrentPage = 1;
  loadData({ full: false });
}

// Search runs in the database, so wait for a short pause in typing instead of
// sending a request on every keystroke.
function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const nextSearch = String(searchInput?.value || '').trim();
    if (nextSearch === activeSearch) return;

    activeSearch = nextSearch;
    reloadFromFirstPage();
  }, SEARCH_DEBOUNCE_MS);
}

function wireFilters() {
  searchInput?.addEventListener('input', handleSearchInput);
  chipsRow?.addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    activeStatus = button.dataset.status || 'all';
    syncActiveChip();
    reloadFromFirstPage();
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

initAutoRefresh(() => loadData({ silent: true }));

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

    // Deep link (?reservation=<id>): the contract may not be on the first
    // page, so it is looked up on its own.
    const requestedReservationId = new URLSearchParams(window.location.search).get('reservation');
    if (requestedReservationId) {
      try {
        if (await ensureReservationLoaded(requestedReservationId)) {
          openContractDetailsModal(requestedReservationId);
        }
      } catch (error) {
        console.warn('Could not open the requested contract:', error.message);
      }
    }
  }
});