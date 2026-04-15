import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyAdminSession } from './admin_auth.js';
import { markAdminReviewsSeen, refreshAdminSidebarCounts } from './admin_sidebar_counts.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const logoutBtn = document.getElementById('logoutBtn');
const refreshReviewsBtn = document.getElementById('refreshReviewsBtn');
const searchInput = document.getElementById('searchInput');
const reviewsMessage = document.getElementById('reviewsMessage');
const reviewsBody = document.getElementById('reviewsBody');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

const statTotalReviews = document.getElementById('statTotalReviews');
const statAverageRating = document.getElementById('statAverageRating');
const statFiveStarReviews = document.getElementById('statFiveStarReviews');
const statCommentedReviews = document.getElementById('statCommentedReviews');

let allReviews = [];
let adminSession = null;

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
      <tr>
        <td>
          <div class="customer-cell">
            <div class="customer-head">
              <span class="customer-avatar">${escapeHtml(getCustomerInitials(customer, reservation))}</span>
              <div>
                <span class="table-main">${escapeHtml(customerName)}</span>
                <span class="table-sub">${escapeHtml(customerEmail)}</span>
              </div>
            </div>
          </div>
        </td>
        <td>
          <span class="table-main">${escapeHtml(reservationLabel)}</span>
          <span class="table-sub">${escapeHtml(packageLabel)}</span>
          <span class="table-sub">${escapeHtml(formatDate(reservation.event_date))}</span>
        </td>
        <td>
          <span class="review-rating-pill">${escapeHtml(`${Number(review.rating || 0)}/5`)}</span>
        </td>
        <td>
          <span class="table-main review-comment" title="${escapeHtml(review.comment || 'No comment provided.')}">${escapeHtml(comment)}</span>
        </td>
        <td>
          <span class="table-main">${escapeHtml(formatDateTime(review.created_at))}</span>
          <span class="table-sub">Review submitted</span>
        </td>
      </tr>
    `;
  }).join('');
}

function updateStats(reviews) {
  const totalReviews = reviews.length;
  const totalRating = reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0);
  const fiveStarReviews = reviews.filter((review) => Number(review.rating || 0) === 5).length;
  const commentedReviews = reviews.filter((review) => Boolean(String(review.comment || '').trim())).length;
  const averageRating = totalReviews ? (totalRating / totalReviews).toFixed(1) : '0.0';

  if (statTotalReviews) statTotalReviews.textContent = String(totalReviews);
  if (statAverageRating) statAverageRating.textContent = averageRating;
  if (statFiveStarReviews) statFiveStarReviews.textContent = String(fiveStarReviews);
  if (statCommentedReviews) statCommentedReviews.textContent = String(commentedReviews);
}

function applyFilters() {
  const query = (searchInput?.value || '').trim().toLowerCase();
  const filteredReviews = !query
    ? allReviews
    : allReviews.filter((review) => {
      const customer = review.customer || {};
      const reservation = review.reservation || {};
      const haystacks = [
        getCustomerName(customer, reservation),
        customer.email,
        reservation.contact_email,
        reservation.event_type,
        review.packageName,
        review.comment,
        String(review.rating || '')
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());

      return haystacks.some((value) => value.includes(query));
    });

  renderReviews(filteredReviews);

  const summaryText = filteredReviews.length
    ? `Showing ${filteredReviews.length} of ${allReviews.length} submitted review(s).`
    : `No submitted reviews matched "${query}".`;

  setReviewsMessage(summaryText);
}

async function fetchProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select(`
      user_id,
      first_name,
      middle_name,
      last_name,
      email,
      role
    `)
    .eq('role', 'customer');

  if (error) {
    throw error;
  }

  return data || [];
}

async function fetchReservations() {
  const { data, error } = await supabase
    .from('reservations')
    .select(`
      reservation_id,
      user_id,
      contact_name,
      contact_email,
      event_type,
      event_date,
      package:package_id ( package_name )
    `);

  if (error) {
    throw error;
  }

  return data || [];
}

async function fetchReviews() {
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
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

function mergeReviewsWithContext(reviews, profiles, reservations) {
  const profilesById = profiles.reduce((map, profile) => {
    map[profile.user_id] = profile;
    return map;
  }, {});

  const reservationsById = reservations.reduce((map, reservation) => {
    map[reservation.reservation_id] = reservation;
    return map;
  }, {});

  return reviews.map((review) => {
    const customer = profilesById[review.user_id] || {};
    const reservation = reservationsById[review.reservation_id] || {};

    return {
      ...review,
      customer,
      reservation,
      packageName: reservation.package?.package_name || 'Package not available'
    };
  });
}

async function loadReviews() {
  setReviewsMessage('Loading reviews...');

  try {
    if (adminSession?.user?.id) {
      await markAdminReviewsSeen({
        supabase,
        userId: adminSession.user.id
      }).catch((error) => {
        console.warn('Unable to mark reviews as seen:', error?.message || error);
      });
    }

    const [profiles, reservations, reviews] = await Promise.all([
      fetchProfiles(),
      fetchReservations(),
      fetchReviews()
    ]);

    allReviews = mergeReviewsWithContext(reviews, profiles, reservations);
    updateStats(allReviews);

    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });

    applyFilters();
  } catch (error) {
    console.error('Failed to load reviews:', error);
    allReviews = [];
    updateStats([]);
    renderReviews([]);
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    }).catch(() => {});
    setReviewsMessage(
      `Failed to load submitted reviews: ${error?.message || 'unknown error'}. Check the reviews table, grants, and RLS policies for the admin account.`,
      true
    );
  }
}

async function validateAdminSession() {
  const { session, profile } = await verifyAdminSession(supabase);

  if (!session) {
    await supabase.auth.signOut();
    redirectToAdminLogin();
    return null;
  }

  populatePortalIdentity({
    profile,
    session,
    nameEl: sidebarName,
    emailEl: sidebarEmail,
    roleEl: sidebarRolePill,
    fallbackLabel: 'Admin'
  });

  adminSession = session;
  return session;
}

logoutBtn?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  redirectToAdminLogin();
});

refreshReviewsBtn?.addEventListener('click', async () => {
  await loadReviews();
});

searchInput?.addEventListener('input', () => {
  applyFilters();
});

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    redirectToAdminLogin();
  }
});

const session = await validateAdminSession();
if (session) {
  await loadReviews();
}
