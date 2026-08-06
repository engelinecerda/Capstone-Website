// manager_notification_bell.js
// Shared header notification bell + dropdown for every Manager-side admin page.
// Reuses the existing `notifications` table/RLS/realtime setup — only the
// presentation (header bell + dropdown instead of a sidebar badge) is new.

function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const BELL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

const TYPE_ICONS = {
    calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`
};

function iconForType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized.includes('payment')) return TYPE_ICONS.card;
    if (normalized.includes('contract')) return TYPE_ICONS.file;
    if (normalized.includes('review')) return TYPE_ICONS.star;
    return TYPE_ICONS.calendar;
}

function relativeTime(iso) {
    const date = new Date(iso);
    const now = new Date();
    const diffMin = Math.floor((now - date) / 60000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((startOfToday - startOfDate) / 86400000);

    if (dayDiff === 1) return 'Yesterday';
    if (dayDiff < 7) return `${dayDiff} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function initManagerNotificationBell(supabase, userId) {
    const mount = document.getElementById('managerNotifBell');
    if (!mount || !userId) return () => {};

    mount.innerHTML = `
        <div class="notif-bell-wrap">
            <button type="button" class="notif-bell-btn" id="notifBellBtn" aria-label="Notifications" aria-expanded="false">
                ${BELL_SVG}
                <span class="notif-bell-badge" id="notifBellBadge" hidden>0</span>
            </button>
            <div class="notif-dropdown-panel" id="notifDropdownPanel" hidden role="dialog" aria-label="Notifications">
                <div class="notif-dropdown-header">
                    <span class="notif-dropdown-title">Notifications</span>
                    <button type="button" class="notif-mark-all-link" id="notifMarkAllBtn" hidden>Mark all as read</button>
                </div>
                <ul class="notif-dropdown-list" id="notifDropdownList"></ul>
                <div class="notif-dropdown-footer">
                    <a href="/admin/notifications.html">View all notifications</a>
                </div>
            </div>
        </div>
    `;

    const bellBtn = document.getElementById('notifBellBtn');
    const badgeEl = document.getElementById('notifBellBadge');
    const panelEl = document.getElementById('notifDropdownPanel');
    const listEl = document.getElementById('notifDropdownList');
    const markAllBtn = document.getElementById('notifMarkAllBtn');

    let notifications = [];

    function renderBadge(count) {
        if (badgeEl) {
            if (count > 0) {
                badgeEl.textContent = count > 9 ? '9+' : String(count);
                badgeEl.hidden = false;
            } else {
                badgeEl.hidden = true;
            }
        }
        bellBtn?.setAttribute('aria-label', `Notifications (${count} unread)`);
    }

    function renderList() {
        if (!listEl) return;
        const unreadCount = notifications.filter((n) => !n.is_read).length;
        if (markAllBtn) markAllBtn.hidden = unreadCount === 0;

        if (!notifications.length) {
            listEl.innerHTML = `<li class="notif-dropdown-empty">You're all caught up</li>`;
            return;
        }

        listEl.innerHTML = notifications.map((n) => `
            <li class="notif-dropdown-item ${n.is_read ? '' : 'unread'}" data-id="${escHtml(n.id)}" data-link="${escHtml(n.link || '')}">
                <span class="notif-item-icon">${iconForType(n.type)}</span>
                <span class="notif-item-body">
                    <span class="notif-item-message">${escHtml(n.body || n.title || '')}</span>
                    <span class="notif-item-time">${relativeTime(n.created_at)}</span>
                </span>
                ${n.is_read ? '' : '<span class="notif-unread-dot"></span>'}
            </li>
        `).join('');
    }

    async function fetchAndRender() {
        const { data, error } = await supabase
            .from('notifications')
            .select('id, type, title, body, link, is_read, created_at')
            .eq('user_id', userId)
            .eq('channel', 'in_app')
            .order('created_at', { ascending: false })
            .limit(20);
        if (error) {
            return;
        }
        notifications = data || [];
        renderBadge(notifications.filter((n) => !n.is_read).length);
        renderList();
    }

    function handleOutsideClick(event) {
        if (!mount.contains(event.target)) closePanel();
    }

    function handleEscKey(event) {
        if (event.key === 'Escape') closePanel();
    }

    function openPanel() {
        if (!panelEl) return;
        panelEl.hidden = false;
        bellBtn?.setAttribute('aria-expanded', 'true');
        document.addEventListener('click', handleOutsideClick, true);
        document.addEventListener('keydown', handleEscKey);
    }

    function closePanel() {
        if (!panelEl) return;
        panelEl.hidden = true;
        bellBtn?.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', handleOutsideClick, true);
        document.removeEventListener('keydown', handleEscKey);
    }

    bellBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = panelEl && !panelEl.hidden;
        if (isOpen) closePanel(); else openPanel();
    });

    markAllBtn?.addEventListener('click', async (event) => {
        event.stopPropagation();
        const { error } = await supabase
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false);
        if (error) {
            return;
        }
        await fetchAndRender();
    });

    listEl?.addEventListener('click', async (event) => {
        const item = event.target.closest('.notif-dropdown-item');
        if (!item) return;
        const id = item.dataset.id;
        const link = item.dataset.link;

        if (item.classList.contains('unread') && id) {
            await supabase.from('notifications').update({ is_read: true }).eq('id', id);
        }

        if (link) {
            closePanel();
            window.location.href = link;
        } else {
            await fetchAndRender();
        }
    });

    fetchAndRender();

    supabase
        .channel(`notif_bell_manager_${userId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, () => {
            fetchAndRender();
        })
        .subscribe();

    return fetchAndRender;
}
