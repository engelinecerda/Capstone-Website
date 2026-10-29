// /js/reviews.js
import { customerSupabase as supabase } from './supabase.js';
import { getEffectiveReservationStatus, getReservationPackageName } from './reservation_shared.js';
import {
    fetchPayments as fetchSharedPayments,
    getReservationBalanceDetails as getSharedReservationBalanceDetails
} from './customer_payments.js';
import { initAutoRefresh } from './auto_refresh.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

/* ============================================================
   STATE
============================================================ */
const REVIEWS_PER_PAGE = 10;
let showRatingOnly = false;
let allReviews = [];
let currentFilter = 'all';
let mineOnly = false; // "My Reviews" chip: show only the signed-in customer's reviews
let currentSort = 'newest';
let visibleCount = REVIEWS_PER_PAGE;

// Write-a-review flow: only relevant for a signed-in customer with at
// least one completed reservation that doesn't have a review yet.
let currentUser = null;
let eligibleReservations = [];
let activeReviewReservation = null;
let reviewPromptRatingValue = 0;

// Edit-my-review flow: the review currently open in the edit modal.
let editingReview = null;

/* ============================================================
   FETCH REVIEWS
============================================================ */
// Reads through get_public_reviews_with_moderation() (supabase/migrations/
// 20261107_review_moderation.sql). The database blanks the reviewer's name
// on anonymous reviews BEFORE the row reaches the browser, and flags the
// signed-in customer's own reviews with is_mine so the Edit button can show.
async function fetchReviews() {
    const { data, error } = await supabase.rpc('get_public_reviews_with_moderation');

    if (error) {
        // Only fall back when the function simply isn't installed yet (the
        // migration hasn't been run). Any other failure must NOT fall back:
        // the legacy path below has no idea which reviews are anonymous.
        const code = String(error.code || '');
        if (code === 'PGRST202' || code === '42883') {
            return fetchReviewsLegacy();
        }
        throw error;
    }

    // Moderation reasons are private to the review author and staff. Fetch
    // them through an authenticated, owner-scoped function rather than the
    // public review RPC so other guests never receive the reason.
    let moderationReasons = new Map();
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (session?.user?.id) {
        const { data: reasons, error: reasonError } = await supabase.rpc('get_my_hidden_review_reasons');
        if (reasonError) {
            console.warn('[reviews] could not load private moderation reasons:', reasonError.message);
        } else {
            moderationReasons = new Map((reasons || []).map(row => [String(row.review_id), row.moderation_reason]));
        }
    }

    return (data || []).map(r => ({
        review_id:      r.review_id,
        reservation_id: r.reservation_id,
        rating:         r.rating,
        comment:        r.comment,
        created_at:     r.created_at,
        is_anonymous:   !!r.is_anonymous,
        is_mine:        !!r.is_mine,
        is_hidden:      !!r.is_hidden,
        moderation_reason: moderationReasons.get(String(r.review_id)) || '',
        profile:        r.is_anonymous ? null : { first_name: r.first_name, last_name: r.last_name },
        packageName:    r.package_name || null,
    }));
}

