// auto_refresh.js — keeps an open page's data current.
//
// A page calls initAutoRefresh(refreshFn, options) once. refreshFn is then
// re-run:
//   - when the tab becomes visible again, the window regains focus, or the page
//     is restored from the back-forward cache (always, so a visitor who switches
//     back never waits long to see current data);
//   - on a slow timer while the tab is visible (pollMs, default 2 minutes; pass
//     pollMs: 0 for no timer at all, focus/visibility refreshes only).
//
// While the "service issue" notice is showing (js/supabase_health_notice.js sets
// window.__eliSupabaseDown), every automatic refresh is skipped so open tabs do
// not pile failing requests onto a struggling server. Pages keep showing the
// data they already have. When Supabase answers again, each page refreshes once
// to catch up. A refresh the visitor asks for with the Refresh button still runs.
//
// The function initAutoRefresh returns still works exactly as before (call it to
// request a debounced refresh). It also carries:
//   .refresh()            run a refresh now, ignoring the debounce (the Refresh button)
//   .getLastUpdated()     Date of the last refresh that finished OK, or null
//   .isRefreshing()       true while a refresh is running
//   .subscribe(fn)        fn({ lastUpdated, refreshing, paused }) on every change;
//                         returns an unsubscribe function
//
// A refreshFn counts as FAILED when it throws or returns false; anything else
// is a success. (Silent loaders that swallow their own errors should return
// false from the catch so the "Updated" time is not advanced.)
const AUTO_REFRESH_DEBOUNCE_MS = 3000;
export const AUTO_REFRESH_POLL_MS = 60000; 

function supabaseIsDown() {
  return window.__eliSupabaseDown === true;
}

export function initAutoRefresh(refreshFn, options = {}) {
  const debounceMs = options.debounceMs ?? AUTO_REFRESH_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? AUTO_REFRESH_POLL_MS;

  let lastAutoRefreshAt = 0;
  let lastUpdated = null;
  let refreshing = false;
  let catchUpPending = false; // an automatic refresh was skipped during an outage
  const listeners = new Set();

  function snapshot() {
    return { lastUpdated, refreshing, paused: supabaseIsDown() };
  }

  function notify() {
    const state = snapshot();
    listeners.forEach((fn) => {
      try { fn(state); } catch (err) { /* a listener must never break refreshing */ }
    });
  }

  async function run() {
    refreshing = true;
    notify();
    try {
      const result = await refreshFn();
      if (result !== false) lastUpdated = new Date();
    } catch (err) {
      console.warn('Auto-refresh failed:', err?.message || err);
    } finally {
      refreshing = false;
      notify();
    }
  }

  function triggerAutoRefresh() {
    // During an outage: remember that we owe one catch-up refresh and do nothing.
    if (supabaseIsDown()) {
      catchUpPending = true;
      return;
    }
    const now = Date.now();
    if (now - lastAutoRefreshAt < debounceMs) return;
    lastAutoRefreshAt = now;
    run();
  }

  // The Refresh button: runs now, ignores the debounce and the outage pause.
  function refreshNow() {
    if (refreshing) return;
    lastAutoRefreshAt = Date.now();
    catchUpPending = false;
    run();
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
  if (pollMs > 0) {
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      triggerAutoRefresh();
    }, pollMs);
  }

  // Outage began / ended: update anything showing the paused state, and on
  // recovery refresh once (only if a refresh was actually skipped, and only
  // if the tab is being looked at — otherwise the visibility refresh covers it).
  window.addEventListener('eli:supabase-down', notify);
  window.addEventListener('eli:supabase-up', () => {
    notify();
    if (!catchUpPending) return;
    catchUpPending = false;
    if (document.visibilityState === 'visible') {
      lastAutoRefreshAt = 0; // the debounce must not swallow the catch-up
      triggerAutoRefresh();
    } else {
      // Hidden tab: the next time it is shown, the visibility handler refreshes.
      lastAutoRefreshAt = 0;
    }
  });

  triggerAutoRefresh.refresh = refreshNow;
  triggerAutoRefresh.getLastUpdated = () => lastUpdated;
  triggerAutoRefresh.isRefreshing = () => refreshing;
  triggerAutoRefresh.subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return triggerAutoRefresh;
}
