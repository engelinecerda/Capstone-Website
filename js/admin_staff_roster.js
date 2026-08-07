// js/admin_staff_roster.js
// Manager-owned CRUD for the staff_roster table — employees are lightweight
// records (name, optional email, optional position, active flag), never
// user accounts. Assignment to a reservation happens on the reservation
// details page (the existing "Assign staff" modal), not here — this page
// only manages who's on the roster to choose from.
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { logAudit } from './audit_logger.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarRoleBottom = document.getElementById('sidebarRoleBottom');
const logoutBtn = document.getElementById('logoutBtn');
const refreshBtn = document.getElementById('refreshBtn');
const rosterAddBtn = document.getElementById('rosterAddBtn');
const rosterMessage = document.getElementById('rosterMessage');
const rosterBody = document.getElementById('rosterBody');
const rosterCountSuffix = document.getElementById('rosterCountSuffix');

const rosterModal = document.getElementById('rosterModal');
const rosterModalEyebrow = document.getElementById('rosterModalEyebrow');
const rosterModalTitle = document.getElementById('rosterModalTitle');
const rosterModalSave = document.getElementById('rosterModalSave');
const rosterModalCancel = document.getElementById('rosterModalCancel');
const rosterModalMsg = document.getElementById('rosterModalMsg');
const rosterFirstName = document.getElementById('rosterFirstName');
const rosterLastName = document.getElementById('rosterLastName');
const rosterEmail = document.getElementById('rosterEmail');
const rosterPosition = document.getElementById('rosterPosition');
const rosterActive = document.getElementById('rosterActive');

const rosterConfirmModal = document.getElementById('rosterConfirmModal');
const rosterConfirmTitle = document.getElementById('rosterConfirmTitle');
const rosterConfirmCopy = document.getElementById('rosterConfirmCopy');
const rosterConfirmCancel = document.getElementById('rosterConfirmCancel');
const rosterConfirmOk = document.getElementById('rosterConfirmOk');

let currentRole = null;
let rosterEmployees = [];
let assignmentCountByStaffId = {};
let rosterEditingId = null;
// { type: 'toggle', id, activate } | { type: 'archive', id } | { type: 'delete', id }
let rosterPendingAction = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setRosterMessage(message, isError = false) {
  if (!rosterMessage) return;
  rosterMessage.textContent = message || '';
  rosterMessage.classList.toggle('error', isError);
}

function setRosterModalMessage(message, isError = false) {
  if (!rosterModalMsg) return;
  rosterModalMsg.textContent = message || '';
  rosterModalMsg.classList.toggle('error', isError);
}

function getEmployeeName(employee) {
  return [employee.first_name, employee.last_name].filter(Boolean).join(' ') || 'Unnamed employee';
}

/* ---------------------------------------------------------------- */
/* Data                                                                */
/* ---------------------------------------------------------------- */

