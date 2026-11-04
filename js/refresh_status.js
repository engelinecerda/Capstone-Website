// refresh_status.js — a small "Refresh" button with an "Updated 2:41 PM" label
// for the admin queue pages (Reservations, Contracts, Payments, Customers,
// Reviews). It sits under the page subtitle and is driven by the object that
// initAutoRefresh() returns, so it shows the real time of the last refresh
// (timed, on tab return, or from this button) and a paused note while the
// "service issue" notice is showing. Styles: .refresh-status in admin_sidebar.css.
//
// Usage (after initAutoRefresh):
//   const auto = initAutoRefresh(() => loadData({ silent: true }));
//   mountRefreshStatus(auto);

const ICON =
  '<svg class="refresh-status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function mountRefreshStatus(auto, { host } = {}) {
  if (!auto || typeof auto.refresh !== 'function') return null;
  const header = host || document.querySelector('.page-header > div:first-child');
  if (!header || header.querySelector('.refresh-status')) return null;

  const wrap = document.createElement('div');
  wrap.className = 'refresh-status';
  wrap.innerHTML =
    '<button type="button" class="refresh-status-btn" aria-label="Refresh this page\'s data">' +
      ICON + '</button>' +
    '<span class="refresh-status-label" role="status" aria-live="polite"></span>';
  header.appendChild(wrap);

  const btn = wrap.querySelector('.refresh-status-btn');
  const label = wrap.querySelector('.refresh-status-label');
  const openedAt = new Date(); // the page's own first load counts as the first update

  function render({ lastUpdated, refreshing, paused } = {}) {
    const shown = lastUpdated || openedAt;
    wrap.classList.toggle('is-refreshing', !!refreshing);
    btn.disabled = !!refreshing;
    if (refreshing) {
      label.textContent = 'Refreshing…';
    } else if (paused) {
      label.textContent = `Updated ${formatTime(shown)} · Auto-refresh paused (service issue)`;
    } else {
      label.textContent = `Updated ${formatTime(shown)}`;
    }
  }

  btn.addEventListener('click', () => auto.refresh());
  auto.subscribe(render);
  render({ lastUpdated: auto.getLastUpdated(), refreshing: auto.isRefreshing(), paused: window.__eliSupabaseDown === true });
  return wrap;
}
