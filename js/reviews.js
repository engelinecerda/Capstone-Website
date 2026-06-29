// /js/reviews.js
import { customerSupabase as supabase } from './supabase.js';
import { shouldHideReview } from './reviews_filter.js';

/* ============================================================
   STATE
============================================================ */
const REVIEWS_PER_PAGE = 10;
let showRatingOnly = false;
let allReviews = [];
let currentFilter = 'all';
let currentSort = 'newest';
let visibleCount = REVIEWS_PER_PAGE;

/* ============================================================
   FETCH REVIEWS
============================================================ */
async function fetchReviews() {
    console.log('[Reviews] Fetching reviews from Supabase...');

    // Step 1: Get reviews
    const { data: reviews, error: reviewsError } = await supabase
        .from('reviews')
        .select('review_id, user_id, reservation_id, rating, comment, created_at')
        .order('created_at', { ascending: false });

    if (reviewsError) {
        console.error('[Reviews] Error fetching reviews:', reviewsError);
        throw reviewsError;
    }

    console.log('[Reviews] Got', reviews?.length || 0, 'reviews');
    if (!reviews || reviews.length === 0) return [];

    // Step 2: Fetch profiles
    const userIds = [...new Set(reviews.map(r => r.user_id))];
    const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name')
        .in('user_id', userIds);

    if (profilesError) {
        console.warn('[Reviews] Could not fetch profiles:', profilesError);
    }

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.user_id] = p; });

    // Step 3: Fetch reservations with package name (same FK join as admin panel)
    const reservationIds = [...new Set(reviews.map(r => r.reservation_id).filter(Boolean))];
    const packageNameMap = {};

    if (reservationIds.length > 0) {
        const { data: reservations, error: resError } = await supabase
            .from('reservations')
            .select('reservation_id, package:package_id ( package_name )')
            .in('reservation_id', reservationIds);

        if (resError) {
            console.warn('[Reviews] Could not fetch reservation packages:', resError);
        } else {
            (reservations || []).forEach(res => {
                packageNameMap[res.reservation_id] = res.package?.package_name || null;
            });
        }
    }

    // Step 4: Merge into reviews
    return reviews.map(r => ({
        ...r,
        profile:     profileMap[r.user_id] || null,
        packageName: r.reservation_id ? (packageNameMap[r.reservation_id] || null) : null,
    }));
}

/* ============================================================
   RENDER HELPERS
============================================================ */
function renderStars(rating) {
    return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function getInitials(name) {
    if (!name || name === 'Anonymous') return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

function getDisplayName(profile) {
    if (!profile) return 'Anonymous';
    const fn = profile.first_name || '';
    const ln = profile.last_name || '';
    return (fn + ' ' + ln).trim() || 'Anonymous';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/* ============================================================
   RENDER LIST
============================================================ */
function renderReviews() {
    const list            = document.getElementById('reviewsList');
    const empty           = document.getElementById('reviewsEmpty');
    const loadMoreWrapper = document.getElementById('loadMoreWrapper');
    const loadMoreBtn     = document.getElementById('loadMoreBtn');
    const countText       = document.getElementById('reviewsCountText');

    let filtered = showRatingOnly
        ? [...allReviews]
        : allReviews.filter(r => r.comment && r.comment.trim().length > 0);

    if (currentFilter !== 'all') {
        filtered = filtered.filter(r => r.rating === Number(currentFilter));
    }

    switch (currentSort) {
        case 'newest':  filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); break;
        case 'oldest':  filtered.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)); break;
        case 'highest': filtered.sort((a, b) => b.rating - a.rating); break;
        case 'lowest':  filtered.sort((a, b) => a.rating - b.rating); break;
    }

    const totalFiltered = filtered.length;

    if (totalFiltered === 0) {
        list.innerHTML = '';
        empty.hidden = false;
        loadMoreWrapper.hidden = true;
        return;
    }
    empty.hidden = true;

    const visible = filtered.slice(0, visibleCount);

    list.innerHTML = visible.map(r => {
        const name       = getDisplayName(r.profile);
        const initials   = getInitials(name);
        const stars      = renderStars(r.rating);
        const date       = formatDate(r.created_at);
        const hasComment = r.comment && r.comment.trim().length > 0;

        const cardClass   = hasComment ? 'review-card' : 'review-card is-rating-only';
        const commentHtml = hasComment
            ? escapeHtml(r.comment)
            : 'No written comment — rating only.';
        const badgeHtml   = hasComment
            ? `<span class="review-card__badge"><i class="fa-solid fa-circle-check"></i> Verified Reservation</span>`
            : `<span class="review-card__rating-only-badge"><i class="fa-solid fa-star"></i> Rating Only</span>`;

        const packageHtml = r.packageName
            ? `<div class="review-card__package"><i class="fa-solid fa-box"></i> ${escapeHtml(r.packageName)}</div>`
            : '';

        return `
            <article class="${cardClass}">
                <div class="review-card__header">
                    <div class="review-card__user">
                        <div class="review-card__avatar">${initials}</div>
                        <div>
                            <div class="review-card__name">${escapeHtml(name)}</div>
                            <div class="review-card__date">${date}</div>
                        </div>
                    </div>
                    <div class="review-card__stars" aria-label="${r.rating} out of 5 stars">
                        ${stars}
                    </div>
                </div>
                ${packageHtml}
                <p class="review-card__comment">${commentHtml}</p>
                ${badgeHtml}
            </article>
        `;
    }).join('');

    if (visibleCount >= totalFiltered) {
        if (totalFiltered > REVIEWS_PER_PAGE) {
            loadMoreWrapper.hidden = false;
            countText.textContent = `Showing all ${totalFiltered} reviews`;
            loadMoreBtn.hidden = true;
        } else {
            loadMoreWrapper.hidden = true;
        }
    } else {
        loadMoreWrapper.hidden = false;
        loadMoreBtn.hidden = false;
        countText.textContent = `Showing ${visible.length} of ${totalFiltered} reviews`;
        loadMoreBtn.innerHTML = `Load More Reviews <i class="fa-solid fa-chevron-down"></i>`;
    }
}

