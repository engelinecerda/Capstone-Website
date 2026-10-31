import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { markAdminReviewsSeen, refreshAdminSidebarCounts } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { renderPagination, getTotalPages, getPageRange } from './pagination.js';
import { initAutoRefresh } from './auto_refresh.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const searchInput = document.getElementById('searchInput');
const reviewsMessage = document.getElementById('reviewsMessage');
const reviewsBody = document.getElementById('reviewsBody');
const reviewsPagination = document.getElementById('reviewsPagination');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

const statTotalReviews = document.getElementById('statTotalReviews');
const statAverageRating = document.getElementById('statAverageRating');
const statFiveStarReviews = document.getElementById('statFiveStarReviews');
const statCommentedReviews = document.getElementById('statCommentedReviews');

// Server-side pagination: the database returns one page of reviews at a time
// (get_admin_reviews_page), already joined with the customer, reservation and
// package details and filtered by the search term. The browser never holds the
// full review list.
// 15 rows is about a screen and a half at these row heights: enough to scan
// recent reviews without constant page-clicking, short enough to stay quick.
const REVIEWS_PAGE_SIZE = 15;
const SEARCH_DEBOUNCE_MS = 300;

let reviewsCurrentPage = 1;
let reviewsTotal = 0;        // reviews matching the active search
let totalReviewCount = 0;    // all reviews, ignoring the search
let activeSearch = '';       // the search term currently applied
let latestRequestId = 0;     // lets a newer request supersede an older one
let searchDebounceTimer = null;
let adminSession = null;
let currentPageReviews = [];

function redirectToAdminLogin() {
  window.location.replace('/admin');
}