// Pre-migration path (no anonymous reviews can exist yet). Remove once
// 20261105_anonymous_reviews.sql has been applied everywhere.
async function fetchReviewsLegacy() {
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
// Shows the "My Reviews" chip only for a signed-in customer who has at least
// one public review; is_mine comes from the database (get_public_reviews).
function updateMyReviewsButton() {
    const btn = document.getElementById('myReviewsBtn');
    if (!btn) return;

    const count = allReviews.filter(r => r.is_mine).length;
    if (count === 0) mineOnly = false;

    btn.hidden = count === 0;
    btn.classList.toggle('is-active', mineOnly);
    btn.setAttribute('aria-pressed', String(mineOnly));
    const countEl = document.getElementById('myReviewsCount');
    if (countEl) countEl.textContent = count > 0 ? `(${count})` : '';
}

function renderReviews() {
    const list            = document.getElementById('reviewsList');
    const empty           = document.getElementById('reviewsEmpty');
    const loadMoreWrapper = document.getElementById('loadMoreWrapper');
    const loadMoreBtn     = document.getElementById('loadMoreBtn');
    const countText       = document.getElementById('reviewsCountText');

    updateMyReviewsButton();

    // "My Reviews" ignores the rating-only toggle so the customer always sees
    // every review they posted, including ones without a comment.
    let filtered = mineOnly
        ? allReviews.filter(r => r.is_mine)
        : showRatingOnly
            ? allReviews.filter(r => !r.is_hidden)
            : allReviews.filter(r => !r.is_hidden && r.comment && r.comment.trim().length > 0);

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
        const emptyTitle = document.getElementById('reviewsEmptyTitle');
        const emptyCopy  = document.getElementById('reviewsEmptyCopy');
        if (emptyTitle && emptyCopy) {
            emptyTitle.textContent = mineOnly ? 'No reviews to show' : 'No reviews yet';
            emptyCopy.textContent  = mineOnly
                ? 'None of your reviews match this star filter. Try "All".'
                : 'Be the first to share your experience after your reservation!';
        }
        list.innerHTML = '';
        empty.hidden = false;
        loadMoreWrapper.hidden = true;
        return;
    }
    empty.hidden = true;

    const visible = filtered.slice(0, visibleCount);

    list.innerHTML = visible.map(r => {
        const isAnon     = !!r.is_anonymous;
        const name       = isAnon ? 'Anonymous' : getDisplayName(r.profile);
        const initials   = getInitials(name);
        const stars      = renderStars(r.rating);
        const date       = formatDate(r.created_at);
        const hasComment = r.comment && r.comment.trim().length > 0;

        const cardClass   = hasComment ? 'review-card' : 'review-card is-rating-only';
        const commentHtml = hasComment
            ? escapeHtml(r.comment)
            : 'No written comment — rating only.';
        const badgeHtml   = hasComment
            ? `<span class="review-card__badge"><i class="ti ti-circle-check"></i> Verified Reservation</span>`
            : `<span class="review-card__rating-only-badge"><i class="ti ti-star"></i> Rating Only</span>`;

        const packageHtml = r.packageName
            ? `<div class="review-card__package"><i class="ti ti-box"></i> ${escapeHtml(r.packageName)}</div>`
            : '';

        const avatarHtml = isAnon
            ? `<div class="review-card__avatar review-card__avatar--anon" title="Posted anonymously"><i class="ti ti-eye-off" aria-hidden="true"></i></div>`
            : `<div class="review-card__avatar">${escapeHtml(initials)}</div>`;

        // Only the signed-in author's own reviews get this row (is_mine is
        // set by the database, not guessed here).
        const ownHtml = r.is_mine
            ? `
                <div class="review-card__own">
                    <span class="review-card__own-tag"><i class="ti ti-user" aria-hidden="true"></i> Your review${r.is_hidden ? ' &middot; Under review' : (isAnon ? ' &middot; shown as Anonymous' : '')}</span>
                    ${r.is_hidden ? `
                        <div class="review-card__moderation" role="status">
                            <strong>Under review</strong>
                            <span>Your review is temporarily hidden while our team reviews it.</span>
                            <div class="review-card__moderation-reason">
                                <span class="review-card__moderation-reason-label">Reason</span>
                                <p>${escapeHtml(r.moderation_reason || 'Our team is reviewing this review.')}</p>
                            </div>
                        </div>
                    ` : `<button type="button" class="review-card__edit-btn" data-review-id="${escapeHtml(r.review_id)}"><i class="ti ti-pencil" aria-hidden="true"></i> Edit</button>`}
                </div>`
            : '';

        return `
            <article class="${cardClass}">
                <div class="review-card__header">
                    <div class="review-card__user">
                        ${avatarHtml}
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
                ${ownHtml}
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
        loadMoreBtn.innerHTML = `Load More Reviews <i class="ti ti-chevron-down"></i>`;
    }
}

/* ============================================================
   SUMMARY
============================================================ */
function renderSummary() {
    const publicReviews = allReviews.filter(r => !r.is_hidden);
    const total     = publicReviews.length;
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

    const avg = publicReviews.reduce((acc, r) => acc + r.rating, 0) / total;
    avgEl.textContent   = avg.toFixed(1);
    starsEl.textContent = renderStars(Math.round(avg));

    let html = '';
    for (let star = 5; star >= 1; star--) {
        const count = publicReviews.filter(r => r.rating === star).length;
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
            <i class="ti ti-alert-triangle" style="color:#c0392b;"></i>
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
            total_price,
            package:package_id ( package_name )
        `)
        .eq('user_id', userId)
        .order('event_date', { ascending: false });

    if (error) throw error;

    const reservationList = reservations || [];

    // getEffectiveReservationStatus() only infers 'completed' for a
    // past-event reservation when it's told the outstanding balance — pass
    // nothing and it just echoes back whatever status is already persisted
    // on the row (see reservation_shared.js). The account page fetches
    // payments and passes that balance in, so it shows "Completed" (and the
    // "Leave a Review" button) the moment the event has passed and the
    // reservation is paid off. Without doing the same here, this page
    // instead waited for a separate background job to actually write
    // status: 'completed' to the DB before it would let the customer submit
    // a review — visible as a delay between the account page offering
    // "Leave a Review" and the review form actually working.
    const paymentsByReservationId = await fetchSharedPayments(
        supabase,
        reservationList.map((reservation) => reservation.reservation_id)
    );

    const completed = reservationList.filter((reservation) => {
        const { remainingBalance } = getSharedReservationBalanceDetails(reservation, paymentsByReservationId);
        return getEffectiveReservationStatus(reservation, remainingBalance) === 'completed';
    });

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

function getReviewReservationIdFromUrl() {
    try {
        return new URLSearchParams(window.location.search).get('review_reservation_id');
    } catch (err) {
        return null;
    }
}

async function initWriteReview() {
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        currentUser = session.user;
        eligibleReservations = await fetchMyReviewableReservations(currentUser.id);
        updateWriteReviewVisibility();

        const deepLinkedId = getReviewReservationIdFromUrl();
        if (deepLinkedId) {
            const targetReservation = eligibleReservations.find(
                (reservation) => String(reservation.reservation_id) === deepLinkedId
            );

            // Strip the param either way so a refresh or re-visit doesn't reopen the modal.
            const url = new URL(window.location.href);
            url.searchParams.delete('review_reservation_id');
            window.history.replaceState({}, '', url);

            if (targetReservation) {
                openReviewPromptModal(targetReservation);
            }
        }
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
            <i class="ti ti-chevron-right review-picker-item__chevron" aria-hidden="true"></i>
        </button>
    `).join('');
}

function openReviewPickerModal() {
    renderReviewPickerList();
    const backdrop = document.getElementById('review-picker-backdrop');
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
}

function closeReviewPickerModal() {
    const backdrop = document.getElementById('review-picker-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
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

function openReviewPromptModal(reservation) {
    activeReviewReservation = reservation;

    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    setReviewPromptRating(0);

    const commentInput = document.getElementById('review-prompt-comment');
    if (commentInput) commentInput.value = '';

    const anonymousInput = document.getElementById('review-prompt-anonymous');
    if (anonymousInput) anonymousInput.checked = false;

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
    lockBodyScroll();
}

function closeReviewPromptModal() {
    activeReviewReservation = null;
    setReviewPromptBusy(false);
    setReviewPromptMessage('');
    const backdrop = document.getElementById('review-prompt-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
}

function openSubmissionFeedbackModal({
    eyebrow = 'Review Submitted',
    title = 'Thank You for the Feedback',
    copy = 'Your review has been saved to your completed reservation.'
} = {}) {
    const backdrop = document.getElementById('submission-feedback-backdrop');
    document.getElementById('submission-feedback-eyebrow').textContent = eyebrow;
    document.getElementById('submission-feedback-title').textContent = title;
    document.getElementById('submission-feedback-copy').textContent = copy;
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
}

function closeSubmissionFeedbackModal() {
    const backdrop = document.getElementById('submission-feedback-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
}

async function refreshPublicReviews(reason) {
    try {
        const raw = await fetchReviews();
        allReviews = raw.filter((r) => (!r.is_hidden || r.is_mine));
        renderSummary();
        renderReviews();
    } catch (refreshError) {
        console.error(`[reviews] failed to refresh reviews after ${reason}:`, refreshError);
    }
}

/* ============================================================
   EDIT MY REVIEW (anonymity only)
============================================================ */
function setReviewEditMessage(message, type = '') {
    const messageEl = document.getElementById('review-edit-message');
    if (!messageEl) return;
    messageEl.textContent = message;
    messageEl.classList.remove('error', 'success');
    if (type) messageEl.classList.add(type);
}

function setReviewEditBusy(isBusy) {
    ['review-edit-close', 'review-edit-cancel', 'review-edit-save', 'review-edit-anonymous'].forEach((id) => {
        document.getElementById(id)?.toggleAttribute('disabled', isBusy);
    });
}

function openReviewEditModal(review) {
    editingReview = review;

    setReviewEditBusy(false);
    setReviewEditMessage('');

    const toggle = document.getElementById('review-edit-anonymous');
    if (toggle) toggle.checked = !!review.is_anonymous;

    const hasComment = review.comment && review.comment.trim().length > 0;
    const summary = document.getElementById('review-edit-summary');
    if (summary) {
        summary.innerHTML = `
            <div class="review-reservation-title">${escapeHtml(review.packageName || 'Your review')}</div>
            <div class="review-reservation-copy">${renderStars(review.rating)} &bull; ${escapeHtml(formatDate(review.created_at))}</div>
            ${hasComment ? `<div class="review-reservation-copy review-edit-comment">&ldquo;${escapeHtml(review.comment)}&rdquo;</div>` : ''}
        `;
    }

    const backdrop = document.getElementById('review-edit-backdrop');
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
}

function closeReviewEditModal() {
    editingReview = null;
    setReviewEditBusy(false);
    setReviewEditMessage('');
    const backdrop = document.getElementById('review-edit-backdrop');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
}

async function saveReviewEdit() {
    const review = editingReview;
    if (!review) return;

    const makeAnonymous = !!document.getElementById('review-edit-anonymous')?.checked;

    // Nothing changed: no need to call the server.
    if (makeAnonymous === !!review.is_anonymous) {
        closeReviewEditModal();
        return;
    }

    try {
        setReviewEditBusy(true);
        setReviewEditMessage('Saving your changes...');

        const { error } = await supabase.rpc('set_review_anonymity', {
            p_review_id: review.review_id,
            p_is_anonymous: makeAnonymous
        });
        if (error) throw error;

        closeReviewEditModal();

        openSubmissionFeedbackModal({
            eyebrow: 'Review Updated',
            title: makeAnonymous ? 'Your Review Is Now Anonymous' : 'Your Name Is Now Shown',
            copy: makeAnonymous
                ? 'Other guests will now see this review as Anonymous.'
                : 'Your name will now appear next to this review.'
        });

        await refreshPublicReviews('edit');
    } catch (error) {
        setReviewEditBusy(false);
        setReviewEditMessage('Failed to update your review. Please try again.', 'error');
        console.error('[reviews] failed to update review anonymity:', error);
    }
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
        const isAnonymous = !!document.getElementById('review-prompt-anonymous')?.checked;

        const { error } = await supabase
            .from('reviews')
            .insert({
                reservation_id: reservation.reservation_id,
                user_id: currentUser.id,
                rating: reviewPromptRatingValue,
                comment,
                // Only sent when ticked, so a normal (named) review still
                // saves even if the is_anonymous column isn't there yet.
                ...(isAnonymous ? { is_anonymous: true } : {})
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

        openSubmissionFeedbackModal(isAnonymous ? {
            copy: 'Your review has been saved and will appear as Anonymous.'
        } : undefined);

        // Refresh the public list so the new review appears right away.
        await refreshPublicReviews('submit');
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
            openReviewPromptModal(eligibleReservations[0]);
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
        if (reservation) openReviewPromptModal(reservation);
    });

    document.getElementById('review-prompt-close')?.addEventListener('click', closeReviewPromptModal);
    document.getElementById('review-prompt-back')?.addEventListener('click', () => {
        closeReviewPromptModal();
        // Whenever there's more than one reservation still left to review,
        // Back returns to that list — regardless of whether this modal was
        // reached via the picker or a direct "Leave a Review" deep link
        // from My Reservations. With only one eligible reservation, there's
        // nothing to go back to, so Back just closes.
        if (eligibleReservations.length > 1) {
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

    // Edit button on the signed-in customer's own review cards
    document.getElementById('reviewsList')?.addEventListener('click', (event) => {
        const editBtn = event.target.closest('.review-card__edit-btn');
        if (!editBtn) return;
        const review = allReviews.find((entry) => String(entry.review_id) === editBtn.dataset.reviewId);
        if (review && review.is_mine) openReviewEditModal(review);
    });
    document.getElementById('review-edit-close')?.addEventListener('click', closeReviewEditModal);
    document.getElementById('review-edit-cancel')?.addEventListener('click', closeReviewEditModal);
    document.getElementById('review-edit-save')?.addEventListener('click', saveReviewEdit);
    document.getElementById('review-edit-backdrop')?.addEventListener('click', (event) => {
        if (event.target.id === 'review-edit-backdrop') closeReviewEditModal();
    });

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

    document.getElementById('myReviewsBtn')?.addEventListener('click', () => {
        mineOnly     = !mineOnly;
        visibleCount = REVIEWS_PER_PAGE;
        renderReviews();
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

        allReviews = raw.filter(r => (!r.is_hidden || r.is_mine));

        if (loadingEl) loadingEl.remove();

        renderSummary();
        renderReviews();
    } catch (err) {
        if (loadingEl) loadingEl.remove();
        showError('We couldn\'t load reviews right now. Please try again shortly.');
    }

    // Without this, a reservation that becomes reviewable (event passes,
    // gets marked completed) while this tab is already open/backgrounded
    // never shows the "Write a Review" bar until the customer manually
    // reloads the page — the eligibility check above only ever ran once,
    // on the very first load. initAutoRefresh (js/auto_refresh.js, already
    // used by notifications.js and admin_homepage.js for the same reason)
    // re-runs on tab focus, tab becoming visible again, and bfcache restore
    // (the browser back/forward button, which doesn't re-execute module
    // scripts on its own), plus a 60s fallback poll — deliberately a plain
    // interval rather than a realtime subscription, which is what drove
    // this project's Disk IO usage sky-high before (see notifications.js).
    // Re-checks both the write-review eligibility and the public reviews
    // list, so a review someone else just posted also shows up without a
    // manual refresh.
    initAutoRefresh(() => {
        initWriteReview();
        fetchReviews()
            .then((raw) => {
                allReviews = raw.filter((r) => (!r.is_hidden || r.is_mine));
                renderSummary();
                renderReviews();
            })
            .catch((err) => console.error('[reviews] auto-refresh failed:', err));
    });
}

document.addEventListener('DOMContentLoaded', init);
