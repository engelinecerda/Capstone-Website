// notifications.js — In-app notification bell for customer navbar and admin sidebar

// ── CSS injection ─────────────────────────────────────────────────────────────
(function injectCSS() {
  if (document.getElementById('notif-stylesheet')) return;
  const link = document.createElement('link');
  link.id = 'notif-stylesheet';
  link.rel = 'stylesheet';
  link.href = '/css/notifications.css';
  document.head.appendChild(link);
})();

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const BELL_SVG = (size = 17) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>`;

// ── Shared notification logic ──────────────────────────────────────────────────
function renderList(listEl, notifications) {
  if (!notifications.length) {
    listEl.innerHTML = `
      <li class="notif-empty">
        <span class="notif-empty-icon">🔔</span>
        No notifications yet
      </li>`;
    return;
  }
  listEl.innerHTML = notifications.map(n => `
    <li class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${escHtml(n.id)}" data-link="${escHtml(n.link || '')}">
      <span class="notif-item-title">${escHtml(n.title)}</span>
      ${n.is_read ? '<span></span>' : '<span class="notif-unread-dot"></span>'}
      <span class="notif-item-body">${escHtml(n.body)}</span>
      <span class="notif-item-time">${relativeTime(n.created_at)}</span>
    </li>`).join('');
}

function syncBadge(badgeEl, count) {
  if (!badgeEl) return;
  if (count > 0) {
    badgeEl.textContent = count > 99 ? '99+' : String(count);
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }
}

async function fetchAndRender(supabase, userId, listEl, badgeEl) {
  try {
    const { data } = await supabase
      .from('notifications')
      .select('id, type, title, body, link, is_read, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20);
    const notifs = data || [];
    renderList(listEl, notifs);
    syncBadge(badgeEl, notifs.filter(n => !n.is_read).length);
  } catch { /* silently ignore fetch failures */ }
}

async function markAll(supabase, userId, listEl, badgeEl) {
  try {
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    await fetchAndRender(supabase, userId, listEl, badgeEl);
  } catch { /* ignore */ }
}

async function markOne(supabase, id, listEl, badgeEl) {
  try {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    const item = listEl.querySelector(`[data-id="${id}"]`);
    if (item) {
      item.classList.remove('unread');
      const dot = item.querySelector('.notif-unread-dot');
      if (dot) dot.replaceWith(document.createElement('span'));
    }
    syncBadge(badgeEl, listEl.querySelectorAll('.notif-item.unread').length);
  } catch { /* ignore */ }
}

function subscribeRealtime(supabase, userId, listEl, badgeEl) {
  supabase
    .channel(`notif_bell_${userId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${userId}`,
    }, () => fetchAndRender(supabase, userId, listEl, badgeEl))
    .subscribe();
}

function wirePanelEvents({ supabase, userId, bellBtn, panel, listEl, badgeEl, markAllBtn }) {
  // Toggle panel open/close
  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !opening;
    bellBtn.setAttribute('aria-expanded', String(opening));
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && !bellBtn.contains(e.target)) {
      panel.hidden = true;
      bellBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Mark all read
  markAllBtn?.addEventListener('click', async e => {
    e.stopPropagation();
    await markAll(supabase, userId, listEl, badgeEl);
  });

  // Click on notification item — mark read + navigate
  listEl.addEventListener('click', async e => {
    const item = e.target.closest('.notif-item');
    if (!item) return;
    const { id, link } = item.dataset;
    if (id && item.classList.contains('unread')) {
      await markOne(supabase, id, listEl, badgeEl);
    }
    if (link) {
      panel.hidden = true;
      window.location.href = link;
    }
  });

  subscribeRealtime(supabase, userId, listEl, badgeEl);
}

// ── Customer navbar bell ───────────────────────────────────────────────────────
export async function initCustomerNotificationBell(supabase, userId) {
  const mount = document.getElementById('notifBellMount');
  if (!mount) return;

  mount.innerHTML = `
    <span class="notif-navbar-wrapper">
      <button class="notif-bell-btn" id="notifBellBtnCustomer"
              aria-label="Notifications" aria-expanded="false">
        ${BELL_SVG(17)}
        <span class="notif-badge" id="notifBadgeCustomer" hidden>0</span>
      </button>
      <div class="notif-panel" id="notifPanelCustomer" hidden>
        <div class="notif-panel-header">
          <span class="notif-panel-title">Notifications</span>
          <button class="notif-mark-all-btn" id="notifMarkAllCustomer">Mark all read</button>
        </div>
        <ul class="notif-list" id="notifListCustomer"></ul>
      </div>
    </span>`;

  const bellBtn   = document.getElementById('notifBellBtnCustomer');
  const panel     = document.getElementById('notifPanelCustomer');
  const listEl    = document.getElementById('notifListCustomer');
  const badgeEl   = document.getElementById('notifBadgeCustomer');
  const markAllBtn = document.getElementById('notifMarkAllCustomer');

  await fetchAndRender(supabase, userId, listEl, badgeEl);
  wirePanelEvents({ supabase, userId, bellBtn, panel, listEl, badgeEl, markAllBtn });
}

// ── Admin sidebar bell ────────────────────────────────────────────────────────
export async function initAdminNotificationBell(supabase, userId) {
  const sidebarHeader = document.querySelector('.sidebar-header');
  if (!sidebarHeader) return;

  const btnWrap = document.createElement('span');
  btnWrap.className = 'notif-sidebar-btn-wrap';
  btnWrap.innerHTML = `
    <button class="notif-bell-btn" id="notifBellBtnAdmin"
            aria-label="Go to notifications">
      ${BELL_SVG(15)}
      <span class="notif-badge" id="notifBadgeAdmin" hidden>0</span>
    </button>`;
  sidebarHeader.appendChild(btnWrap);

  const bellBtn = document.getElementById('notifBellBtnAdmin');
  const badgeEl = document.getElementById('notifBadgeAdmin');

  // Fetch unread count for badge only — no inline panel
  async function refreshBadge() {
    try {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);
      syncBadge(badgeEl, count ?? 0);
    } catch { /* ignore */ }
  }

  await refreshBadge();

  // Navigate to dedicated notifications page on click
  bellBtn?.addEventListener('click', () => {
    window.location.href = '/admin/notifications.html';
  });

  // Keep badge live via realtime
  supabase
    .channel(`notif_bell_admin_${userId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'notifications',
      filter: `user_id=eq.${userId}`,
    }, () => refreshBadge())
    .subscribe();
}