async function fetchRoster() {
  const { data, error } = await supabase
    .from('staff_roster')
    .select('staff_id, first_name, last_name, staff_role, email, is_active, created_at')
    .order('first_name', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function fetchAssignmentCounts() {
  const { data, error } = await supabase
    .from('reservation_staff_assignments')
    .select('roster_staff_id');
  if (error) throw error;
  return (data || []).reduce((map, row) => {
    if (row.roster_staff_id == null) return map;
    map[row.roster_staff_id] = (map[row.roster_staff_id] || 0) + 1;
    return map;
  }, {});
}

async function loadRoster() {
  setRosterMessage('Loading employees...');
  try {
    rosterEmployees = await fetchRoster();
    assignmentCountByStaffId = await fetchAssignmentCounts();
    renderCountSuffix();
    renderRosterRows();
    setRosterMessage(rosterEmployees.length ? '' : 'No employees yet. Add your team so you can assign them to events.');
  } catch (error) {
    setRosterMessage(`Failed to load employees: ${error.message}`, true);
    rosterBody.innerHTML = '';
  }
}

function renderCountSuffix() {
  if (!rosterCountSuffix) return;
  const activeCount = rosterEmployees.filter((e) => e.is_active).length;
  rosterCountSuffix.textContent = rosterEmployees.length
    ? ` · ${activeCount} active`
    : '';
}

function toTitleCase(value) {
  return String(value || '').replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/* ---------------------------------------------------------------- */
/* Rendering                                                           */
/* ---------------------------------------------------------------- */

function renderRosterRows() {
  if (!rosterBody) return;
  if (!rosterEmployees.length) {
    rosterBody.innerHTML = '';
    return;
  }

  const isManager = currentRole !== 'admin';

  rosterBody.innerHTML = rosterEmployees.map((employee) => {
    const count = assignmentCountByStaffId[employee.staff_id] || 0;
    const actionsCell = isManager ? `
      <button type="button" class="action-btn view roster-edit-btn" data-id="${escapeHtml(employee.staff_id)}">Edit</button>
      <button type="button" class="roster-delete-btn" data-id="${escapeHtml(employee.staff_id)}">Delete</button>
    ` : '<span class="roster-muted">—</span>';

    return `
      <tr>
        <td class="roster-name-cell">${escapeHtml(getEmployeeName(employee))}</td>
        <td>${employee.email ? escapeHtml(employee.email) : '<span class="roster-muted">No email</span>'}</td>
        <td>${employee.staff_role ? escapeHtml(toTitleCase(employee.staff_role)) : '<span class="roster-muted">—</span>'}</td>
        <td>${count} reservation${count === 1 ? '' : 's'}</td>
        <td>
          <label class="pm2-toggle">
            <input type="checkbox" class="roster-active-toggle" data-id="${escapeHtml(employee.staff_id)}" ${employee.is_active ? 'checked' : ''} ${isManager ? '' : 'disabled'}>
            <span class="pm2-toggle-track"></span>
          </label>
        </td>
        <td class="roster-actions-cell"><div class="roster-actions-inner">${actionsCell}</div></td>
      </tr>
    `;
  }).join('');
}

/* ---------------------------------------------------------------- */
/* Add / edit modal                                                    */
/* ---------------------------------------------------------------- */

function resetRosterModal() {
  rosterEditingId = null;
  if (rosterFirstName) rosterFirstName.value = '';
  if (rosterLastName) rosterLastName.value = '';
  if (rosterEmail) rosterEmail.value = '';
  if (rosterPosition) rosterPosition.value = '';
  if (rosterActive) rosterActive.checked = true;
  setRosterModalMessage('');
}

function openRosterModal() {
  rosterModal?.classList.remove('hidden');
  rosterModal?.setAttribute('aria-hidden', 'false');
}

function closeRosterModal() {
  rosterModal?.classList.add('hidden');
  rosterModal?.setAttribute('aria-hidden', 'true');
  rosterModalSave?.removeAttribute('disabled');
}

function openAddEmployeeModal() {
  resetRosterModal();
  rosterModalEyebrow.textContent = 'Add Employee';
  rosterModalTitle.textContent = 'Add employee';
  rosterModalSave.textContent = 'Save employee';
  openRosterModal();
}

function openEditEmployeeModal(id) {
  const employee = rosterEmployees.find((e) => String(e.staff_id) === String(id));
  if (!employee) return;

  resetRosterModal();
  rosterEditingId = id;
  rosterModalEyebrow.textContent = 'Edit Employee';
  rosterModalTitle.textContent = 'Edit employee';
  rosterModalSave.textContent = 'Save changes';
  rosterFirstName.value = employee.first_name || '';
  rosterLastName.value = employee.last_name || '';
  rosterEmail.value = employee.email || '';
  rosterPosition.value = employee.staff_role || '';
  rosterActive.checked = Boolean(employee.is_active);
  openRosterModal();
}

function validateEmail(value) {
  if (!value) return true;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

async function saveRosterEmployee() {
  const firstName = rosterFirstName.value.trim();
  const lastName = rosterLastName.value.trim();
  const email = rosterEmail.value.trim();
  const position = rosterPosition.value.trim();
  const isActive = Boolean(rosterActive.checked);

  if (!firstName) {
    setRosterModalMessage('First name is required.', true);
    return;
  }
  if (!validateEmail(email)) {
    setRosterModalMessage('Enter a valid email, or leave it blank.', true);
    return;
  }

  const payload = {
    first_name: firstName,
    last_name: lastName || null,
    email: email || null,
    staff_role: position || null,
    is_active: isActive
  };

  rosterModalSave.setAttribute('disabled', 'true');
  setRosterModalMessage('Saving...');

  try {
    if (rosterEditingId) {
      const { error } = await supabase.from('staff_roster').update(payload).eq('staff_id', rosterEditingId);
      if (error) throw error;
      await logAudit({ action: 'Updated Employee', category: 'staff_roster', details: `Updated: ${firstName} ${lastName}`.trim(), entityId: rosterEditingId }).catch(() => {});
    } else {
      const { data, error } = await supabase.from('staff_roster').insert(payload).select('staff_id').maybeSingle();
      if (error) throw error;
      await logAudit({ action: 'Added Employee', category: 'staff_roster', details: `Added: ${firstName} ${lastName}`.trim(), entityId: data?.staff_id }).catch(() => {});
    }

    closeRosterModal();
    setRosterMessage(rosterEditingId ? 'Employee updated.' : 'Employee added.');
    await loadRoster();
  } catch (error) {
    rosterModalSave.removeAttribute('disabled');
    setRosterModalMessage(`Failed to save: ${error.message}`, true);
  }
}

/* ---------------------------------------------------------------- */
/* Delete / deactivate — conditional on existing assignments          */
/* ---------------------------------------------------------------- */

function openRosterConfirmModal() {
  rosterConfirmModal?.classList.remove('hidden');
  rosterConfirmModal?.setAttribute('aria-hidden', 'false');
}

function closeRosterConfirmModal() {
  rosterPendingAction = null;
  rosterConfirmModal?.classList.add('hidden');
  rosterConfirmModal?.setAttribute('aria-hidden', 'true');
  rosterConfirmOk?.removeAttribute('disabled');
}

async function handleDeleteClick(id) {
  const employee = rosterEmployees.find((e) => String(e.staff_id) === String(id));
  if (!employee) return;

  setRosterMessage('Checking assignments...');
  const { count, error } = await supabase
    .from('reservation_staff_assignments')
    .select('assignment_id', { count: 'exact', head: true })
    .eq('roster_staff_id', id);

  if (error) {
    setRosterMessage(`Failed to check assignments: ${error.message}`, true);
    return;
  }
  setRosterMessage('');

  if (count > 0) {
    rosterPendingAction = { type: 'archive', id };
    rosterConfirmTitle.textContent = `Deactivate ${getEmployeeName(employee)}?`;
    rosterConfirmCopy.textContent = `${getEmployeeName(employee)} is assigned to ${count} reservation${count === 1 ? '' : 's'}. They'll stay on those reservations but won't be offered for new assignments.`;
    rosterConfirmOk.textContent = 'Deactivate';
    rosterConfirmOk.classList.remove('modal-btn-danger');
  } else {
    rosterPendingAction = { type: 'delete', id };
    rosterConfirmTitle.textContent = `Remove ${getEmployeeName(employee)}?`;
    rosterConfirmCopy.textContent = "This can't be undone.";
    rosterConfirmOk.textContent = 'Remove employee';
    rosterConfirmOk.classList.add('modal-btn-danger');
  }
  openRosterConfirmModal();
}

async function confirmRosterAction() {
  if (!rosterPendingAction) return;
  const { type, id, activate } = rosterPendingAction;
  const employee = rosterEmployees.find((e) => String(e.staff_id) === String(id));

  rosterConfirmOk?.setAttribute('disabled', 'true');

  try {
    if (type === 'toggle') {
      const { error } = await supabase.from('staff_roster').update({ is_active: activate }).eq('staff_id', id);
      if (error) throw error;
      await logAudit({ action: activate ? 'Activated Employee' : 'Deactivated Employee', category: 'staff_roster', details: getEmployeeName(employee || {}), entityId: id }).catch(() => {});
      setRosterMessage(activate ? 'Employee activated.' : 'Employee deactivated.');
    } else if (type === 'archive') {
      const { error } = await supabase.from('staff_roster').update({ is_active: false }).eq('staff_id', id);
      if (error) throw error;
      await logAudit({ action: 'Deactivated Employee', category: 'staff_roster', details: `Deactivated (has assignments): ${getEmployeeName(employee || {})}`, entityId: id }).catch(() => {});
      setRosterMessage('Employee deactivated.');
    } else if (type === 'delete') {
      const { error } = await supabase.from('staff_roster').delete().eq('staff_id', id);
      if (error) throw error;
      await logAudit({ action: 'Deleted Employee', category: 'staff_roster', details: getEmployeeName(employee || {}), entityId: id }).catch(() => {});
      setRosterMessage('Employee deleted.');
    }

    closeRosterConfirmModal();
    await loadRoster();
  } catch (error) {
    rosterConfirmOk?.removeAttribute('disabled');
    setRosterMessage(`Failed: ${error.message}`, true);
  }
}

function handleRosterToggleChange(event) {
  const toggle = event.target.closest('.roster-active-toggle');
  if (!toggle) return;

  const id = toggle.dataset.id;
  const employee = rosterEmployees.find((e) => String(e.staff_id) === String(id));
  if (!employee) return;

  const activate = toggle.checked;
  toggle.checked = !activate; // revert until confirmed

  rosterPendingAction = { type: 'toggle', id, activate };
  rosterConfirmTitle.textContent = activate ? 'Activate employee' : 'Deactivate employee';
  rosterConfirmCopy.textContent = activate
    ? `Activate "${getEmployeeName(employee)}"? They can be assigned to reservations again.`
    : `Deactivate "${getEmployeeName(employee)}"? They'll stay on any reservations they're already assigned to, but won't be offered for new ones.`;
  rosterConfirmOk.textContent = 'Confirm';
  rosterConfirmOk.classList.remove('modal-btn-danger');
  openRosterConfirmModal();
}

/* ---------------------------------------------------------------- */
/* Wiring                                                              */
/* ---------------------------------------------------------------- */

function wireRosterTable() {
  rosterBody?.addEventListener('click', (event) => {
    const editBtn = event.target.closest('.roster-edit-btn');
    if (editBtn) {
      openEditEmployeeModal(editBtn.dataset.id);
      return;
    }
    const deleteBtn = event.target.closest('.roster-delete-btn');
    if (deleteBtn) {
      handleDeleteClick(deleteBtn.dataset.id);
    }
  });
  rosterBody?.addEventListener('change', handleRosterToggleChange);
}

function wireRosterModal() {
  rosterAddBtn?.addEventListener('click', openAddEmployeeModal);
  rosterModalCancel?.addEventListener('click', closeRosterModal);
  rosterModalSave?.addEventListener('click', saveRosterEmployee);
  rosterModal?.addEventListener('click', (event) => {
    if (event.target === rosterModal) closeRosterModal();
  });
}

function wireRosterConfirmModal() {
  rosterConfirmCancel?.addEventListener('click', closeRosterConfirmModal);
  rosterConfirmOk?.addEventListener('click', confirmRosterAction);
  rosterConfirmModal?.addEventListener('click', (event) => {
    if (event.target === rosterConfirmModal) closeRosterConfirmModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!rosterConfirmModal.classList.contains('hidden')) closeRosterConfirmModal();
    else if (!rosterModal.classList.contains('hidden')) closeRosterModal();
  });
}

function applyRoleGating() {
  if (currentRole === 'admin') {
    rosterAddBtn?.classList.add('hidden');
  } else {
    rosterAddBtn?.classList.remove('hidden');
  }
}

wireLogoutButton();
watchAuthState();
wireRosterTable();
wireRosterModal();
wireRosterConfirmModal();
refreshBtn?.addEventListener('click', loadRoster);

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
    await loadRoster();
  }
});
