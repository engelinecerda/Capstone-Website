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

// ── Notification type icon avatars ────────────────────────────────────────────
function notifTypeIcon(type) {
  const icons = {
    reservation: {
      bg: '#eff6ff', color: '#2563eb',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    },
    contract: {
      bg: '#f5f3ff', color: '#7c3aed',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    },
    payment: {
      bg: '#ecfdf5', color: '#059669',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    },
    review: {
      bg: '#fffbeb', color: '#d97706',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
    },
    account: {
      bg: '#f0f9ff', color: '#0284c7',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>`,
    },
    system: {
      bg: '#f9fafb', color: '#6b7280',
      svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    },
  };
  const cfg = icons[(type || '').toLowerCase()] || {
    bg: '#fdf6ee', color: '#7c5c3a',
    svg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  };
  return `<span class="notif-type-icon" style="background:${cfg.bg};color:${cfg.color}">${cfg.svg}</span>`;
}

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
    <li class="notif-item ${n.is_read ? '' : 'unread'}"
        data-id="${escHtml(n.id)}"
        data-link="${escHtml(n.link || '')}">
      ${notifTypeIcon(n.type)}
      <span class="notif-item-content">
        <span class="notif-item-header">
          <span class="notif-item-title">${escHtml(n.title)}</span>
          <span class="notif-item-time">${relativeTime(n.created_at)}</span>
        </span>
        <span class="notif-item-body">${escHtml(n.body)}</span>
      </span>
      ${n.is_read ? '' : '<span class="notif-unread-dot"></span>'}
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

function syncUnreadPill(count) {
  const el = document.getElementById('notifUnreadCountCustomer');
  if (!el) return;
  if (count > 0) {
    el.textContent = `${count} unread`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function fetchAndRender(supabase, userId, listEl, badgeEl) {
  try {
    const { data } = await supabase
      .from('notifications')
      .select('id, type, title, body, link, is_read, created_at')
      .eq('user_id', userId)
      .eq('channel', 'in_app')
      .order('created_at', { ascending: false })
      .limit(20);
    const notifs = data || [];
    renderList(listEl, notifs);
    const unread = notifs.filter(n => !n.is_read).length;
    syncBadge(badgeEl, unread);
    syncUnreadPill(unread);
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

async function markOne(supabase, userId, id, listEl, badgeEl) {
  try {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    // Re-fetch from DB so badge + list are always derived from source-of-truth,
    // not from DOM state (which can drift when >20 notifications are loaded).
    await fetchAndRender(supabase, userId, listEl, badgeEl);
  } catch { /* ignore */ }
}

function subscribeRealtime(supabase, userId, listEl, badgeEl) {
  supabase
    .channel(`notif_bell_${userId}`)
    .on('postgres_changes', {
      event: '*',   // INSERT + UPDATE + DELETE — catches mark-read from any tab
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
      await markOne(supabase, userId, id, listEl, badgeEl);
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
          <span class="notif-panel-header-left">
            <span class="notif-panel-title">Notifications</span>
            <span class="notif-panel-unread-count" id="notifUnreadCountCustomer" hidden></span>
          </span>
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
        .eq('channel', 'in_app')
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
