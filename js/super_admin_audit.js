// super_admin_audit.js
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { logAudit } from './audit_logger.js';
import { initAdminNav } from './admin_nav.js';

// ─── State ────────────────────────────────────────────────────────────────────
let allLogs     = [];
let currentPage = 1;
const PAGE_SIZE = 10;
let totalCount  = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const auditSearchInput   = document.getElementById('auditSearchInput');
const categoryFilter     = document.getElementById('categoryFilter');
const dateFilter         = document.getElementById('dateFilter');
const auditTableBody     = document.getElementById('auditTableBody');
const pageMessage        = document.getElementById('pageMessage');
const prevPageBtn        = document.getElementById('prevPageBtn');
const nextPageBtn        = document.getElementById('nextPageBtn');
const paginationInfo     = document.getElementById('paginationInfo');
const exportAuditPdfBtn  = document.getElementById('exportAuditPdfBtn');
const refreshAuditBtn    = document.getElementById('refreshAuditBtn');
const auditDateFrom      = document.getElementById('auditDateFrom');
const auditDateTo        = document.getElementById('auditDateTo');
const clearDateRangeBtn  = document.getElementById('clearDateRangeBtn');
const filterRangeMessage = document.getElementById('filterRangeMessage');

// Stats
const statTodayActions = document.getElementById('statTodayActions');
const statReservation  = document.getElementById('statReservation');
const statPayment      = document.getElementById('statPayment');
const statPackage      = document.getElementById('statPackage');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function setMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => {
    pageMessage.textContent = '';
    pageMessage.className = 'page-message';
  }, 4000);
}

