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
  element.hidden = normalizedCount <= 0;
  element.setAttribute('aria-hidden', String(normalizedCount <= 0));
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
    console.warn('Unable to refresh unread review badge count:', error?.message || error);
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
      console.error('Failed to refresh sidebar badge counts:', error);
    }
  }

  // Initial load
  refresh();

  // Refresh when tab regains focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  return refresh;
}