import { initAdminNotificationBell } from './notifications.js';

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
    if (reviewStatus === 'resubmission_requested') return total;

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

  return response.data?.reviews_last_seen_at || seenAt;
}

export async function refreshAdminSidebarCounts({
  supabase,
  reservationBadgeEl,
  paymentBadgeEl,
  contractBadgeEl,
  reviewBadgeEl
}) {
  const [
    reservationCount,
    paymentCount,
    contractCount,
    reviewCount
  ] = await Promise.all([
    fetchPendingReservationCount(supabase),
    fetchPendingPaymentCount(supabase),
    fetchPendingContractCount(supabase),
    fetchUnreadReviewCount(supabase)
  ]);

  setBadgeCount(reservationBadgeEl, reservationCount);
  setBadgeCount(paymentBadgeEl, paymentCount);
  setBadgeCount(contractBadgeEl, contractCount);
  setBadgeCount(reviewBadgeEl, reviewCount);

  return {
    reservationCount,
    paymentCount,
    contractCount,
    reviewCount
  };
}
/**
 * Auto-wire sidebar badges for an admin page.
 * Looks up the standard badge elements by ID, refreshes counts immediately,
 * and refreshes again whenever the tab regains focus.
 *
 * Returns a function you can call manually to force a refresh.
 */
export function initAdminSidebarBadges(supabase) {
  const badgeEls = {
    reservationBadgeEl: document.getElementById('navReservationCount'),
    paymentBadgeEl: document.getElementById('navPaymentCount'),
    contractBadgeEl: document.getElementById('navContractCount'),
    reviewBadgeEl: document.getElementById('navReviewCount')
  };

  async function refresh() {
    try {
      await refreshAdminSidebarCounts({ supabase, ...badgeEls });
    } catch (error) {
      // Badge counts are decorative — a failed refresh just leaves the last
      // known counts on screen, nothing for the admin to act on.
    }
  }

  // Initial load
  refresh();

  // Refresh when tab regains focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  // Notification bell — runs alongside sidebar badge counts
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.user) {
      initAdminNotificationBell(supabase, session.user.id);
    }
  });

  injectSidebarHamburger();
  injectMaintenanceIndicator(supabase);

  return refresh;
}

// Persistent, app-wide "the customer site is currently offline" strip —
// runs on every admin page via initAdminSidebarBadges, so an admin can never
// forget maintenance mode is on just because they navigated away from its
// own settings page. Read-only indicator; the actual toggle lives at
// /admin/maintenance/mode.html.
async function injectMaintenanceIndicator(supabase) {
  if (document.getElementById('adminMaintenanceStrip')) return;

  try {
    const { data, error } = await supabase.from('maintenance_mode').select('is_on').eq('id', true).maybeSingle();
    if (error || !data?.is_on) return;

    const strip = document.createElement('a');
    strip.id = 'adminMaintenanceStrip';
    strip.className = 'admin-maintenance-strip';
    strip.href = '/admin/maintenance/mode.html';
    strip.innerHTML = `
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span>Maintenance mode is ON — the customer site is offline. Click to manage.</span>
    `;
    document.body.prepend(strip);
  } catch (err) {
    // If this check fails, the strip just doesn't show — safe default.
  }
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