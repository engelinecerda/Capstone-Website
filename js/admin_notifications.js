import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const result = await validateAdminSession({ fallbackLabel: 'Notifications' });
if (!result) throw new Error('No session');

const { session, profile } = result;
const userId = session.user.id;

watchAuthState();
wireLogoutButton();
setupInactivityLogout(profile.role);
initAdminSidebarBadges(supabase);

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

  listEl.innerHTML = filtered.map(n => `
    <div class="notif-page-item ${n.is_read ? '' : 'unread'}"
         data-id="${escHtml(n.id)}"
         data-link="${escHtml(n.link || '')}">
      <div class="notif-page-item-dot"></div>
      <div class="notif-page-item-body">
        <p class="notif-page-item-title">${escHtml(n.title)}</p>
        <p class="notif-page-item-text">${escHtml(n.body)}</p>
        <span class="notif-page-item-time">${relativeTime(n.created_at)}</span>
      </div>
      ${n.link ? `<span class="notif-page-item-arrow">›</span>` : ''}
    </div>`).join('');
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadNotifs() {
  listEl.innerHTML = '<div class="notif-page-loading">Loading notifications…</div>';
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
    event: 'INSERT', schema: 'public', table: 'notifications',
    filter: `user_id=eq.${userId}`,
  }, () => loadNotifs())
  .subscribe();

// ── Init ──────────────────────────────────────────────────────────────────────
await loadNotifs();
