const AUTO_REFRESH_DEBOUNCE_MS = 3000;
const AUTO_REFRESH_POLL_MS = 60000;

export function initAutoRefresh(refreshFn, options = {}) {
  const debounceMs = options.debounceMs ?? AUTO_REFRESH_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? AUTO_REFRESH_POLL_MS;

  let lastAutoRefreshAt = 0;

  function triggerAutoRefresh() {
    const now = Date.now();
    if (now - lastAutoRefreshAt < debounceMs) return;
    lastAutoRefreshAt = now;
    refreshFn();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') triggerAutoRefresh();
  });
  window.addEventListener('focus', triggerAutoRefresh);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) triggerAutoRefresh();
  });
  // Skip the tick entirely while the tab is hidden/backgrounded — a tab an
  // admin or customer left open in another window was still firing a full
  // refresh query every pollMs indefinitely, with nobody there to see it.
  // The visibilitychange listener above already catches the tab back up
  // the moment it's actually looked at again, so nothing is missed.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    triggerAutoRefresh();
  }, pollMs);

  return triggerAutoRefresh;
}