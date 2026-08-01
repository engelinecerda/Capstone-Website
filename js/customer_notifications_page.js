// customer_notifications_page.js — powers the standalone /notifications.html
// full notification history page. Reads the same `notifications` table/RLS
// the navbar dropdown (js/notifications.js) uses — auth.uid() = user_id on
// both SELECT and UPDATE already scopes every query to the logged-in
// customer's own rows, so no new backend endpoint was needed for this page.
// Filtering (All/Unread) and pagination are both done client-side against
// one fetched batch, mirroring js/account.js's renderReservations() pattern
// (RESERVATIONS_PAGE_SIZE + Array.slice) rather than server-side .range().
import { customerSupabase as supabase } from './supabase.js';

const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  window.location.href = '/login.html';
}
const userId = session.user.id;

const PAGE_SIZE = 15;
const FETCH_CAP = 300; // generous — customers won't realistically exceed this

let allNotifs = [];
let activeFilter = 'all'; // 'all' | 'unread'
let currentPage = 1;

const listEl        = document.getElementById('notifPageList');
const paginationEl  = document.getElementById('notifPagePagination');
const tabBtns       = document.querySelectorAll('.notif-page-tab[data-filter]');
const unreadPill    = document.getElementById('notifPageUnreadCount');
const markAllBtn    = document.getElementById('notifPageMarkAll');

// ── Helpers ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "Jul 31, 2:10 PM" — the detailed view, so an exact timestamp is more
// useful here than the dropdown's relative "2h ago" phrasing.
function fullTimestamp(iso) {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

const EMPTY_SVG = `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

// ── Rendering ────────────────────────────────────────────────────────────
function getFiltered() {
  return activeFilter === 'unread' ? allNotifs.filter((n) => !n.is_read) : allNotifs;
}

function renderRow(n) {
  return `
    <div class="notif-page-row ${n.is_read ? '' : 'unread'}"
         data-id="${escHtml(n.id)}"
         data-link="${escHtml(n.link || '')}"
         role="button"
         tabindex="0">
      <span class="notif-page-dot ${n.is_read ? 'is-read' : ''}" aria-hidden="true"></span>
      <span class="notif-page-row-content">
        <span class="notif-page-row-title">${escHtml(n.title)}</span>
        <span class="notif-page-row-desc">${escHtml(n.body)}</span>
      </span>
      <span class="notif-page-row-time">${fullTimestamp(n.created_at)}</span>
    </div>`;
}

function renderPagination(totalPages) {
  if (totalPages <= 1) { paginationEl.innerHTML = ''; return; }
  const pageButtons = Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => `
    <button type="button" class="notif-page-pagination-btn page-number ${pageNum === currentPage ? 'current' : ''}"
      data-page="${pageNum}" ${pageNum === currentPage ? 'aria-current="page"' : ''}>${pageNum}</button>
  `).join('');
  paginationEl.innerHTML = `
    <button type="button" class="notif-page-pagination-btn" data-page="prev" aria-label="Previous page" ${currentPage <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
    ${pageButtons}
    <button type="button" class="notif-page-pagination-btn" data-page="next" aria-label="Next page" ${currentPage >= totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
  `;
}

function syncTabState() {
  const unread = allNotifs.filter((n) => !n.is_read).length;
  if (unreadPill) unreadPill.textContent = String(unread);
  tabBtns.forEach((btn) => {
    const isActive = btn.dataset.filter === activeFilter;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
}

function renderList() {
  syncTabState();

  const filtered = getFiltered();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const paged = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  if (!paged.length) {
    listEl.innerHTML = `
      <div class="notif-page-empty">
        ${EMPTY_SVG}
        <p>${activeFilter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}</p>
      </div>`;
  } else {
    listEl.innerHTML = paged.map(renderRow).join('');
  }

  renderPagination(totalPages);
}

// ── Data loading ─────────────────────────────────────────────────────────
async function loadNotifs() {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, link, is_read, created_at')
    .eq('user_id', userId)
    .eq('channel', 'in_app')
    .order('created_at', { ascending: false })
    .limit(FETCH_CAP);

  if (error) {
    listEl.innerHTML = `<div class="notif-page-empty"><p>Could not load notifications.</p></div>`;
    return;
  }

  allNotifs = data || [];
  renderList();
}

// ── Events ───────────────────────────────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    currentPage = 1;
    renderList();
  });
});

markAllBtn?.addEventListener('click', async () => {
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (!error) await loadNotifs();
});

async function handleRowActivate(target) {
  const row = target.closest('.notif-page-row');
  if (!row) return;
  const { id, link } = row.dataset;
  if (id && row.classList.contains('unread')) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    await loadNotifs();
  }
  if (link) window.location.href = link;
}

listEl.addEventListener('click', (e) => handleRowActivate(e.target));
listEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!e.target.closest('.notif-page-row')) return;
  e.preventDefault();
  handleRowActivate(e.target);
});

paginationEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-page]');
  if (!btn || btn.disabled) return;
  const val = btn.dataset.page;
  if (val === 'next') currentPage += 1;
  else if (val === 'prev') currentPage -= 1;
  else currentPage = Number(val) || 1;
  renderList();
  listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Keeps this page's list/counts live if the dropdown (or another tab) marks
// notifications read/unread while this page is open — same channel pattern
// js/notifications.js's dropdown already uses.
supabase
  .channel(`notif_customer_page_${userId}`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'notifications',
    filter: `user_id=eq.${userId}`,
  }, () => loadNotifs())
  .subscribe();

// ── Init ─────────────────────────────────────────────────────────────────
await loadNotifs();