function setReviewsMessage(message, isError = false) {
  if (!reviewsMessage) return;
  reviewsMessage.textContent = message;
  reviewsMessage.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  if (!value) return 'No date';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date';

  return date.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function formatDateTime(value) {
  if (!value) return 'No date';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date';

  return date.toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function getCustomerName(profile = {}, reservation = {}) {
  const nameParts = [
    profile.first_name,
    profile.middle_name,
    profile.last_name
  ].filter(Boolean);

  if (nameParts.length) {
    return nameParts.join(' ');
  }

  return reservation.contact_name || profile.email || reservation.contact_email || 'Unknown customer';
}

function getCustomerInitials(profile = {}, reservation = {}) {
  const initials = [profile.first_name, profile.last_name]
    .filter(Boolean)
    .map((value) => value.trim().charAt(0).toUpperCase())
    .join('');

  if (initials) return initials;

  const fallbackName = reservation.contact_name || profile.email || reservation.contact_email || 'C';
  return fallbackName.trim().charAt(0).toUpperCase();
}

function truncateText(value, maxLength = 180) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function renderReviews(reviews) {
  if (!reviewsBody) return;

  if (!reviews.length) {
    reviewsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">No submitted reviews matched this search.</td>
      </tr>
    `;
    return;
  }

  reviewsBody.innerHTML = reviews.map((review) => {
    const customer = review.customer || {};
    const reservation = review.reservation || {};
    const customerName = getCustomerName(customer, reservation);
    const customerEmail = customer.email || reservation.contact_email || 'No email on file';
    const reservationLabel = reservation.event_type || 'Completed reservation';
    const packageLabel = review.packageName || 'Package not available';
    const comment = review.comment?.trim()
      ? truncateText(review.comment, 180)
      : 'No comment provided.';

    return `
      <tr class="review-row ${review.is_hidden ? 'is-hidden' : ''}" data-review-id="${escapeHtml(review.review_id)}" tabindex="0" role="button" aria-label="Open review details for ${escapeHtml(customerName)}">
        <td data-label="Customer">
          <div class="customer-cell">
            <div class="customer-head">
              <span class="avatar">${escapeHtml(getCustomerInitials(customer, reservation))}</span>
              <div>
                <span class="table-main">${escapeHtml(customerName)}</span>
                <span class="table-sub">${escapeHtml(customerEmail)}</span>
                ${review.is_anonymous ? '<span class="review-anon-pill" title="The customer chose to post this review anonymously. Only staff can see who wrote it."><i class="ti ti-eye-off" aria-hidden="true"></i> Anonymous publicly</span>' : ''}
                ${review.is_hidden ? '<span class="review-hidden-pill">Hidden</span>' : ''}
              </div>
            </div>
          </div>
        </td>
        <td data-label="Reservation">
          <span class="table-main">${escapeHtml(reservationLabel)}</span>
          <span class="table-sub">${escapeHtml(packageLabel)}</span>
          <span class="table-sub">${escapeHtml(formatDate(reservation.event_date))}</span>
        </td>
        <td data-label="Rating">
          <span class="review-rating-pill">${escapeHtml(`${Number(review.rating || 0)}/5`)}</span>
        </td>
        <td data-label="Comment">
          <span class="table-main review-comment" title="${escapeHtml(review.comment || 'No comment provided.')}">${escapeHtml(comment)}</span>
        </td>
        <td data-label="Submitted">
          <span class="table-main">${escapeHtml(formatDateTime(review.created_at))}</span>
          <span class="table-sub">Review submitted</span>
        </td>
      </tr>
    `;
  }).join('');
}

function closeReviewDetail() {
  document.getElementById('reviewDetailModal')?.classList.add('hidden');
}

function openReviewDetail(review) {
  if (!review) return;
  const customer = review.customer || {};
  const reservation = review.reservation || {};
  document.getElementById('reviewDetailCustomer').textContent = getCustomerName(customer, reservation);
  document.getElementById('reviewDetailEmail').textContent = customer.email || reservation.contact_email || 'No email on file';
  document.getElementById('reviewDetailReservation').textContent = `${reservation.event_type || 'Completed reservation'} · ${review.packageName || 'Package not available'} · ${formatDate(reservation.event_date)}`;
  document.getElementById('reviewDetailRating').textContent = `${Number(review.rating || 0)}/5`;
  document.getElementById('reviewDetailComment').textContent = review.comment || 'No comment provided.';
  document.getElementById('reviewDetailSubmitted').textContent = formatDateTime(review.created_at);
  document.getElementById('reviewDetailAnonymous').textContent = review.is_anonymous ? 'Shown anonymously to guests' : 'Customer name shown to guests';
  document.getElementById('reviewDetailStatus').textContent = review.is_hidden ? `Hidden · ${review.moderation_reason}` : 'Visible publicly';
  document.getElementById('reviewModerationReason').value = review.is_hidden ? review.moderation_reason : '';
  const action = document.getElementById('reviewModerationAction');
  action.textContent = review.is_hidden ? 'Unhide review' : 'Hide review';
  action.dataset.reviewId = review.review_id;
  action.dataset.hidden = String(!review.is_hidden);
  document.getElementById('reviewDetailMessage').textContent = '';
  document.getElementById('reviewDetailModal')?.classList.remove('hidden');
}

async function moderateOpenReview(button) {
  const reason = document.getElementById('reviewModerationReason').value.trim();
  const message = document.getElementById('reviewDetailMessage');
  if (!reason) { message.textContent = 'Enter a reason for this moderation action.'; return; }
  button.disabled = true;
  try {
    const { error } = await supabase.rpc('moderate_review', {
      p_review_id: button.dataset.reviewId,
      p_hidden: button.dataset.hidden === 'true',
      p_reason: reason
    });
    if (error) throw error;
    closeReviewDetail();
    await loadReviews({ withStats: true });
  } catch (error) {
    message.textContent = `Could not update review: ${error.message || 'unknown error'}`;
  } finally {
    button.disabled = false;
  }
}

// The four stat cards. They describe ALL reviews, never the current search.
function updateStats(stats) {
  const safe = stats || {};
  const totalReviews = Number(safe.total) || 0;
  const averageRating = totalReviews ? Number(safe.average_rating || 0).toFixed(1) : '0.0';

  if (statTotalReviews) statTotalReviews.textContent = String(totalReviews);
  if (statAverageRating) statAverageRating.textContent = averageRating;
  if (statFiveStarReviews) statFiveStarReviews.textContent = String(Number(safe.five_star) || 0);
  if (statCommentedReviews) statCommentedReviews.textContent = String(Number(safe.commented) || 0);
}

function renderReviewsView(reviews) {
  renderReviews(reviews);
  renderPagination(reviewsPagination, {
    totalItems: reviewsTotal,
    currentPage: reviewsCurrentPage,
    pageSize: REVIEWS_PAGE_SIZE,
    onPageChange: (page) => {
      reviewsCurrentPage = page;
      loadReviews({ withStats: false });
    }
  });

  // reviews.length is the rows on screen (at most one page); the "1-10 of N"
  // range for the current search is in the pagination bar below the table.
  if (reviewsTotal) {
    setReviewsMessage('');
  } else if (activeSearch) {
    setReviewsMessage(`No submitted reviews matched "${activeSearch}".`);
  } else {
    setReviewsMessage('No submitted reviews yet.');
  }
}

// One page of reviews (filtered by `search`), each row already carrying the
// customer, reservation and package details it needs. The RPC takes
// limit/offset, which is the same window .range(from, to) would select.
async function fetchReviewsPage(page, search) {
  const { from } = getPageRange(page, REVIEWS_PAGE_SIZE);
  const { data, error } = await supabase.rpc('get_admin_reviews_page', {
    p_search: search || null,
    p_limit: REVIEWS_PAGE_SIZE,
    p_offset: from
  });

  if (error) {
    throw error;
  }

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return {
    total: Number(data?.total) || 0,
    reviews: rows.map((row) => ({
      review_id: row.review_id,
      reservation_id: row.reservation_id,
      user_id: row.user_id,
      rating: row.rating,
      comment: row.comment,
      created_at: row.created_at,
      is_anonymous: !!row.is_anonymous,
      is_hidden: !!row.is_hidden,
      moderation_reason: row.moderation_reason || '',
      moderated_at: row.moderated_at || null,
      customer: {
        first_name: row.first_name,
        middle_name: row.middle_name,
        last_name: row.last_name,
        email: row.customer_email
      },
      reservation: {
        contact_name: row.contact_name,
        contact_email: row.contact_email,
        event_type: row.event_type,
        event_date: row.event_date
      },
      packageName: row.package_name || 'Package not available'
    }))
  };
}

// If the requested page no longer exists (reviews were removed since the last
// load, so there are fewer pages now), fall back to the last page that does
// exist instead of showing an empty table.
async function fetchPageWithClamp(page, search) {
  let result = await fetchReviewsPage(page, search);
  const lastPage = getTotalPages(result.total, REVIEWS_PAGE_SIZE);

  if (page > lastPage) {
    page = lastPage;
    result = await fetchReviewsPage(page, search);
  }

  return { ...result, page };
}

async function fetchReviewStats() {
  const { data, error } = await supabase.rpc('get_admin_review_stats');

  if (error) {
    throw error;
  }

  return data || {};
}

function refreshSidebarBadges() {
  return refreshAdminSidebarCounts({
    supabase,
    reservationBadgeEl: navReservationCount,
    paymentBadgeEl: navPaymentCount,
    contractBadgeEl: navContractCount,
    reviewBadgeEl: navReviewCount
  }).catch(() => {});
}

// silent=true is used by the auto-refresh triggers: it skips the
// "Loading..." message so existing rows stay on screen, and on failure it
// keeps the last-good data and fails quietly instead of blanking the table.
// withStats=false is used for page changes and searches, which don't affect
// the stat cards or the unread-review badge, so only the page itself is fetched.
// Every call takes a request id; if a newer call starts before this one
// finishes, this one's result is discarded so a slow, older response can
// never overwrite a newer one.
async function loadReviews({ silent = false, withStats = true } = {}) {
  const requestId = ++latestRequestId;

  if (!silent) {
    setReviewsMessage('Loading reviews...');
  }

  try {
    // Reviews are marked seen BEFORE the sidebar recount below, so the
    // unread badge drops to 0 on this very load.
    if (withStats && adminSession?.user?.id) {
      await markAdminReviewsSeen({
        supabase,
        userId: adminSession.user.id
      }).catch(() => {});
    }

    const [result, stats] = await Promise.all([
      fetchPageWithClamp(reviewsCurrentPage, activeSearch),
      withStats ? fetchReviewStats() : Promise.resolve(null)
    ]);

    if (requestId !== latestRequestId) return;

    reviewsCurrentPage = result.page;
    reviewsTotal = result.total;
    currentPageReviews = result.reviews;

    if (!activeSearch) {
      totalReviewCount = result.total;
    } else if (stats) {
      totalReviewCount = Number(stats.total) || 0;
    }

    if (stats) {
      updateStats(stats);
    }

    renderReviewsView(result.reviews);

    if (withStats) {
      await refreshSidebarBadges();
    }
  } catch (error) {
    if (requestId !== latestRequestId) return;

    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded reviews:', error.message);
      return;
    }

    reviewsTotal = 0;
    if (withStats) {
      updateStats(null);
    }
    renderReviews([]);
    renderPagination(reviewsPagination, {
      totalItems: 0,
      currentPage: 1,
      pageSize: REVIEWS_PAGE_SIZE,
      onPageChange: () => {}
    });
    if (withStats) {
      await refreshSidebarBadges();
    }
    setReviewsMessage(
      `Failed to load submitted reviews: ${error?.message || 'unknown error'}.`,
      true
    );
  }
}

// Search runs in the database, so wait for a short pause in typing instead of
// sending a request on every keystroke. A new search always starts at page 1.
function handleSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const nextSearch = (searchInput?.value || '').trim();
    if (nextSearch === activeSearch) return;

    activeSearch = nextSearch;
    reviewsCurrentPage = 1;
    loadReviews({ withStats: false });
  }, SEARCH_DEBOUNCE_MS);
}

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {

    // Save session (you use this later)
    adminSession = session;

    // Setup inactivity
    setupInactivityLogout(profile.role);
    const avatarEl = document.getElementById('sidebarAvatar');
    if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
    const roleBottomEl = document.getElementById('sidebarRoleBottom');
    if (roleBottomEl) roleBottomEl.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });

    // Wire UI
    searchInput?.addEventListener('input', handleSearchInput);
    reviewsBody?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-review-id]');
      if (row) openReviewDetail(currentPageReviews.find((review) => String(review.review_id) === row.dataset.reviewId));
    });
    reviewsBody?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('[data-review-id]');
      if (!row) return;
      event.preventDefault();
      openReviewDetail(currentPageReviews.find((review) => String(review.review_id) === row.dataset.reviewId));
    });
    document.getElementById('reviewDetailClose')?.addEventListener('click', closeReviewDetail);
    document.getElementById('reviewDetailModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'reviewDetailModal') closeReviewDetail();
    });
    document.getElementById('reviewModerationAction')?.addEventListener('click', (event) => moderateOpenReview(event.currentTarget));

    // Load data
    await loadReviews();
  }
});

// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
initAutoRefresh(() => loadReviews({ silent: true }));
