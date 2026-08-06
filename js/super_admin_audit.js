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
const roleFilter         = document.getElementById('roleFilter');
const actionTypeFilter   = document.getElementById('actionTypeFilter');
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

// ─── Action-type classification ────────────────────────────────────────────────
// audit_log.action is a free-text human description (e.g. "Turned On
// Maintenance Mode"), not a stored enum — there's no structured action-type
// column to filter/tag on. This heuristic derives Created/Updated/Deleted/
// Login/Other from keywords in that text, and the SAME keyword lists drive
// both the visual tag (classifyActionType) and the server-side filter
// (applyActionTypeFilter) so the two can never disagree about what a given
// entry counts as. Checked in this priority order so e.g. "Reactivated"
// (created) doesn't get caught by a broader "activat" pattern meant for
// "Deactivated" (deleted).
const ACTION_TYPE_ORDER = ['login', 'deleted', 'created', 'updated'];
const ACTION_TYPE_KEYWORDS = {
  login:   ['login', 'log in', 'logged in', 'sign in', 'signed in'],
  deleted: ['delet', 'remov', 'disabl', 'deactivat', 'cancel', 'reject'],
  created: ['creat', 'invit', 'enabl', 'reactivat', 'add', 'sent'],
  updated: ['updat', 'chang', 'sav', 'edit', 'turn', 'reschedul']
};
const ACTION_TYPE_LABELS = { created: 'Created', updated: 'Updated', deleted: 'Deleted', login: 'Login', other: 'Other' };

function classifyActionType(action) {
  const a = (action || '').toLowerCase();
  for (const type of ACTION_TYPE_ORDER) {
    if (ACTION_TYPE_KEYWORDS[type].some(kw => a.includes(kw))) return type;
  }
  return 'other';
}

function applyActionTypeFilter(query, type) {
  if (!type) return query;
  if (type === 'other') {
    ACTION_TYPE_ORDER.forEach(t => {
      ACTION_TYPE_KEYWORDS[t].forEach(kw => { query = query.not('action', 'ilike', `%${kw}%`); });
    });
    return query;
  }
  const keywords = ACTION_TYPE_KEYWORDS[type] || [];
  if (!keywords.length) return query;
  return query.or(keywords.map(kw => `action.ilike.%${kw}%`).join(','));
}

// ─── Utilities ────────────────────────────────────────────────────────────────
// PostgREST's .or() takes a raw string DSL where commas separate conditions
// and parentheses group them (e.g. and(...)/or(...)/in.(...)). Interpolating
// raw search input into that string without stripping those characters
// would let a search term restructure the filter itself — e.g. a comma
// could close the intended "value" early and open a second, attacker-
// chosen condition. This isn't classic SQL injection (every Supabase call
// in this app is parameterized under the hood by PostgREST), but it's the
// same class of bug: user input redefining query structure instead of just
// being a value within it. A search box has no legitimate need for these
// characters, so they're stripped rather than escaped.
function sanitizeForOrFilter(value) {
  return String(value || '').replace(/[,()]/g, '');
}

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
    // The 4 stat cards just keep showing "0" — not worth interrupting the
    // page for a decorative summary count.
  }
}

