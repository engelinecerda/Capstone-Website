// js/admin_nav.js
// Shared admin sidebar: renders the nav list, computes active state,
// handles collapse (persisted) and the mobile drawer. Call
// initAdminNav({ role: profile.role }) once per page, after the page's own
// validateAdminSession() succeeds — role governs whether Configuration/
// System are shown (admin) or hidden (manager sees Operations only).
import { ADMIN_NAV } from './admin_nav_data.js';
import { iconSvg } from './admin_nav_icons.js';

const COLLAPSE_KEY = 'adminSidebarCollapsed';

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function readCollapsedPreference() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedPreference(collapsed) {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore — collapse still works for this page load, just won't persist
  }
}

function resolveActiveHref(items) {
  if (window.__ADMIN_ACTIVE_NAV__) {
    const explicit = items.find((item) => item.label === window.__ADMIN_ACTIVE_NAV__ || item.key === window.__ADMIN_ACTIVE_NAV__);
    if (explicit) return explicit.href;
  }

  const current = window.location.pathname + window.location.hash;
  const currentPath = window.location.pathname;

  // Exact match first (covers the common case, including hash-specific
  // Configuration items that share a physical page).
  const exact = items.find((item) => {
    const itemUrl = new URL(item.href, window.location.origin);
    return decodeURIComponent(itemUrl.pathname) === decodeURIComponent(currentPath) &&
      (itemUrl.hash === '' || itemUrl.hash === window.location.hash);
  });
  if (exact) return exact.href;

  // Prefix match for any future nested route (e.g. a sub-page under
  // Bookable inventory) — not exercised by today's flat file layout, but
  // keeps this working once such pages exist.
  const prefixed = items.find((item) => {
    const itemUrl = new URL(item.href, window.location.origin);
    if (!itemUrl.hash && itemUrl.pathname !== '/admin/dashboard.html') {
      return decodeURIComponent(currentPath).startsWith(decodeURIComponent(itemUrl.pathname).replace(/\.html$/, '/'));
    }
    return false;
  });
  if (prefixed) return prefixed.href;

  return current;
}

function renderNav(container, activeHref, role) {
  // Configuration and System are admin-exclusive (every page behind them
  // guards with an admin-only redirect) — Manager only ever sees Operations,
  // matching the separation-of-duties model already established elsewhere
  // in this admin portal.
  const visibleGroups = role === 'admin' ? ADMIN_NAV : ADMIN_NAV.filter((g) => g.section === 'Operations');

  const groups = visibleGroups.map(({ section, items }) => {
    const rows = items.map((rawItem) => {
      const item = role === 'admin' && rawItem.adminOverride ? { ...rawItem, ...rawItem.adminOverride } : rawItem;
      const isActive = item.href === activeHref;
      return `
        <li>
          <a href="${item.href}"
             class="nav-item${isActive ? ' active' : ''}"
             ${isActive ? 'aria-current="page"' : ''}
             data-tooltip="${item.label}"
             aria-label="${item.label}">
            <span class="nav-icon">${iconSvg(item.iconKey)}</span>
            <span class="nav-label">${item.label}</span>
          </a>
        </li>`;
    }).join('');

    return `
      <div class="sidebar-nav-group">
        <p class="sidebar-section-label">${section}</p>
        <ul class="sidebar-nav-list">${rows}</ul>
      </div>`;
  }).join('');

  container.innerHTML = groups;
}

function wireCollapse(sidebar) {
  const brand = sidebar.querySelector('.sidebar-brand');
  if (!brand || document.getElementById('sidebarCollapseBtn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'sidebarCollapseBtn';
  btn.className = 'sidebar-collapse-btn';
  btn.setAttribute('aria-label', 'Collapse sidebar');
  btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';

  brand.appendChild(btn);

  function applyCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.setAttribute('aria-expanded', String(!collapsed));
  }

  const collapsed = readCollapsedPreference();
  if (prefersReducedMotion()) sidebar.classList.add('no-motion');
  applyCollapsed(collapsed);

  btn.addEventListener('click', () => {
    const next = !sidebar.classList.contains('collapsed');
    applyCollapsed(next);
    writeCollapsedPreference(next);
  });
}

// Reuses the exact DOM contract already established by
// js/admin_sidebar_counts.js's injectSidebarHamburger (#sidebarHamburger,
// #sidebarOverlay, body.sidebar-open) so the existing drawer CSS in
// css/admin_sidebar.css keeps working unchanged. That function guards on
// this same id, so if it also runs on a given page it becomes a no-op.
function wireDrawer(container) {
  if (!document.getElementById('sidebarHamburger')) {
    const hamburger = document.createElement('button');
    hamburger.id = 'sidebarHamburger';
    hamburger.className = 'sidebar-hamburger';
    hamburger.setAttribute('aria-label', 'Open menu');
    hamburger.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

    const overlay = document.createElement('div');
    overlay.id = 'sidebarOverlay';
    overlay.className = 'sidebar-overlay';

    document.body.prepend(overlay);
    document.body.prepend(hamburger);

    hamburger.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
    overlay.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
  }

  container.querySelectorAll('.nav-item').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
    });
  });
}

export function initAdminNav({ role } = {}) {
  const container = document.getElementById('adminNav');
  const sidebar = document.querySelector('.sidebar');
  if (!container || !sidebar) return;

  const allItems = ADMIN_NAV.flatMap((g) => g.items);
  const activeHref = resolveActiveHref(allItems);

  renderNav(container, activeHref, role);
  wireCollapse(sidebar);
  wireDrawer(container);
}
