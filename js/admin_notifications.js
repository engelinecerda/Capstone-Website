import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const result = await validateAdminSession({ fallbackLabel: 'Notifications' });
if (!result) throw new Error('No session');

const { session, profile } = result;
const userId = session.user.id;

watchAuthState();
wireLogoutButton();
setupInactivityLogout(profile.role);
initAdminSidebarBadges(supabase);
initAdminNav({ role: profile.role });

// ── DOM refs ──────────────────────────────────────────────────────────────────
const listEl     = document.getElementById('notifPageList');
const markAllBtn = document.getElementById('markAllPageBtn');
const badgeEl    = document.getElementById('navNotifCount');
const filterBtns = document.querySelectorAll('.notif-filter-btn');

let allNotifs  = [];
let activeFilter = 'all';

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function notifTypeIcon(type) {
  const icons = {
    reservation: {
      bg: '#eff6ff', color: '#2563eb',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    },
    contract: {
      bg: '#f5f3ff', color: '#7c3aed',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    },
    payment: {
      bg: '#ecfdf5', color: '#059669',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    },
    review: {
      bg: '#fffbeb', color: '#d97706',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
    },
    account: {
      bg: '#f0f9ff', color: '#0284c7',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>`,
    },
    system: {
      bg: '#f9fafb', color: '#6b7280',
      svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    },
  };
  const cfg = icons[(type || '').toLowerCase()] || {
    bg: '#fdf6ee', color: '#7c5c3a',
    svg: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  };
  return `<span class="notif-type-icon" style="background:${cfg.bg};color:${cfg.color}">${cfg.svg}</span>`;
}

function groupByDate(notifs) {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(todayStart.getDate() - 1);
  const groups = [
    { label: 'Today',     items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Earlier',   items: [] },
  ];
  notifs.forEach(n => {
    const d = new Date(n.created_at); d.setHours(0, 0, 0, 0);
    if (d >= todayStart)     groups[0].items.push(n);
    else if (d >= yesterdayStart) groups[1].items.push(n);
    else                     groups[2].items.push(n);
  });
  return groups.filter(g => g.items.length > 0);
}

function renderPageItem(n) {
  return `
    <div class="notif-page-item ${n.is_read ? '' : 'unread'}"
         data-id="${escHtml(n.id)}"
         data-link="${escHtml(n.link || '')}">
      ${notifTypeIcon(n.type)}
      <div class="notif-page-item-body">
        <div class="notif-page-item-header">
          <p class="notif-page-item-title">${escHtml(n.title)}</p>
          <span class="notif-page-item-time">${relativeTime(n.created_at)}</span>
        </div>
        <p class="notif-page-item-text">${escHtml(n.body)}</p>
      </div>
      ${n.link ? `<span class="notif-page-item-arrow">›</span>` : ''}
    </div>`;
}

function syncBadge() {
  const unread = allNotifs.filter(n => !n.is_read).length;
  if (!badgeEl) return;
  badgeEl.textContent = unread > 99 ? '99+' : String(unread);
  badgeEl.hidden = unread === 0;
}

function renderList() {
  const filtered = activeFilter === 'unread'
    ? allNotifs.filter(n => !n.is_read)
    : allNotifs;

  if (!filtered.length) {
    listEl.innerHTML = `
      <div class="notif-page-empty">
        <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        <p>${activeFilter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}</p>
      </div>`;
    return;
  }

  const groups = groupByDate(filtered);
  listEl.innerHTML = groups.map(g => `
    <div class="notif-date-group">
      <p class="notif-date-label">${g.label}</p>
      ${g.items.map(renderPageItem).join('')}
    </div>`).join('');
}

// ── Data loading ──────────────────────────────────────────────────────────────
const SKELETON_ITEM = `
  <div class="notif-skeleton-item">
    <div class="notif-skeleton-icon"></div>
    <div class="notif-skeleton-content">
      <div class="notif-skeleton-line wide"></div>
      <div class="notif-skeleton-line medium"></div>
    </div>
  </div>`;

async function loadNotifs() {
  listEl.innerHTML = `<div class="notif-page-loading">${SKELETON_ITEM.repeat(4)}</div>`;
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, link, is_read, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[admin_notifications] query error:', error);
    listEl.innerHTML = `<div class="notif-page-empty"><p>Could not load notifications.<br><small style="opacity:.6">${escHtml(error.message)}</small></p></div>`;
    return;
  }

  allNotifs = data || [];
  renderList();
  syncBadge();
}

// ── Events ────────────────────────────────────────────────────────────────────
markAllBtn?.addEventListener('click', async () => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (!error) {
    allNotifs = allNotifs.map(n => ({ ...n, is_read: true }));
    renderList();
    syncBadge();
  }
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderList();
  });
});

listEl.addEventListener('click', async e => {
  const item = e.target.closest('.notif-page-item');
  if (!item) return;
  const { id, link } = item.dataset;
  if (id && item.classList.contains('unread')) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    const n = allNotifs.find(x => x.id === id);
    if (n) n.is_read = true;
    item.classList.remove('unread');
    syncBadge();
  }
  if (link) window.location.href = link;
});

// ── Realtime ──────────────────────────────────────────────────────────────────
supabase
  .channel(`notif_page_${userId}`)
  .on('postgres_changes', {
    event: '*',   // INSERT + UPDATE + DELETE — catches mark-read from any tab/page
    schema: 'public', table: 'notifications',
    filter: `user_id=eq.${userId}`,
  }, () => loadNotifs())
  .subscribe();

// ── Init ──────────────────────────────────────────────────────────────────────
await loadNotifs();
