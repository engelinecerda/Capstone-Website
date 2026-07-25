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

// Flattens groups into their leaf links — an item with `children` is never
// itself a link, only its children are, so matching/highlighting always
// operates on this flat leaf list.
function flattenLeaves(items) {
  return items.flatMap((item) => (item.children ? item.children : [item]));
}

function resolveActiveHref(leaves) {
  if (window.__ADMIN_ACTIVE_NAV__) {
    const explicit = leaves.find((item) => item.label === window.__ADMIN_ACTIVE_NAV__ || item.key === window.__ADMIN_ACTIVE_NAV__);
    if (explicit) return explicit.href;
  }

  const current = window.location.pathname + window.location.search + window.location.hash;
  const currentPath = window.location.pathname;

  // Exact match first (covers the common case, including hash- and
  // query-specific items — e.g. Configuration entries and the Venues deep
  // link — that share a physical page with other entries).
  const exact = leaves.find((item) => {
    const itemUrl = new URL(item.href, window.location.origin);
    return decodeURIComponent(itemUrl.pathname) === decodeURIComponent(currentPath) &&
      itemUrl.search === window.location.search &&
      (itemUrl.hash === '' || itemUrl.hash === window.location.hash);
  });
  if (exact) return exact.href;

  // Prefix match for any future nested route (e.g. a sub-page under
  // Bookable inventory) — not exercised by today's flat file layout, but
  // keeps this working once such pages exist.
  const prefixed = leaves.find((item) => {
    const itemUrl = new URL(item.href, window.location.origin);
    if (!itemUrl.hash && itemUrl.pathname !== '/admin/dashboard.html') {
      return decodeURIComponent(currentPath).startsWith(decodeURIComponent(itemUrl.pathname).replace(/\.html$/, '/'));
    }
    return false;
  });
  if (prefixed) return prefixed.href;

  return current;
}

let groupSeq = 0;

// `isChild` distinguishes a group's sub-item from a top-level link — a
// sub-item still carries aria-current="page" when active, so assistive tech
// lands on the exact active page, but its visual active styling is a thin
// left rail (`.active-child`, see admin_sidebar.css), not the filled
// `.active` pill flat items use — group toggles never show that pill at
// all (see buildGroup), so this is the only active indicator inside a group.
function buildLink(item, activeHref, isChild = false) {
  const isActive = item.href === activeHref;
  const activeClass = isActive ? (isChild ? ' active-child' : ' active') : '';
  // Child links under a group carry no iconKey — skip the icon slot
  // entirely rather than rendering it empty, so indentation reads clean
  // (an empty 16px+gap icon slot would read as a second, redundant indent).
  const iconHtml = item.iconKey ? `<span class="nav-icon">${iconSvg(item.iconKey)}</span>` : '';
  return `
    <li>
      <a href="${item.href}"
         class="nav-item${activeClass}"
         ${isActive ? 'aria-current="page"' : ''}
         data-tooltip="${item.label}"
         aria-label="${item.label}">
        ${iconHtml}
        <span class="nav-label">${item.label}</span>
      </a>
    </li>`;
}

// Renders an expandable group: a disclosure button (WAI-ARIA disclosure
// pattern — aria-expanded + aria-controls, no menubar/arrow-key semantics
// needed for a sidebar) followed by its children as plain nav links.
//
// The toggle button never carries the filled `.active` pill flat items get
// (Dashboard, Reports, etc.) — a group row must look structurally identical
// to a flat row, distinguished only by its trailing chevron. When a child is
// the active page, the group still auto-expands (aria-expanded) and that
// child shows its own thin-rail `.active-child` highlight (see buildLink) —
// the toggle itself just stays a plain row regardless. aria-current is
// deliberately omitted here for the same reason: the child link already
// carries aria-current="page", and this button doesn't visually represent
// "current" so it shouldn't claim it for assistive tech either.
// None of today's groups have a page of their own, so the whole button is
// the toggle target; if a future group needs its own landing page, this
// button would need to split into a link + a separate chevron toggle.
function buildGroup(item, activeHref) {
  const submenuId = `navGroup${groupSeq++}`;
  const hasActiveChild = item.children.some((child) => child.href === activeHref);
  const childRows = item.children.map((child) => buildLink(child, activeHref, true)).join('');

  return `
    <li class="nav-group${hasActiveChild ? ' has-active' : ''}">
      <button type="button"
              class="nav-item nav-group-toggle"
              aria-expanded="${hasActiveChild ? 'true' : 'false'}"
              aria-controls="${submenuId}"
              data-tooltip="${item.label}">
        <span class="nav-icon">${item.iconKey ? iconSvg(item.iconKey) : ''}</span>
        <span class="nav-label">${item.label}</span>
        <span class="nav-group-chevron" aria-hidden="true">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
      <ul class="sidebar-nav-list nav-group-children" id="${submenuId}" aria-label="${item.label}" ${hasActiveChild ? '' : 'hidden'}>
        ${childRows}
      </ul>
    </li>`;
}

function renderNav(container, activeHref, role) {
  // Configuration and System are admin-exclusive (every page behind them
  // guards with an admin-only redirect) — Manager only ever sees Operations,
  // matching the separation-of-duties model already established elsewhere
  // in this admin portal.
  const visibleGroups = role === 'admin' ? ADMIN_NAV : ADMIN_NAV.filter((g) => g.section === 'Operations');
  groupSeq = 0;

  const groups = visibleGroups.map(({ section, items }) => {
    const rows = items.map((rawItem) => {
      const item = role === 'admin' && rawItem.adminOverride ? { ...rawItem, ...rawItem.adminOverride } : rawItem;
      return item.children ? buildGroup(item, activeHref) : buildLink(item, activeHref);
    }).join('');

    return `
      <div class="sidebar-nav-group">
        <p class="sidebar-section-label">${section}</p>
        <ul class="sidebar-nav-list">${rows}</ul>
      </div>`;
  }).join('');

  container.innerHTML = groups;

  container.querySelectorAll('.nav-group-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const submenu = document.getElementById(btn.getAttribute('aria-controls'));
      if (!submenu) return;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      submenu.hidden = expanded;
    });
  });
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

  // Excludes .nav-group-toggle — expanding a group doesn't navigate
  // anywhere, so it shouldn't close the mobile drawer.
  container.querySelectorAll('.nav-item:not(.nav-group-toggle)').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) document.body.classList.remove('sidebar-open');
    });
  });
}

export function initAdminNav({ role } = {}) {
  const container = document.getElementById('adminNav');
  const sidebar = document.querySelector('.sidebar');
  if (!container || !sidebar) return;

  const allLeaves = flattenLeaves(ADMIN_NAV.flatMap((g) => g.items));
  const activeHref = resolveActiveHref(allLeaves);

  renderNav(container, activeHref, role);
  wireCollapse(sidebar);
  wireDrawer(container);
}
