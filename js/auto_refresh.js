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
  setInterval(triggerAutoRefresh, pollMs);

  return triggerAutoRefresh;
}