// ─── Build query filters (shared between load and export) ─────────────────────
function buildAuditQuery(forExport = false) {
  const search    = (auditSearchInput.value || '').trim().toLowerCase();
  const role      = roleFilter?.value || '';
  const actionType = actionTypeFilter?.value || '';
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

  if (role)           query = query.eq('user_role', role);
  if (category)        query = query.eq('category', category);
  if (effectiveFrom)  query = query.gte('created_at', effectiveFrom);
  if (customTo)       query = query.lte('created_at', customTo);
  if (actionType)      query = applyActionTypeFilter(query, actionType);

  if (search) {
    const safeSearch = sanitizeForOrFilter(search);
    query = query.or(
      `user_name.ilike.%${safeSearch}%,action.ilike.%${safeSearch}%,details.ilike.%${safeSearch}%,entity_id.ilike.%${safeSearch}%`
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
    auditTableBody.innerHTML = '<tr class="empty-row"><td colspan="4">Failed to load audit logs.</td></tr>';
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

// Rows are view/expand only — no edit, delete, or bulk actions anywhere on
// this page. Each row toggles a sibling detail row (same index) revealing
// the full entity reference and raw details in mono; the list itself stays
// scannable with a human summary, never a raw ID.
function buildAuditRow(log, index) {
  const cat = (log.category || 'system').toLowerCase();
  const actionType = classifyActionType(log.action);
  return `<tr class="audit-row" data-index="${index}" tabindex="0" role="button" aria-expanded="false" aria-label="View detail for ${escapeHtml(log.action || 'this entry')}">
    <td><span class="audit-timestamp">${formatTimestamp(log.created_at)}</span></td>
    <td>
      <div class="audit-actor-name">${escapeHtml(log.user_name || 'System')}</div>
      <div class="audit-actor-role">${escapeHtml(log.user_role || '—')}</div>
    </td>
    <td>
      <span class="action-tag ${actionType}">${ACTION_TYPE_LABELS[actionType]}</span><br>
      <span class="audit-category-chip">${escapeHtml(cat)}</span>
    </td>
    <td>
      <div class="audit-summary-cell">
        <span class="audit-summary-text">${escapeHtml(log.action || '—')}${log.details ? ' — ' + escapeHtml(log.details) : ''}</span>
        <svg class="expand-chevron" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </td>
  </tr>`;
}

function buildAuditDetailRow(log, index) {
  const rows = [
    ['Full timestamp', log.created_at || '—'],
    ['Actor', `${log.user_name || 'System'} (${log.user_role || '—'})`],
    ['Actor user ID', log.user_id || '—'],
    ['Action', log.action || '—'],
    ['Category', log.category || '—'],
    ['Entity ID', log.entity_id || '—'],
    ['Details', log.details || '—']
  ];
  return `<tr class="audit-detail-row" data-detail-for="${index}" hidden>
    <td colspan="4">
      <div class="audit-detail-panel">
        <div class="audit-detail-grid">
          ${rows.map(([label, value]) => `
            <span class="audit-detail-label">${escapeHtml(label)}</span>
            <span class="audit-detail-value${label === 'Details' || label === 'Action' ? ' prose' : ''}">${escapeHtml(String(value))}</span>
          `).join('')}
        </div>
      </div>
    </td>
  </tr>`;
}

function renderAuditTable() {
  if (!allLogs.length) {
    auditTableBody.innerHTML = '<tr class="empty-row"><td colspan="4">No audit entries match these filters.</td></tr>';
    return;
  }
  auditTableBody.innerHTML = allLogs
    .map((log, i) => buildAuditRow(log, i) + buildAuditDetailRow(log, i))
    .join('');
}

function toggleAuditRow(index) {
  const row = auditTableBody.querySelector(`.audit-row[data-index="${index}"]`);
  const detail = auditTableBody.querySelector(`.audit-detail-row[data-detail-for="${index}"]`);
  if (!row || !detail) return;
  const expanding = detail.hidden;
  detail.hidden = !expanding;
  row.classList.toggle('is-expanded', expanding);
  row.setAttribute('aria-expanded', String(expanding));
}

auditTableBody.addEventListener('click', e => {
  const row = e.target.closest('.audit-row');
  if (row) toggleAuditRow(row.dataset.index);
});
auditTableBody.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.audit-row');
  if (!row) return;
  e.preventDefault();
  toggleAuditRow(row.dataset.index);
});

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
roleFilter?.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });
actionTypeFilter?.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });
categoryFilter.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });
dateFilter.addEventListener('change', () => { currentPage = 1; loadAuditLogs(); });

// Entities aren't a fixed catalogue (category is a free-text field new
// features add new values to over time) — populate the filter from what's
// actually in the log instead of a hardcoded list that goes stale.
async function populateCategoryFilterOptions() {
  if (!categoryFilter) return;
  try {
    const { data, error } = await supabase.from('audit_log').select('category').limit(1000);
    if (error || !data) return;
    const known = new Set(Array.from(categoryFilter.options).map(o => o.value));
    const categories = [...new Set(data.map(r => r.category).filter(Boolean))].sort();
    categories.forEach(cat => {
      if (known.has(cat)) return;
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1).replace(/_/g, ' ');
      categoryFilter.appendChild(opt);
    });
  } catch (err) {
    // Entity filter just keeps whatever options it already had.
  }
}

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
      populateCategoryFilterOptions();
      loadAuditLogs();
    }
  });
}

init();