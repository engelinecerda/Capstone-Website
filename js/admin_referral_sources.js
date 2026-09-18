// js/admin_referral_sources.js — admin-configurable "How did you hear about
// us?" list shown on the customer Inquiry form. Manager can add/edit/
// reorder/deactivate; Admin is view-only (Model B), same pattern as
// admin_inquiry_details.js: render write controls only for Manager, plus a
// defense-in-depth role re-check inside every mutating handler.
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarRoleBottom = document.getElementById('sidebarRoleBottom');
const viewOnlyPill = document.getElementById('rsViewOnlyPill');
const addBtn = document.getElementById('rsAddBtn');
const message = document.getElementById('rsMessage');
const tbody = document.getElementById('rsBody');

const modal = document.getElementById('rsModal');
const modalEyebrow = document.getElementById('rsModalEyebrow');
const modalTitle = document.getElementById('rsModalTitle');
const modalMsg = document.getElementById('rsModalMsg');
const modalCancel = document.getElementById('rsModalCancel');
const modalSave = document.getElementById('rsModalSave');
const labelInput = document.getElementById('rsLabelInput');
const activeInput = document.getElementById('rsActiveInput');

let currentRole = null;
let sources = [];
let editingId = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function openModal(existing) {
  editingId = existing ? existing.id : null;
  modalEyebrow.textContent = existing ? 'Edit Referral Source' : 'Add Referral Source';
  modalTitle.textContent = existing ? 'Edit referral source' : 'Add referral source';
  labelInput.value = existing ? existing.label : '';
  activeInput.checked = existing ? existing.is_active : true;
  modalMsg.textContent = '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  labelInput.focus();
}

function closeModal() {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

modalCancel.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

async function loadSources() {
  message.textContent = 'Loading...';
  const { data, error } = await supabase
    .from('referral_sources')
    .select('id, label, sort_order, is_active')
    .order('sort_order', { ascending: true });

  if (error) {
    message.textContent = 'Could not load referral sources. Please refresh the page.';
    return;
  }

  sources = data || [];
  renderTable();
}

function renderTable() {
  if (!sources.length) {
    tbody.innerHTML = '';
    message.textContent = 'No referral sources yet.';
    message.classList.remove('hidden');
    return;
  }
  message.classList.add('hidden');

  const isManager = currentRole === 'manager';

  tbody.innerHTML = sources.map((row, idx) => `
    <tr>
      <td data-label="Order">
        ${isManager ? `
          <span class="rs-order-btns">
            <button type="button" class="rs-order-btn" data-action="up" data-id="${row.id}" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button>
            <button type="button" class="rs-order-btn" data-action="down" data-id="${row.id}" ${idx === sources.length - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button>
          </span>` : ''}
      </td>
      <td data-label="Label">${escapeHtml(row.label)}</td>
      <td class="table-status-cell" data-label="Status"><span class="status-pill ${row.is_active ? 'approved' : 'cancelled'}">${row.is_active ? 'Active' : 'Inactive'}</span></td>
      <td data-label="Action">
        ${isManager ? `
          <button type="button" class="action-btn view" data-action="edit" data-id="${row.id}">Edit</button>
          <button type="button" class="action-btn" data-action="toggle" data-id="${row.id}">${row.is_active ? 'Deactivate' : 'Activate'}</button>
        ` : '—'}
      </td>
    </tr>
  `).join('');
}

async function renumber(orderedIds) {
  await Promise.all(orderedIds.map((id, i) =>
    supabase.from('referral_sources').update({ sort_order: i }).eq('id', id)
  ));
}

async function moveRow(id, direction) {
  if (currentRole !== 'manager') return;
  const idx = sources.findIndex((s) => s.id === id);
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || swapWith < 0 || swapWith >= sources.length) return;

  const reordered = [...sources];
  [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];

  await renumber(reordered.map((r) => r.id));
  await loadSources();
}

async function toggleActive(id) {
  if (currentRole !== 'manager') return;
  const row = sources.find((s) => s.id === id);
  if (!row) return;
  await supabase.from('referral_sources').update({ is_active: !row.is_active }).eq('id', id);
  await loadSources();
}

tbody.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  if (action === 'edit') {
    const row = sources.find((s) => s.id === id);
    if (row) openModal(row);
  } else if (action === 'toggle') {
    toggleActive(id);
  } else if (action === 'up' || action === 'down') {
    moveRow(id, action);
  }
});

addBtn.addEventListener('click', () => {
  if (currentRole !== 'manager') return;
  openModal(null);
});

modalSave.addEventListener('click', async () => {
  // Defense-in-depth — Add/Edit entry points are already hidden for Admin.
  if (currentRole !== 'manager') return;

  const label = labelInput.value.trim();
  if (!label) {
    modalMsg.textContent = 'Please enter a label.';
    return;
  }

  modalSave.disabled = true;
  modalMsg.textContent = '';

  let error;
  if (editingId) {
    ({ error } = await supabase.from('referral_sources').update({ label, is_active: activeInput.checked }).eq('id', editingId));
  } else {
    const nextOrder = sources.length ? Math.max(...sources.map((s) => s.sort_order)) + 1 : 0;
    ({ error } = await supabase.from('referral_sources').insert({ label, is_active: activeInput.checked, sort_order: nextOrder }));
  }

  modalSave.disabled = false;

  if (error) {
    modalMsg.textContent = 'Could not save. Please try again.';
    return;
  }

  closeModal();
  await loadSources();
});

function applyRoleGating() {
  if (currentRole === 'admin') {
    viewOnlyPill?.classList.remove('hidden');
    addBtn.classList.add('hidden');
  } else {
    addBtn.classList.remove('hidden');
  }
}

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile, session }) => {
    currentRole = profile.role;
    setupInactivityLogout(profile.role);
    if (sidebarAvatar) sidebarAvatar.textContent = getPortalInitials(profile);
    if (sidebarRoleBottom) sidebarRoleBottom.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initAdminSidebarBadges(supabase);
    initManagerNotificationBell(supabase, session.user.id);
    initAdminNav({ role: profile.role });
    applyRoleGating();
    await loadSources();
  }
});