/* ============================================================
   SUMMARY
============================================================ */
function renderSummary() {
    const total     = allReviews.length;
    const avgEl     = document.getElementById('averageRating');
    const totalEl   = document.getElementById('totalReviews');
    const starsEl   = document.getElementById('averageStars');
    const breakdown = document.getElementById('ratingBreakdown');

    totalEl.textContent = total;

    if (total === 0) {
        avgEl.textContent   = '0.0';
        starsEl.textContent = '☆☆☆☆☆';
        breakdown.innerHTML = '';
        return;
    }

    const avg = allReviews.reduce((acc, r) => acc + r.rating, 0) / total;
    avgEl.textContent   = avg.toFixed(1);
    starsEl.textContent = renderStars(Math.round(avg));

    let html = '';
    for (let star = 5; star >= 1; star--) {
        const count = allReviews.filter(r => r.rating === star).length;
        const pct   = total ? (count / total) * 100 : 0;
        html += `
            <div class="rating-bar-row">
                <span>${star} ★</span>
                <div class="rating-bar-track">
                    <div class="rating-bar-fill" style="width:${pct}%;"></div>
                </div>
                <span class="rating-bar-count">${count}</span>
            </div>
        `;
    }
    breakdown.innerHTML = html;
}

/* ============================================================
   ERROR DISPLAY
============================================================ */
function showError(message) {
    const list = document.getElementById('reviewsList');
    list.innerHTML = `
        <div class="reviews-loading" style="grid-column:1/-1;">
            <i class="fa-solid fa-triangle-exclamation" style="color:#c0392b;"></i>
            <h3 style="color:#c0392b;">Could not load reviews</h3>
            <p>${escapeHtml(message)}</p>
            <p style="font-size:12px;margin-top:10px;">Check the browser console (F12) for details.</p>
        </div>
    `;
}

/* ============================================================
   LISTENERS
============================================================ */
function setupListeners() {
    document.querySelectorAll('.reviews-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.reviews-filter').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            currentFilter = btn.dataset.filter;
            visibleCount  = REVIEWS_PER_PAGE;
            renderReviews();
        });
    });

    document.getElementById('sortReviews').addEventListener('change', e => {
        currentSort  = e.target.value;
        visibleCount = REVIEWS_PER_PAGE;
        renderReviews();
    });

    document.getElementById('loadMoreBtn').addEventListener('click', () => {
        visibleCount += REVIEWS_PER_PAGE;
        renderReviews();
        const lastCard = document.querySelectorAll('.review-card')[visibleCount - REVIEWS_PER_PAGE];
        if (lastCard) lastCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    document.getElementById('toggleRatingOnly').addEventListener('change', e => {
        showRatingOnly = e.target.checked;
        visibleCount   = REVIEWS_PER_PAGE;
        renderReviews();
    });
}

/* ============================================================
   INIT
============================================================ */
async function init() {
    setupListeners();

    const loadingEl = document.getElementById('reviewsLoading');

    try {
        const raw = await fetchReviews();
        console.log('[Reviews] Raw data sample:', raw.slice(0, 2));

        allReviews = raw.filter(r => {
            const result = shouldHideReview(r.comment);
            if (result.hide) {
                console.log(`🚫 Hidden (${result.reason}):`, r.comment?.slice(0, 60));
            }
            return !result.hide;
        });

        console.log(`[Reviews] Showing ${allReviews.length} of ${raw.length} reviews`);

        if (loadingEl) loadingEl.remove();

        renderSummary();
        renderReviews();
    } catch (err) {
        console.error('[Reviews] Init failed:', err);
        if (loadingEl) loadingEl.remove();
        showError(err.message || 'An unexpected error occurred.');
    }
}

document.addEventListener('DOMContentLoaded', init);
