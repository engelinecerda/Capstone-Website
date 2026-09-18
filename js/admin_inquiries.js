// js/admin_inquiries.js — Manager/Admin inquiries queue (list view).
// Admin is read-only here too, but the list itself has no write actions
// (only "View"), so the real Model-B gating lives on inquiry-details.js —
// this page just needs the standard admin boilerplate.
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { initAutoRefresh } from './auto_refresh.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarRoleBottom = document.getElementById('sidebarRoleBottom');
const viewOnlyPill = document.getElementById('inquiriesViewOnlyPill');
const statusDropdown = document.getElementById('statusDropdown');
const tableMessage = document.getElementById('tableMessage');
const tbody = document.getElementById('inquiriesBody');

let allInquiries = [];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

const STATUS_PILL_CLASS = { new: 'pending', contacted: 'cancellation_approved', converted: 'completed', closed: 'cancelled' };
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', converted: 'Converted', closed: 'Closed' };

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderRow(inq) {
  const eventTypeName = inq.event_types?.name || 'TBD';
  return `
    <tr>
      <td data-label="Name">${escapeHtml(inq.full_name)}</td>
      <td data-label="Event Type">${escapeHtml(eventTypeName)}</td>
      <td data-label="Event Date">${formatDate(inq.event_date)}</td>
      <td data-label="Submitted">${formatDate(inq.inquiry_date)}</td>
      <td class="table-status-cell" data-label="Status"><span class="status-pill ${STATUS_PILL_CLASS[inq.status] || 'default'}">${STATUS_LABEL[inq.status] || escapeHtml(inq.status)}</span></td>
      <td data-label="Action"><a class="action-btn view" href="/admin/inquiry-details?id=${encodeURIComponent(inq.id)}">View</a></td>
    </tr>`;
}

function renderTable() {
  const filter = statusDropdown.value;
  const rows = filter === 'all' ? allInquiries : allInquiries.filter((i) => i.status === filter);

  if (!rows.length) {
    tbody.innerHTML = '';
    tableMessage.textContent = allInquiries.length ? 'No inquiries match this filter.' : 'No inquiries yet.';
    tableMessage.classList.remove('hidden');
    return;
  }

  tableMessage.classList.add('hidden');
  tbody.innerHTML = rows.map(renderRow).join('');
}

async function loadInquiries({ silent = false } = {}) {
  if (!silent) tableMessage.textContent = 'Loading inquiries...';
  const { data, error } = await supabase
    .from('inquiries')
    .select('id, full_name, event_date, inquiry_date, status, event_types(name)')
    .order('inquiry_date', { ascending: false });

  if (error) {
    tableMessage.textContent = 'Could not load inquiries. Please refresh the page.';
    tableMessage.classList.remove('hidden');
    return;
  }

  allInquiries = data || [];
  renderTable();
}

statusDropdown.addEventListener('change', renderTable);

wireLogoutButton();
watchAuthState();
initAutoRefresh(() => loadInquiries({ silent: true }));

validateAdminSession({
  onSuccess: async ({ profile, session }) => {
    setupInactivityLogout(profile.role);
    if (sidebarAvatar) sidebarAvatar.textContent = getPortalInitials(profile);
    if (sidebarRoleBottom) sidebarRoleBottom.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    if (profile.role === 'admin') viewOnlyPill?.classList.remove('hidden');
    initAdminSidebarBadges(supabase);
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });
    await loadInquiries();
  }
});
