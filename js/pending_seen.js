// Which pending reservations are NEW to this manager.
//
// The Reservations page opens on "Pending" when something new is waiting for a
// decision, and on "Upcoming" otherwise. "New" means: still pending, submitted
// AFTER this browser first ran the check (an existing backlog of old pending
// reservations never counts), and not opened by this manager yet. Once it is opened (viewed) or
// decided (no longer pending) it stops counting, so the next visit or refresh
// goes back to "Upcoming".
//
// Kept in this browser's localStorage, per signed-in user, so it needs no
// database change. The trade-off: a different browser or device has its own
// list, so a reservation viewed elsewhere still counts as new there once.

const KEY_PREFIX = 'eli-admin-seen-pending:';
const BASELINE_PREFIX = 'eli-admin-pending-baseline:';
const MAX_IDS = 500;

// The moment this browser first ran the check. Reservations created before it
// are the existing backlog, not "newly submitted".
function getBaselineMs(userId) {
  const key = `${BASELINE_PREFIX}${userId || 'anonymous'}`;
  try {
    const stored = Number(localStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const now = Date.now();
    localStorage.setItem(key, String(now));
    return now;
  } catch (error) {
    return Date.now();
  }
}

function keyFor(userId) {
  return `${KEY_PREFIX}${userId || 'anonymous'}`;
}

export function getSeenPendingIds(userId) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(userId)) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []);
  } catch (error) {
    return new Set();
  }
}

function saveSeen(userId, ids) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(Array.from(ids).slice(-MAX_IDS)));
  } catch (error) {
    // Storage blocked or full: the page simply opens on "Upcoming".
  }
}

export function markPendingSeen(userId, reservationId) {
  if (!reservationId) return;
  const ids = getSeenPendingIds(userId);
  if (ids.has(reservationId)) return;
  ids.add(reservationId);
  saveSeen(userId, ids);
}

// pendingRows: [{ reservation_id, created_at }] for every pending reservation.
// True when at least one was submitted after the baseline and not opened yet.
// Also forgets opened ids that are no longer pending so the list cannot grow
// forever.
export function hasUnseenPending(userId, pendingRows) {
  const rows = pendingRows || [];
  const baseline = getBaselineMs(userId);
  const pendingIds = new Set(rows.map((r) => r.reservation_id));
  const seen = getSeenPendingIds(userId);
  const stillRelevant = new Set(Array.from(seen).filter((id) => pendingIds.has(id)));
  if (stillRelevant.size !== seen.size) saveSeen(userId, stillRelevant);
  return rows.some((r) => {
    if (stillRelevant.has(r.reservation_id)) return false;
    const created = Date.parse(r.created_at);
    return Number.isFinite(created) && created > baseline;
  });
}
