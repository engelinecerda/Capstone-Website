import { runWhenIdle } from './idle_task.js';

function isMissingContractColumn(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column reservation_contracts.${columnName} does not exist`);
}

function isMissingProfileColumn(error, columnName) {
  const message = error?.message || '';
  return message.includes(`Could not find the '${columnName}' column`)
    || message.includes(`column profiles.${columnName} does not exist`);
}

export function setBadgeCount(element, count) {
  if (!element) return;
  const normalizedCount = Math.max(Number(count) || 0, 0);
  element.textContent = String(normalizedCount);
  element.hidden = normalizedCount === 0;
}

async function fetchPendingReservationCount(supabase) {
  const { count, error } = await supabase
    .from('reservations')
    .select('reservation_id', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (error) throw error;
  return count || 0;
}

async function fetchPendingPaymentCount(supabase) {
  const { count, error } = await supabase
    .from('payment')
    .select('payment_id', { count: 'exact', head: true })
    .eq('payment_status', 'pending_review');

  if (error) throw error;
  return count || 0;
}

function countPendingContractReviews(contracts) {
  return (contracts || []).reduce((total, contract) => {
    if (!contract?.contract_url) return total;

    const reviewStatus = String(contract.review_status || '').toLowerCase();
    if (reviewStatus === 'verified' || contract.verified_date) return total;

    if (reviewStatus === 'pending_review' || !reviewStatus) {
      return total + 1;
    }

    return total;
  }, 0);
}

async function fetchPendingContractCount(supabase) {
  const extendedSelect = 'reservation_id, contract_url, verified_date, review_status';
  const fallbackSelect = 'reservation_id, contract_url, verified_date';

  const { data, error } = await supabase
    .from('reservation_contracts')
    .select(extendedSelect);

  if (!error) {
    return countPendingContractReviews(data);
  }

  if (isMissingContractColumn(error, 'review_status')) {
    const fallback = await supabase
      .from('reservation_contracts')
      .select(fallbackSelect);

    if (fallback.error) throw fallback.error;
    return countPendingContractReviews(fallback.data);
  }

  throw error;
}

async function fetchUnreadReviewCount(supabase) {
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;

    const session = sessionData?.session;
    const userId = session?.user?.id;
    if (!userId) return 0;

    const profileResponse = await supabase
      .from('profiles')
      .select('reviews_last_seen_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (profileResponse.error) {
      if (isMissingProfileColumn(profileResponse.error, 'reviews_last_seen_at')) {
        return 0;
      }
      throw profileResponse.error;
    }

    const lastSeenAt = profileResponse.data?.reviews_last_seen_at || null;

    let query = supabase
      .from('reviews')
      .select('review_id', { count: 'exact', head: true });

    if (lastSeenAt) {
      query = query.gt('created_at', lastSeenAt);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  } catch (error) {
    return 0;
  }
}

export async function markAdminReviewsSeen({ supabase, userId, seenAt = new Date().toISOString() }) {
  if (!userId) return null;

  const response = await supabase
    .from('profiles')
    .update({ reviews_last_seen_at: seenAt })
    .eq('user_id', userId)
    .select('reviews_last_seen_at')
    .maybeSingle();

  if (response.error) {
    if (isMissingProfileColumn(response.error, 'reviews_last_seen_at')) {
      return null;
    }
    throw response.error;
  }

  // The unread-review count just changed on purpose; do not serve the old one.
  clearNavCountsCache();
  return response.data?.reviews_last_seen_at || seenAt;
}

// ── Short-lived cache ───────────────────────────────────────────────────────
// Admins click through pages quickly, and every page load used to recount the
// same badges. The counts are kept for NAV_COUNTS_TTL_MS in sessionStorage and
// reused on page loads and tab refocus. Anything that changes a count on
// purpose (approving a payment, marking reviews seen, a page's own refresh)
// calls refreshAdminSidebarCounts() without `useCache`, which always fetches
// fresh numbers.
const NAV_COUNTS_CACHE_KEY = 'eliAdminNavCounts';
const NAV_COUNTS_TTL_MS = 45 * 1000;

function readNavCountsCache(userId) {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(NAV_COUNTS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || cached.userId !== userId) return null;
    const age = Date.now() - Number(cached.at);
    if (!(age >= 0 && age < NAV_COUNTS_TTL_MS)) return null;
    return cached.counts || null;
  } catch (error) {
    return null;
  }
}

function writeNavCountsCache(userId, counts) {
  if (!userId) return;
  try {
    sessionStorage.setItem(NAV_COUNTS_CACHE_KEY, JSON.stringify({ userId, at: Date.now(), counts }));
  } catch (error) {
    // Storage unavailable (private mode, quota): just skip caching.
  }
}

function clearNavCountsCache() {
  try {
    sessionStorage.removeItem(NAV_COUNTS_CACHE_KEY);
  } catch (error) {
    // nothing to clear
  }
}

async function getCurrentUserId(supabase) {
  try {
    const { data } = await supabase.auth.getSession(); // reads the local session, no request
    return data?.session?.user?.id || null;
  } catch (error) {
    return null;
  }
}

// ── One request for all sidebar numbers ─────────────────────────────────────
// get_admin_nav_counts() (supabase/migrations/20261029_admin_nav_counts_rpc.sql)
// returns every badge count plus the maintenance flag in a single call.
function isMissingFunctionError(error) {
  const message = error?.message || '';
  return error?.code === 'PGRST202' || message.includes('Could not find the function');
}

async function fetchNavCountsViaRpc(supabase) {
  const { data, error } = await supabase.rpc('get_admin_nav_counts');

  if (error) {
    // Migration not applied yet: let the caller use the separate queries instead.
    if (isMissingFunctionError(error)) return null;
    throw error;
  }

  return {
    reservationCount: Number(data?.pending_reservations) || 0,
    paymentCount: Number(data?.pending_payments) || 0,
    contractCount: Number(data?.pending_contracts) || 0,
    reviewCount: Number(data?.unread_reviews) || 0,
    maintenanceOn: Boolean(data?.maintenance_on)
  };
}

async function fetchMaintenanceOn(supabase) {
  try {
    const { data, error } = await supabase.from('maintenance_mode').select('is_on').eq('id', true).maybeSingle();
    return !error && Boolean(data?.is_on);
  } catch (error) {
    return false;
  }
}

// Fallback used only while the RPC does not exist yet (the separate queries
// this file originally ran on every page).
async function fetchNavCountsLegacy(supabase) {
  const [
    reservationCount,
    paymentCount,
    contractCount,
    reviewCount,
    maintenanceOn
  ] = await Promise.all([
    fetchPendingReservationCount(supabase),
    fetchPendingPaymentCount(supabase),
    fetchPendingContractCount(supabase),
    fetchUnreadReviewCount(supabase),
    fetchMaintenanceOn(supabase)
  ]);

  return { reservationCount, paymentCount, contractCount, reviewCount, maintenanceOn };
}

function paintBadges(counts, { reservationBadgeEl, paymentBadgeEl, contractBadgeEl, reviewBadgeEl }) {
  setBadgeCount(reservationBadgeEl, counts.reservationCount);
  setBadgeCount(paymentBadgeEl, counts.paymentCount);
  setBadgeCount(contractBadgeEl, counts.contractCount);
  setBadgeCount(reviewBadgeEl, counts.reviewCount);
}

export async function refreshAdminSidebarCounts({
  supabase,
  reservationBadgeEl,
  paymentBadgeEl,
  contractBadgeEl,
  reviewBadgeEl,
  useCache = false
}) {
  const userId = await getCurrentUserId(supabase);
  let counts = useCache ? readNavCountsCache(userId) : null;

  if (!counts) {
    counts = (await fetchNavCountsViaRpc(supabase)) || (await fetchNavCountsLegacy(supabase));
    writeNavCountsCache(userId, counts);
  }

  paintBadges(counts, { reservationBadgeEl, paymentBadgeEl, contractBadgeEl, reviewBadgeEl });
  return counts;
}

// Paints from a still-fresh cached copy without any request. Returns the counts
// when it did, or null when there was nothing fresh to show.
async function applyCachedNavCounts(supabase, badgeEls) {
  const userId = await getCurrentUserId(supabase);
  const counts = readNavCountsCache(userId);
  if (!counts) return null;
  paintBadges(counts, badgeEls);
  return counts;
}

/**
 * Auto-wire sidebar badges for an admin page.
 * Looks up the standard badge elements by ID and fills them in: instantly from
 * a recent cached copy when there is one, otherwise with a single request made
 * after the page has finished loading. Refreshes again (from cache if still
 * fresh) whenever the tab regains focus.
 *
 * Returns a function you can call manually to force a fresh recount.
 */
export function initAdminSidebarBadges(supabase) {
  const badgeEls = {
    reservationBadgeEl: document.getElementById('navReservationCount'),
    paymentBadgeEl: document.getElementById('navPaymentCount'),
    contractBadgeEl: document.getElementById('navContractCount'),
    reviewBadgeEl: document.getElementById('navReviewCount')
  };

  async function refresh({ useCache = false } = {}) {
    try {
      const counts = await refreshAdminSidebarCounts({ supabase, ...badgeEls, useCache });
      if (counts.maintenanceOn) showMaintenanceStrip();
    } catch (error) {
      // Badge counts are decorative — a failed refresh just leaves the last
      // known counts on screen, nothing for the admin to act on.
    }
  }

  // Initial load
  applyCachedNavCounts(supabase, badgeEls)
    .then((cached) => {
      if (cached) {
        if (cached.maintenanceOn) showMaintenanceStrip();
      } else {
        runWhenIdle(() => refresh());
      }
    })
    .catch(() => runWhenIdle(() => refresh()));

  // Refresh when tab regains focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh({ useCache: true });
  });

  injectSidebarHamburger();

  // The returned function is the "something just changed, recount now" hook,
  // so it always fetches fresh numbers.
  return () => refresh();
}

// Persistent, app-wide "the customer site is currently offline" strip —
// shown on every admin page that calls initAdminSidebarBadges, so an admin can
// never forget maintenance mode is on just because they navigated away from its
// own settings page. Read-only indicator; the actual toggle lives at
// /admin/maintenance/mode.html. The on/off flag now arrives with the sidebar
// counts (same single request) instead of a separate query.
function showMaintenanceStrip() {
  if (document.getElementById('adminMaintenanceStrip')) return;

  const strip = document.createElement('a');
  strip.id = 'adminMaintenanceStrip';
  strip.className = 'admin-maintenance-strip';
  strip.href = '/admin/maintenance/mode';
  strip.innerHTML = `
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <span>Maintenance mode is ON — the customer site is offline. Click to manage.</span>
  `;
  document.body.prepend(strip);
}

function injectSidebarHamburger() {
  if (document.getElementById('sidebarHamburger')) return;

  const btn = document.createElement('button');
  btn.id = 'sidebarHamburger';
  btn.className = 'sidebar-hamburger';
  btn.setAttribute('aria-label', 'Open menu');
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
    <line x1="3" y1="6" x2="21" y2="6"/>
    <line x1="3" y1="12" x2="21" y2="12"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
  </svg>`;

  const overlay = document.createElement('div');
  overlay.id = 'sidebarOverlay';
  overlay.className = 'sidebar-overlay';

  document.body.prepend(overlay);
  document.body.prepend(btn);

  btn.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });

  overlay.addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
  });

  // Close sidebar when a nav link is tapped on mobile
  document.querySelectorAll('.sidebar .nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        document.body.classList.remove('sidebar-open');
      }
    });
  });
}