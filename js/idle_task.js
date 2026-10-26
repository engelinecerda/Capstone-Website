// Runs a non-critical task after the page has finished loading and the browser
// is idle, so decorative requests (sidebar badges, the notification bell) do
// not land in the same instant as the page's own data requests. Admin pages
// used to fire all of them at once on every navigation.
//
// minDelayMs : wait at least this long after the page's load event
// timeoutMs  : but never wait longer than this once idle time is requested
export function runWhenIdle(task, { minDelayMs = 600, timeoutMs = 3000 } = {}) {
  const start = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    } else {
      setTimeout(task, 0);
    }
  };

  if (document.readyState === 'complete') {
    setTimeout(start, minDelayMs);
  } else {
    window.addEventListener('load', () => setTimeout(start, minDelayMs), { once: true });
  }
}