function setFilterRangeMessage(msg) {
  if (filterRangeMessage) filterRangeMessage.textContent = msg;
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  }) + ' ' + d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function formatTimestampShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric'
  }) + ' ' + d.toLocaleTimeString('en-PH', {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function getDateRange(filter) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (filter) {
    case 'today': return startOfDay.toISOString();
    case 'week': {
      const d = new Date(startOfDay);
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    }
    case 'month': {
      const d = new Date(startOfDay);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString();
    }
    default: return null;
  }
}

// ─── Action icons ─────────────────────────────────────────────────────────────
function getActionIcon(category) {
  const icons = {
    reservation: '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    payment:     '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    contract:    '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    package:     '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
    account:     '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    system:      '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };
  return icons[category] || icons.system;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const todayStart = getDateRange('today');
    const { data, error } = await supabase
      .from('audit_log')
      .select('category')
      .gte('created_at', todayStart);
    if (error) throw error;
    const logs = data || [];
    statTodayActions.textContent = logs.length;
    statReservation.textContent  = logs.filter(l => l.category === 'reservation').length;
    statPayment.textContent      = logs.filter(l => l.category === 'payment').length;
    statPackage.textContent      = logs.filter(l => l.category === 'contract').length;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ─── Build query filters (shared between load and export) ─────────────────────
function buildAuditQuery(forExport = false) {
  const search    = (auditSearchInput.value || '').trim().toLowerCase();
  const category  = categoryFilter.value;
  const dateVal   = dateFilter.value;
  const dateFrom  = getDateRange(dateVal);
  const customFrom = auditDateFrom?.value ? new Date(`${auditDateFrom.value}T00:00:00`).toISOString() : null;
  const customTo   = auditDateTo?.value   ? new Date(`${auditDateTo.value}T23:59:59`).toISOString()   : null;

  // Custom range overrides the quick date filter when set
  const effectiveFrom = customFrom || dateFrom;

  let query = supabase
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (category)      query = query.eq('category', category);
  if (effectiveFrom) query = query.gte('created_at', effectiveFrom);
  if (customTo)      query = query.lte('created_at', customTo);

  if (search) {
    query = query.or(
      `user_name.ilike.%${search}%,action.ilike.%${search}%,details.ilike.%${search}%,entity_id.ilike.%${search}%`
    );
  }

  return query;
}

// ─── Load & render ────────────────────────────────────────────────────────────
async function loadAuditLogs() {
  setMessage('Loading audit logs…');

  try {
    const from = (currentPage - 1) * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;
    const { data, error, count } = await buildAuditQuery().range(from, to);

    if (error) throw error;

    allLogs    = data || [];
    totalCount = count || 0;

    renderAuditTable();
    updatePagination();
    updateFilterRangeMessage(count || 0);
    setMessage('');
  } catch (err) {
    setMessage(`Failed to load audit logs: ${err.message}`, 'error');
    auditTableBody.innerHTML = '<tr class="empty-row"><td colspan="5">Failed to load audit logs.</td></tr>';
  }
}

function updateFilterRangeMessage(count) {
  const hasCustomRange = auditDateFrom?.value || auditDateTo?.value;
  if (!hasCustomRange) {
    setFilterRangeMessage(`${count} log(s) match the current filters.`);
    return;
  }
  const fromLabel = auditDateFrom?.value || 'the beginning';
  const toLabel   = auditDateTo?.value   || 'today';
  setFilterRangeMessage(`${count} log(s) found from ${fromLabel} to ${toLabel}.`);
}

function buildAuditRow(log) {
  const cat = (log.category || 'system').toLowerCase();
  return `<tr>
    <td><span class="audit-timestamp">${formatTimestamp(log.created_at)}</span></td>
    <td>
      <div class="audit-user-name">${escapeHtml(log.user_name || 'System')}</div>
      <div class="audit-user-role">${escapeHtml(log.user_role || '—')}</div>
    </td>
    <td>
      <div class="audit-action">
        ${getActionIcon(cat)}
        ${escapeHtml(log.action)}
      </div>
    </td>
    <td><span class="audit-category-pill ${cat}">${escapeHtml(cat)}</span></td>
    <td>
      <div class="audit-details-text">${escapeHtml(log.details || '—')}</div>
    </td>
  </tr>`;
}

function renderAuditTable() {
  if (!allLogs.length) {
    auditTableBody.innerHTML = '<tr class="empty-row"><td colspan="5">No audit logs found.</td></tr>';
    return;
  }
  auditTableBody.innerHTML = allLogs.map(buildAuditRow).join('');
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function updatePagination() {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  paginationInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

prevPageBtn.addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; loadAuditLogs(); }
});
nextPageBtn.addEventListener('click', () => {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  if (currentPage < totalPages) { currentPage++; loadAuditLogs(); }
});

// ─── Filters ──────────────────────────────────────────────────────────────────
let searchDebounce;
auditSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { currentPage = 1; loadAuditLogs(); }, 300);
});
categoryFilter.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });
dateFilter.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });

auditDateFrom?.addEventListener('input', () => { currentPage = 1; loadAuditLogs(); });
auditDateTo?.addEventListener('input',   () => { currentPage = 1; loadAuditLogs(); });

clearDateRangeBtn?.addEventListener('click', () => {
  if (auditDateFrom) auditDateFrom.value = '';
  if (auditDateTo)   auditDateTo.value   = '';
  setFilterRangeMessage('');
  currentPage = 1;
  loadAuditLogs();
});

refreshAuditBtn?.addEventListener('click', () => {
  currentPage = 1;
  loadStats();
  loadAuditLogs();
});

// ─── PDF Export ───────────────────────────────────────────────────────────────
function sanitizeForPdf(text) {
  return String(text || '').replace(/₱/g, 'PHP ');
}

