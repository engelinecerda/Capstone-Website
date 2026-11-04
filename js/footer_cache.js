// footer_cache.js — the storage key and reset for the footer's cached data
// (see js/footer_content.js for how the cache works). Kept in its own tiny
// module so admin pages can clear it without importing footer_content.js,
// which wires a footer as soon as it loads.
export const FOOTER_CACHE_KEY = 'eli-footer-cache-v1';

export function clearFooterCache() {
  try { localStorage.removeItem(FOOTER_CACHE_KEY); } catch (err) { /* unavailable */ }
}

// For admin pages that edit footer content (Business Profile, Page Content >
// Services): drop the cached copy whenever the admin leaves or hides the page,
// so their own next visit to the public site shows what they just saved.
// Other visitors catch up within the cache lifetime (5 minutes).
export function clearFooterCacheWhenLeaving() {
  window.addEventListener('pagehide', clearFooterCache);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearFooterCache();
  });
}
