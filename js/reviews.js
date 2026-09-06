// /js/reviews.js
import { customerSupabase as supabase } from './supabase.js';
import { shouldHideReview } from './reviews_filter.js';
import { getEffectiveReservationStatus, getReservationPackageName } from './reservation_shared.js';

/* ============================================================
   STATE
============================================================ */
const REVIEWS_PER_PAGE = 10;
let showRatingOnly = false;
let allReviews = [];
let currentFilter = 'all';
let currentSort = 'newest';
let visibleCount = REVIEWS_PER_PAGE;

// Write-a-review flow: only relevant for a signed-in customer with at
// least one completed reservation that doesn't have a review yet.
let currentUser = null;
let eligibleReservations = [];
let activeReviewReservation = null;
let openedReviewFromPicker = false;
let reviewPromptRatingValue = 0;

/* ============================================================
   FETCH REVIEWS
============================================================ */
async function fetchReviews() {
    // Step 1: Get reviews
    const { data: reviews, error: reviewsError } = await supabase
        .from('reviews')
        .select('review_id, user_id, reservation_id, rating, comment, created_at')
        .order('created_at', { ascending: false });

    if (reviewsError) {
        throw reviewsError;
    }

    if (!reviews || reviews.length === 0) return [];

    // Step 2: Fetch profiles
    const userIds = [...new Set(reviews.map(r => r.user_id))];
    const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('user_id, first_name, last_name')
        .in('user_id', userIds);

    // Missing profile data just means `profile` is null for that review
    // below (rendering already handles that) — not worth interrupting the
    // page for.

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

        if (!resError) {
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
        </div>
    `;
}

/* ============================================================
   WRITE A REVIEW
============================================================ */
function getReservationEventMeta(reservation) {
    const packageName = getReservationPackageName(reservation);
    const date = formatDate(reservation.event_date);
    const time = reservation.event_time || 'No time selected';
    return `${escapeHtml(packageName)} • ${escapeHtml(date)} • ${escapeHtml(time)}`;
}

async function fetchMyReviewableReservations(userId) {
    const { data: reservations, error } = await supabase
        .from('reservations')
        .select(`
            reservation_id,
            event_type,
            event_date,
            event_time,
            status,
            package:package_id ( package_name )
        `)
        .eq('user_id', userId)
        .order('event_date', { ascending: false });

    if (error) throw error;

    const completed = (reservations || []).filter(
        (reservation) => getEffectiveReservationStatus(reservation) === 'completed'
    );

    if (!completed.length) return [];

    const reservationIds = completed.map((reservation) => reservation.reservation_id);

    const { data: existingReviews, error: reviewsError } = await supabase
        .from('reviews')
        .select('reservation_id')
        .eq('user_id', userId)
        .in('reservation_id', reservationIds);

    if (reviewsError) throw reviewsError;

    const reviewedIds = new Set((existingReviews || []).map((review) => review.reservation_id));

    return completed.filter((reservation) => !reviewedIds.has(reservation.reservation_id));
}

function updateWriteReviewVisibility() {
    const section = document.getElementById('writeReviewSection');
    if (!section) return;
    section.classList.toggle('hidden', eligibleReservations.length === 0);
}

async function initWriteReview() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        currentUser = session.user;
        eligibleReservations = await fetchMyReviewableReservations(currentUser.id);
        updateWriteReviewVisibility();
    } catch (err) {
        console.error('[reviews] failed to check reviewable reservations:', err);
    }
}

function renderReviewPickerList() {
    const list = document.getElementById('reviewPickerList');
    if (!list) return;

    list.innerHTML = eligibleReservations.map((reservation) => `
        <button type="button" class="review-picker-item" data-reservation-id="${escapeHtml(reservation.reservation_id)}">
            <div>
                <div class="review-picker-item__title">${escapeHtml(reservation.event_type || 'Event')}</div>
                <div class="review-picker-item__meta">${getReservationEventMeta(reservation)}</div>
            </div>
            <i class="fa-solid fa-chevron-right review-picker-item__chevron" aria-hidden="true"></i>
        </button>
    `).join('');
}

function openReviewPickerModal() {
    renderReviewPickerList();
    const backdrop = document.getElementById('review-picker-backdrop');
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
}

function closeReviewPickerModal() {
    const backdrop = document.getElementById('review-picker-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
}

function setReviewPromptRating(rating) {
    reviewPromptRatingValue = Math.max(0, Math.min(5, Number(rating || 0)));
    const ratingLabels = ['', 'Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];

    document.querySelectorAll('#review-prompt-rating [data-rating-value]').forEach((button) => {
        const value = Number(button.dataset.ratingValue);
        const isActive = value <= reviewPromptRatingValue;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-checked', String(value === reviewPromptRatingValue));
    });

    const ratingCopy = document.getElementById('review-prompt-rating-copy');
    if (ratingCopy) {
        ratingCopy.textContent = reviewPromptRatingValue
            ? `${ratingLabels[reviewPromptRatingValue]} selected`
            : 'Choose a rating before you submit.';
    }
}

function setReviewPromptMessage(message, type = '') {
    const messageEl = document.getElementById('review-prompt-message');
    if (!messageEl) return;
    messageEl.textContent = message;
    messageEl.classList.remove('error', 'success');
    if (type) messageEl.classList.add(type);
}

function setReviewPromptBusy(isBusy) {
    document.getElementById('review-prompt-close')?.toggleAttribute('disabled', isBusy);
    document.getElementById('review-prompt-back')?.toggleAttribute('disabled', isBusy);
    document.getElementById('review-prompt-submit')?.toggleAttribute('disabled', isBusy);
}

function openReviewPromptModal(reservation, { fromPicker = false } = {}) {
    activeReviewReservation = reservation;
    openedReviewFromPicker = fromPicker;

    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    setReviewPromptRating(0);

    const commentInput = document.getElementById('review-prompt-comment');
    if (commentInput) commentInput.value = '';

    const meta = document.getElementById('review-prompt-reservation-meta');
    if (meta) {
        meta.innerHTML = `
            <div class="review-reservation-title">${escapeHtml(reservation.event_type || 'Event')}</div>
            <div class="review-reservation-copy">${getReservationEventMeta(reservation)}</div>
        `;
    }

    closeReviewPickerModal();
    const backdrop = document.getElementById('review-prompt-backdrop');
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
}

function closeReviewPromptModal() {
    activeReviewReservation = null;
    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    const backdrop = document.getElementById('review-prompt-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
}

function openSubmissionFeedbackModal() {
    const backdrop = document.getElementById('submission-feedback-backdrop');
    document.getElementById('submission-feedback-eyebrow').textContent = 'Review Submitted';
    document.getElementById('submission-feedback-title').textContent = 'Thank You for the Feedback';
    document.getElementById('submission-feedback-copy').textContent = 'Your review has been saved to your completed reservation.';
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
}

function closeSubmissionFeedbackModal() {
    const backdrop = document.getElementById('submission-feedback-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
}

async function submitReservationReview() {
    const reservation = activeReviewReservation;
    if (!reservation || !currentUser) {
        setReviewPromptMessage('This reservation could not be found.', 'error');
        return;
    }

    if (!reviewPromptRatingValue) {
        setReviewPromptMessage('Choose a rating before you submit your review.', 'error');
        return;
    }

    try {
        setReviewPromptBusy(true);
        setReviewPromptMessage('Submitting your review...');

        const comment = document.getElementById('review-prompt-comment')?.value.trim() || null;

        const { error } = await supabase
            .from('reviews')
            .insert({
                reservation_id: reservation.reservation_id,
                user_id: currentUser.id,
                rating: reviewPromptRatingValue,
                comment
            });

        if (error) throw error;

        closeReviewPromptModal();

        // That reservation is no longer eligible; if it was opened from the
        // picker and others remain, the customer can reopen the picker from
        // the (still-visible) CTA button.
        eligibleReservations = eligibleReservations.filter(
            (entry) => entry.reservation_id !== reservation.reservation_id
        );
        updateWriteReviewVisibility();

        openSubmissionFeedbackModal();

        // Refresh the public list so the new review appears right away.
        try {
            const raw = await fetchReviews();
            allReviews = raw.filter((r) => !shouldHideReview(r.comment).hide);
            renderSummary();
            renderReviews();
        } catch (refreshError) {
            console.error('[reviews] failed to refresh reviews after submit:', refreshError);
        }
    } catch (error) {
        setReviewPromptBusy(false);
        const message = String(error?.message || '');
        if (message.includes('duplicate key value') || message.includes('reviews_reservation_id_key')) {
            setReviewPromptMessage('A review for this reservation was already submitted.', 'error');
        } else {
            setReviewPromptMessage('Failed to submit your review. Please try again.', 'error');
        }
    }
}

function setupWriteReviewListeners() {
    document.getElementById('writeReviewBtn')?.addEventListener('click', () => {
        if (eligibleReservations.length === 1) {
            openReviewPromptModal(eligibleReservations[0], { fromPicker: false });
        } else if (eligibleReservations.length > 1) {
            openReviewPickerModal();
        }
    });

    document.getElementById('review-picker-close')?.addEventListener('click', closeReviewPickerModal);
    document.getElementById('review-picker-backdrop')?.addEventListener('click', (event) => {
        if (event.target.id === 'review-picker-backdrop') closeReviewPickerModal();
    });
    document.getElementById('reviewPickerList')?.addEventListener('click', (event) => {
        const item = event.target.closest('.review-picker-item');
        if (!item) return;
        const reservation = eligibleReservations.find(
            (entry) => String(entry.reservation_id) === item.dataset.reservationId
        );
        if (reservation) openReviewPromptModal(reservation, { fromPicker: true });
    });

    document.getElementById('review-prompt-close')?.addEventListener('click', closeReviewPromptModal);
    document.getElementById('review-prompt-back')?.addEventListener('click', () => {
        closeReviewPromptModal();
        if (openedReviewFromPicker && eligibleReservations.length > 1) {
            openReviewPickerModal();
        }
    });
    document.getElementById('review-prompt-backdrop')?.addEventListener('click', (event) => {
        if (event.target.id === 'review-prompt-backdrop') closeReviewPromptModal();
    });
    document.getElementById('review-prompt-rating')?.addEventListener('click', (event) => {
        const starBtn = event.target.closest('[data-rating-value]');
        if (!starBtn) return;
        setReviewPromptRating(starBtn.dataset.ratingValue);
    });
    document.getElementById('review-prompt-submit')?.addEventListener('click', submitReservationReview);

    document.getElementById('submission-feedback-close')?.addEventListener('click', closeSubmissionFeedbackModal);
    document.getElementById('submission-feedback-dismiss')?.addEventListener('click', closeSubmissionFeedbackModal);
    document.getElementById('submission-feedback-backdrop')?.addEventListener('click', (event) => {
        if (event.target.id === 'submission-feedback-backdrop') closeSubmissionFeedbackModal();
    });
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
    setupWriteReviewListeners();

    const loadingEl = document.getElementById('reviewsLoading');

    // The write-a-review eligibility check runs independently of the public
    // reviews list so a slow or failed check never blocks the page.
    initWriteReview();

    try {
        const raw = await fetchReviews();

        allReviews = raw.filter(r => !shouldHideReview(r.comment).hide);

        if (loadingEl) loadingEl.remove();

        renderSummary();
        renderReviews();
    } catch (err) {
        if (loadingEl) loadingEl.remove();
        showError('We couldn\'t load reviews right now. Please try again shortly.');
    }
}

document.addEventListener('DOMContentLoaded', init);