async function exportAuditPdf() {
  const JsPdfConstructor = window.jspdf?.jsPDF;
  if (!JsPdfConstructor) {
    setMessage('PDF export is not available because jsPDF did not load.', 'error');
    return;
  }

  setMessage('Preparing PDF export…');
  exportAuditPdfBtn.disabled = true;

  try {
    // Fetch ALL matching logs (no pagination) for the export
    const { data, error, count } = await buildAuditQuery();
    if (error) throw error;

    const logs = data || [];
    if (!logs.length) {
      setMessage('No audit logs match the current filters. Adjust the range and try again.', 'error');
      exportAuditPdfBtn.disabled = false;
      return;
    }

    const doc = new JsPdfConstructor({ orientation: 'landscape', unit: 'pt', format: 'a4' });

    // Header
    const filenameDate = new Date().toISOString().slice(0, 10);
    const fromLabel = auditDateFrom?.value || '';
    const toLabel   = auditDateTo?.value   || '';
    const rangeLabel = [
      fromLabel ? `From ${fromLabel}` : '',
      toLabel   ? `To ${toLabel}`     : ''
    ].filter(Boolean).join('  ·  ');

    const category  = categoryFilter.value;
    const dateLabel = dateFilter.options[dateFilter.selectedIndex]?.text || '';

    doc.setFontSize(18);
    doc.text('ELI Coffee Events — Audit Trail', 40, 42);
    doc.setFontSize(11);
    doc.text(rangeLabel || `Filter: ${dateLabel}`, 40, 62);
    if (category) {
      doc.text(`Category: ${category.charAt(0).toUpperCase() + category.slice(1)}`, 40, 78);
    }
    doc.setFontSize(10);
    doc.setTextColor(120, 100, 80);
    doc.text(`Exported ${new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })} · ${logs.length} record(s)`, 40, category ? 96 : 82);
    doc.setTextColor(0, 0, 0);

    if (typeof doc.autoTable !== 'function') {
      setMessage('PDF export is not available because the table plugin did not load.', 'error');
      exportAuditPdfBtn.disabled = false;
      return;
    }

    doc.autoTable({
        startY: category ? 112 : 98,
        head: [['Timestamp', 'User', 'Role', 'Action', 'Category', 'Details']],
        body: logs.map(log => [
            formatTimestampShort(log.created_at),
            sanitizeForPdf(log.user_name || 'System'),
            sanitizeForPdf(log.user_role || '—'),
            sanitizeForPdf(log.action || '—'),
            (log.category || 'system').charAt(0).toUpperCase() + (log.category || 'system').slice(1),
            sanitizeForPdf(log.details || '—')
        ]),
        styles:     { fontSize: 8.5, cellPadding: 6, overflow: 'linebreak' },
        headStyles: { fillColor: [78, 54, 36] },
        columnStyles: {
            0: { cellWidth: 110 },
            1: { cellWidth: 90  },
            2: { cellWidth: 70  },
            3: { cellWidth: 110 },
            4: { cellWidth: 70  },
            5: { cellWidth: 'auto' }
        }
        });

    doc.save(`audit-trail-${filenameDate}.pdf`);
    setMessage(`Exported ${logs.length} audit log(s) to PDF.`, 'success');
  } catch (err) {
    setMessage(`PDF export failed: ${err.message}`, 'error');
  } finally {
    exportAuditPdfBtn.disabled = false;
  }
}

exportAuditPdfBtn?.addEventListener('click', exportAuditPdf);

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  wireLogoutButton('logoutBtn');
  watchAuthState(); 
  validateAdminSession({
    onSuccess: ({ profile }) => {
      if (profile.role !== 'admin') {
        window.location.replace('/admin/dashboard.html');
        return;
      }

      setupInactivityLogout(profile.role);
      initAdminSidebarBadges(supabase);
      initAdminNav({ role: profile.role });

      const avatarEl = document.getElementById('sidebarAvatar');
      if (avatarEl) avatarEl.textContent = getPortalInitials(profile);
      const roleBottomEl = document.getElementById('sidebarRoleBottom');
      if (roleBottomEl) roleBottomEl.textContent = 'Super Admin';

      const adminBadge = document.getElementById('adminBadge');
      if (adminBadge) adminBadge.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
      loadStats();
      loadAuditLogs();
    }
  });
}

init();