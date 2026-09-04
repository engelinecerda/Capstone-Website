// super_admin_accounts.js — Users & Roles
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { initAutoRefresh } from './auto_refresh.js';

// supabase-js's functions.invoke() sets `data` to null on any non-2xx
// response — the actual JSON body the function returned (our friendly
// "tied to N reservations" / "At least one admin is required" messages)
// only lives on error.context, a raw Response that has to be read
// separately. Without this, every failure path here would just show the
// generic "Edge Function returned a non-2xx status code".
async function extractFnError(fnErr, data) {
  if (data?.error) return data.error;
  if (fnErr?.context && typeof fnErr.context.json === 'function') {
    try {
      const body = await fnErr.context.json();
      if (body?.error) return body.error;
      if (body?.detail) return body.detail;
    } catch { /* body wasn't JSON, or already consumed */ }
  }
  return fnErr?.message || 'Something went wrong.';
}

// ── STATE ────────────────────────────────────────────────────────
let allAccounts = [];
let filtered    = [];
let currentPage = 1;
const PER_PAGE  = 10;
let openCardMenuEl = null;       // currently-open kebab popover element
let lastFocusedTrigger = null;   // element to return focus to when a modal closes

// ── LOAD ─────────────────────────────────────────────────────────
// silent=true is used by the auto-refresh triggers: it skips blanking the
// table with "Loading accounts…" first, and on failure it keeps the
// last-good data and fails quietly instead of showing an error state.
async function loadAccounts({ silent = false } = {}) {
  if (!silent) {
    document.getElementById('accountsBody').innerHTML =
      `<tr><td colspan="5"><div class="table-empty"><p style="color:var(--muted);">Loading accounts…</p></div></td></tr>`;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .in('role', ['admin', 'manager', 'staff'])
    .order('date_registered', { ascending: false });

  if (error) {
    if (silent) {
      console.warn('Auto-refresh failed, keeping last loaded accounts:', error.message);
      return;
    }
    document.getElementById('accountsBody').innerHTML =
      `<tr><td colspan="5"><div class="table-empty"><p>Failed to load accounts</p><span>${error.message}</span></div></td></tr>`;
    return;
  }

  // Real status, derived from real data — no in-memory overrides. Locked
  // accounts are deactivated; an account that has never signed in (no
  // last_sign_in_at) is still on its invite, waiting for the password-setup
  // email to be completed; anything else is active.
  allAccounts = (data || []).map(a => ({
    ...a,
    _status: a.is_locked ? 'deactivated' : (!a.last_sign_in_at ? 'invited' : 'active')
  }));
  updateStats();
  applyFilters({ resetPage: !silent });
}

// ── STATS ────────────────────────────────────────────────────────
function updateStats() {
  const total    = allAccounts.length;
  const admins   = allAccounts.filter(a => a.role === 'admin').length;
  const managers = allAccounts.filter(a => a.role === 'manager').length;
  const staff    = allAccounts.filter(a => a.role === 'staff').length;

  document.getElementById('statTotal').textContent    = total;
  document.getElementById('statTotalSub').textContent = `${admins} admin${admins !== 1 ? 's' : ''}, ${managers} manager${managers !== 1 ? 's' : ''}, ${staff} staff`;
  document.getElementById('statAdmins').textContent   = admins;
  document.getElementById('statStaff').textContent    = managers + staff;
}

// ── FILTERS ──────────────────────────────────────────────────────
// resetPage=false is used after an auto-refresh so an admin mid-way
// through the list isn't yanked back to page 1 every time; the page is
// clamped instead, in case the refreshed data has fewer pages than before.
function applyFilters({ resetPage = true } = {}) {
  const q       = document.getElementById('searchInput').value.trim().toLowerCase();
  const statusF = document.querySelector('#statusFilterSeg .seg-btn.active')?.dataset.status || '';

  filtered = allAccounts.filter(a => {
    const name    = [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' ').toLowerCase();
    const matchQ  = !q || name.includes(q) || (a.email || '').toLowerCase().includes(q);
    const matchSt = !statusF || a._status === statusF;
    return matchQ && matchSt;
  });

  if (resetPage) {
    currentPage = 1;
  } else {
    currentPage = Math.min(currentPage, Math.max(1, Math.ceil(filtered.length / PER_PAGE)));
  }
  renderTable();
}

// ── RENDER ───────────────────────────────────────────────────────
const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
  : '—';

// Relative, human time for the Last Active column — rendered in mono.
function fmtRelative(iso) {
  if (!iso) return 'Never signed in';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

const initials = a => {
  const p = [a.first_name, a.last_name].filter(Boolean);
  return p.map(x => x[0].toUpperCase()).join('') || (a.email || '?')[0].toUpperCase();
};

const displayName = a =>
  [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' ') || a.email || '—';

function roleLabel(a) {
  if (a.is_board_account) return 'Board Account';
  if (a.role === 'admin') return 'Admin';
  if (a.role === 'manager') return 'Manager';
  return 'Staff';
}

function buildRowMenu(a) {
  const items = [];
  items.push({ action: 'reset-password', label: 'Resend password setup email' });
  if (a.is_board_account) items.push({ action: 'reset-board-password', label: 'Reset board password' });
  items.push({ action: 'lock', label: a._status === 'deactivated' ? 'Reactivate' : 'Deactivate' });
  items.push({ action: 'clear-login-lock', label: 'Clear login lockout' });
  items.push({ divider: true });
  items.push({ action: 'delete', label: 'Remove', destructive: true });

  const itemsHtml = items.map(it => {
    if (it.divider) return '<div class="card-menu-divider"></div>';
    return `<button type="button" class="card-menu-item ${it.destructive ? 'destructive' : ''}" data-action="${it.action}" data-uid="${a.user_id}">${it.label}</button>`;
  }).join('');

  return `
    <div class="card-menu">
      <button type="button" class="icon-btn" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${displayName(a)}">⋮</button>
      <div class="card-menu-popover" hidden>${itemsHtml}</div>
    </div>`;
}

function closeOpenCardMenu() {
  if (openCardMenuEl) {
    openCardMenuEl.hidden = true;
    const trigger = openCardMenuEl.previousElementSibling;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    openCardMenuEl = null;
  }
}

function renderTable() {
  const tbody = document.getElementById('accountsBody');
  const total = filtered.length;
  const start = (currentPage - 1) * PER_PAGE;
  const page  = filtered.slice(start, start + PER_PAGE);

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="table-empty">
      <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <p>No accounts found</p><span>No staff accounts yet. Invite your first Manager, or adjust your search and filters.</span>
    </div></td></tr>`;
  } else {
    tbody.innerHTML = page.map(a => {
      const avClass = a.role === 'admin' ? 'avatar-admin' : a.role === 'manager' ? 'avatar-manager' : 'avatar-staff';
      return `<tr>
        <td>
          <div class="user-cell">
            <div class="avatar ${avClass}">${initials(a)}</div>
            <div>
              <div class="user-name">${displayName(a)}</div>
              <div class="user-email">${a.email || '—'}</div>
            </div>
          </div>
        </td>
        <td><span class="badge badge-${a.role}">${roleLabel(a)}${(!a.is_board_account && a.staff_role) ? ` · ${a.staff_role}` : ''}</span></td>
        <td><span class="status-pill ${a._status}">${a._status.charAt(0).toUpperCase() + a._status.slice(1)}</span></td>
        <td class="mono muted-cell">${fmtRelative(a.last_sign_in_at)}</td>
        <td>
          <div class="actions-cell">
            <button type="button" class="btn-outline-sm" data-action="edit" data-uid="${a.user_id}">Edit</button>
            ${buildRowMenu(a)}
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  document.getElementById('paginationInfo').textContent = total === 0
    ? 'No accounts'
    : `Showing ${start + 1}–${Math.min(start + PER_PAGE, total)} of ${total} account${total !== 1 ? 's' : ''}`;

  const totalPages = Math.ceil(total / PER_PAGE);
  const btns = document.getElementById('paginationBtns');
  btns.innerHTML = '';
  for (let i = 1; i <= totalPages; i++) {
    const b = document.createElement('button');
    b.className = 'pg-btn' + (i === currentPage ? ' active' : '');
    b.textContent = i;
    b.addEventListener('click', () => { currentPage = i; renderTable(); });
    btns.appendChild(b);
  }
}

// ── TABLE ACTIONS (Edit inline + kebab overflow) ──────────────────
document.getElementById('accountsBody').addEventListener('click', e => {
  const trigger = e.target.closest('[data-menu-trigger]');
  if (trigger) {
    const popover = trigger.nextElementSibling;
    const isOpen = openCardMenuEl === popover;
    closeOpenCardMenu();
    if (!isOpen) { popover.hidden = false; trigger.setAttribute('aria-expanded', 'true'); openCardMenuEl = popover; }
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) { closeOpenCardMenu(); return; }
  closeOpenCardMenu();

  const a = allAccounts.find(x => x.user_id === btn.dataset.uid);
  if (!a) return;
  lastFocusedTrigger = btn;
  if (btn.dataset.action === 'edit')                 openEditModal(a);
  if (btn.dataset.action === 'lock')                  openLockConfirm(a);
  if (btn.dataset.action === 'clear-login-lock')      clearLoginLock(a);
  if (btn.dataset.action === 'reset-password')        sendPasswordReset(a);
  if (btn.dataset.action === 'reset-board-password')  openBoardResetConfirm(a);
  if (btn.dataset.action === 'delete')                openRemoveConfirm(a);
});

document.addEventListener('click', e => {
  if (openCardMenuEl && !e.target.closest('.card-menu')) closeOpenCardMenu();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openCardMenuEl) closeOpenCardMenu();
});

// ── FILTER EVENTS ────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', applyFilters);
document.getElementById('statusFilterSeg').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  document.querySelectorAll('#statusFilterSeg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  applyFilters();
});
// Auto-refresh replaces the old manual Refresh button — see the matching
// block in js/admin_reservations.js for the full rationale. Debounced so a
// focus + visibilitychange pair (which fire together when switching back to
// this tab) can't trigger a duplicate fetch.
initAutoRefresh(() => loadAccounts({ silent: true }));

// ── FOCUS TRAP (shared by Account + Confirm modals) ───────────────
function trapFocus(container) {
  const focusables = container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  function handler(e) {
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  container.addEventListener('keydown', handler);
  first.focus();
  return handler;
}

function openModalWithTrap(overlay) {
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  const card = overlay.querySelector('[role="dialog"]');
  overlay._trapHandler = trapFocus(card);
}

function closeModalReturnFocus(overlay) {
  overlay.classList.add('hidden');
  overlay.setAttribute('aria-hidden', 'true');
  if (overlay._trapHandler) {
    overlay.querySelector('[role="dialog"]')?.removeEventListener('keydown', overlay._trapHandler);
    overlay._trapHandler = null;
  }
  if (lastFocusedTrigger && document.body.contains(lastFocusedTrigger)) lastFocusedTrigger.focus();
  lastFocusedTrigger = null;
}

// ── ADD MODAL ────────────────────────────────────────────────────
document.getElementById('addAccountBtn').addEventListener('click', () => {
  lastFocusedTrigger = document.getElementById('addAccountBtn');
  openAddModal();
});

function openAddModal() {
  document.getElementById('accountModalTitle').textContent = 'Invite User';
  document.getElementById('accountModalSub').textContent   = 'Create a new Manager account';
  document.getElementById('accountModalTabs').style.display = 'none';
  document.getElementById('addModeExtra').style.display     = 'block';
  document.getElementById('tab-info').classList.add('active');
  ['tab-access', 'tab-activity', 'tab-security'].forEach(id => document.getElementById(id).classList.remove('active'));

  clearFields(['fieldFirstName', 'fieldMiddleName', 'fieldLastName', 'fieldEmail']);
  document.getElementById('addFieldStaffRole').value = '';
  document.getElementById('addFieldRole').value   = 'manager';
  document.getElementById('fieldEmail').readOnly  = false;
  document.getElementById('fieldEmailHint').style.display = 'none';
  hideMsg();

  document.getElementById('accountModalSave').onclick = handleCreateAccount;
  document.getElementById('accountModalSave').innerHTML =
    '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Send Invite';

  document.getElementById('accountModal')._current = null;
  openModalWithTrap(document.getElementById('accountModal'));
}

// ── EDIT MODAL ───────────────────────────────────────────────────
function openEditModal(a) {
  document.getElementById('accountModalTitle').textContent = 'Edit User';
  document.getElementById('accountModalSub').textContent   = displayName(a);
  document.getElementById('accountModalTabs').style.display = 'flex';
  document.getElementById('addModeExtra').style.display     = 'none';
  switchTab('info');

  document.getElementById('fieldFirstName').value  = a.first_name  || '';
  document.getElementById('fieldMiddleName').value = a.middle_name || '';
  document.getElementById('fieldLastName').value   = a.last_name   || '';
  document.getElementById('fieldEmail').value      = a.email || '';
  document.getElementById('fieldEmail').readOnly   = true;
  document.getElementById('fieldEmailHint').style.display = 'block';

  document.getElementById('fieldStaffRole').value = a.staff_role || '';

  const statusNote = document.getElementById('fieldStatusNote');
  statusNote.innerHTML = `<span class="status-pill ${a._status}">${a._status.charAt(0).toUpperCase() + a._status.slice(1)}</span> — change this from the row's overflow menu (Deactivate / Reactivate), not here.`;

  const roleSelect = document.getElementById('fieldRole');
  const staffRoleInput = document.getElementById('fieldStaffRole');
  const boardHint = document.getElementById('fieldRoleBoardHint');
  // 'Staff' is now a permanent option in the base <select> (admin/super
  // admin/super_admin_accounts.html), so a plain staff row just uses it
  // directly — no more dynamic append for that case (it would now only
  // duplicate the static option). The board account still gets its own
  // distinct, disabled option; selected by reference (opt.selected) rather
  // than roleSelect.value=, since that assignment would otherwise resolve
  // to the static "Staff" option that now shares its value.
  roleSelect.querySelectorAll('option[data-dynamic]').forEach(o => o.remove());

  if (a.is_board_account) {
    const opt = document.createElement('option');
    opt.value = 'staff';
    opt.textContent = 'Staff (Board Account)';
    opt.dataset.dynamic = '1';
    roleSelect.appendChild(opt);
    opt.selected = true;
    roleSelect.disabled = true;
    staffRoleInput.disabled = true;
    boardHint.style.display = 'block';
  } else {
    roleSelect.value = a.role || 'manager';
    roleSelect.disabled = false;
    staffRoleInput.disabled = false;
    boardHint.style.display = 'none';
  }

  document.getElementById('viewDateRegistered').textContent = fmtDate(a.date_registered);
  document.getElementById('viewLastSignIn').textContent     = a.last_sign_in_at ? fmtDate(a.last_sign_in_at) : 'Never signed in';
  document.getElementById('viewRole').textContent           = roleLabel(a);
  document.getElementById('viewStaffRole').textContent      = a.staff_role || '—';

  // Reset security tab fields
  document.getElementById('securityNewPassword').value = '';
  document.getElementById('securityConfirmPassword').value = '';
  validatePasswordRequirements();
  document.querySelectorAll('.password-toggle-btn').forEach(btn => {
    const input = document.getElementById(btn.dataset.target);
    if (input) input.type = 'password';
    btn.classList.remove('showing');
  });

  hideMsg();
  document.getElementById('accountModalSave').onclick = () => handleUpdateAccount(a);
  document.getElementById('accountModalSave').innerHTML =
    '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Save Changes';

  document.getElementById('accountModal')._current = a;
  openModalWithTrap(document.getElementById('accountModal'));
}

// ── TAB SWITCHING ────────────────────────────────────────────────
document.getElementById('accountModalTabs').addEventListener('click', e => {
  const tab = e.target.closest('.modal-tab');
  if (tab) switchTab(tab.dataset.tab);
});

function switchTab(name) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

// ── CREATE ───────────────────────────────────────────────────────
async function handleCreateAccount() {
  const firstName  = v('fieldFirstName');
  const lastName   = v('fieldLastName');
  const middleName = v('fieldMiddleName');
  const email      = v('fieldEmail').toLowerCase();
  const role       = document.getElementById('addFieldRole').value;
  const staffRole  = v('addFieldStaffRole');

  if (!firstName || !lastName) { showMsg('First and last name are required.', 'error'); return; }
  if (!email)    { showMsg('Email address is required.', 'error'); return; }

  showMsg('Sending invite…', 'info');
  disableSave(true);

  try {
    const { data, error: fnErr } = await supabase.functions.invoke('create-staff-account', {
      body: {
        email,
        role,
        staff_role: staffRole || null,
        first_name: firstName,
        last_name: lastName
      }
    });

    if (fnErr) throw new Error(await extractFnError(fnErr, data));

    const { error: profileErr } = await supabase.from('profiles').update({
      middle_name: middleName || null
    }).eq('user_id', data.user_id);

    if (profileErr) throw profileErr;

    await logAudit({ action: 'Invited User', category: 'accounts', details: `Invited ${firstName} ${lastName} (${email}) as ${role}`, entityId: data.user_id });

    showMsg('Invite sent. A password setup email is on its way.', 'success');
    await loadAccounts();
    setTimeout(closeAccountModal, 1400);

  } catch (err) {
    showMsg(err.message || 'Failed to send invite.', 'error');
  } finally {
    disableSave(false);
  }
}
// ── UPDATE ───────────────────────────────────────────────────────
async function handleUpdateAccount(a) {
  const firstName  = v('fieldFirstName');
  const lastName   = v('fieldLastName');
  const middleName = v('fieldMiddleName');
  const role       = document.getElementById('fieldRole').value;
  const staffRole  = v('fieldStaffRole');
  const newPassword     = document.getElementById('securityNewPassword').value;
  const confirmPassword = document.getElementById('securityConfirmPassword').value;

  if (!firstName || !lastName) { showMsg('First and last name are required.', 'error'); return; }

  if (newPassword || confirmPassword) {
    if (newPassword.length < 8) {
      showMsg('New password must be at least 8 characters.', 'error');
      switchTab('security');
      return;
    }
    if (newPassword !== confirmPassword) {
      showMsg('New passwords do not match.', 'error');
      switchTab('security');
      return;
    }
  }

  const fields = { firstName, lastName, middleName, role, staffRole, newPassword };

  if (role !== a.role) {
    if (a.role === 'admin') {
      const otherActiveAdmins = allAccounts.filter(x => x.role === 'admin' && x.user_id !== a.user_id && !x.is_locked).length;
      if (otherActiveAdmins === 0) {
        showMsg('At least one admin is required. Promote another account to Admin first.', 'error');
        return;
      }
    }
    openRoleChangeConfirm(a, fields);
    return;
  }

  await saveAccountUpdate(a, fields);
}

// ── ROLE CHANGE CONFIRMATION ────────────────────────────────────────
function openRoleChangeConfirm(a, fields) {
  document.getElementById('confirmTitle').textContent = 'Change Role';
  document.getElementById('confirmSub').textContent   = displayName(a);
  document.getElementById('confirmBody').textContent  =
    `This changes ${displayName(a)}'s role from ${formatRoleLabel(a.role)} to ${formatRoleLabel(fields.role)}.`;
  document.getElementById('confirmOk').onclick = async () => {
    closeConfirmModal();
    await saveAccountUpdate(a, fields);
  };
  lastFocusedTrigger = document.getElementById('accountModalSave');
  openModalWithTrap(document.getElementById('confirmModal'));
}

function formatRoleLabel(role) {
  return role === 'admin' ? 'Admin' : role === 'manager' ? 'Manager' : role === 'staff' ? 'Staff' : role;
}

async function saveAccountUpdate(a, { firstName, lastName, middleName, role, staffRole, newPassword }) {
  showMsg('Saving changes…', 'info');
  disableSave(true);

  try {
    const { error } = await supabase.from('profiles').update({
      first_name: firstName,
      middle_name: middleName || null,
      last_name: lastName,
      role,
      staff_role: staffRole || null
    }).eq('user_id', a.user_id);

    if (error) throw error;

    if (newPassword) {
      showMsg('Updating password…', 'info');

      const { data: rpcData, error: rpcError } = await supabase.rpc('super_admin_change_user_password', {
        target_user_id: a.user_id,
        new_password: newPassword
      });

      if (rpcError) {
        throw new Error('Profile saved but password update failed: ' + rpcError.message);
      }
      if (rpcData && rpcData.success === false) {
        throw new Error('Profile saved but password update failed: ' + (rpcData.error || 'Unknown error'));
      }

      document.getElementById('securityNewPassword').value = '';
      document.getElementById('securityConfirmPassword').value = '';
      validatePasswordRequirements();
    }

    if (role !== a.role) {
      await logAudit({ action: 'Changed Role', category: 'accounts', details: `${displayName(a)}: ${formatRoleLabel(a.role)} → ${formatRoleLabel(role)}`, entityId: a.user_id });
    }
    if (newPassword) {
      await logAudit({ action: 'Changed Password', category: 'accounts', details: `Password changed for ${displayName(a)} (${a.email})`, entityId: a.user_id });
    }

    const idx = allAccounts.findIndex(x => x.user_id === a.user_id);
    if (idx !== -1) {
      allAccounts[idx] = {
        ...allAccounts[idx], first_name: firstName, middle_name: middleName,
        last_name: lastName, role, staff_role: staffRole
      };
    }

    showMsg(newPassword ? 'Changes saved and password updated successfully.' : 'Changes saved successfully.', 'success');
    updateStats();
    applyFilters();

  } catch (err) {
    showMsg(err.message || 'Failed to save changes.', 'error');
  } finally {
    disableSave(false);
  }
}

// ── PASSWORD RESET ───────────────────────────────────────────────
/*async function sendPasswordReset(a) {
  if (!a?.email) return;
  const { error } = await supabase.auth.resetPasswordForEmail(a.email);
  if (error) alert('Failed to send: ' + error.message);
  else alert(`Password reset email sent to ${a.email}.`);
}*/

// ── DEACTIVATE / REACTIVATE ────────────────────────────────────────
function openLockConfirm(a) {
  const isLocked = a._status === 'deactivated';

  if (!isLocked && a.role === 'admin') {
    const otherActiveAdmins = allAccounts.filter(x => x.role === 'admin' && x.user_id !== a.user_id && !x.is_locked).length;
    if (otherActiveAdmins === 0) {
      alert('At least one admin is required. Promote another account to Admin before deactivating this one.');
      return;
    }
  }

  document.getElementById('confirmTitle').textContent = isLocked ? 'Reactivate Account' : 'Deactivate Account';
  document.getElementById('confirmSub').textContent   = displayName(a);
  document.getElementById('confirmBody').textContent  = isLocked
    ? `This will restore access for ${displayName(a)}.`
    : `This will prevent ${displayName(a)} from signing in until reactivated. Their history stays intact.`;
  document.getElementById('confirmOk').onclick = async () => {
    const newLocked = !isLocked;

    const { error } = await supabase
      .from('profiles')
      .update({ is_locked: newLocked })
      .eq('user_id', a.user_id);

    if (error) {
      document.getElementById('confirmMsg').className = 'modal-message error';
      document.getElementById('confirmMsg').textContent = error.message;
      return;
    }

    await logAudit({
      action: newLocked ? 'Deactivated Account' : 'Reactivated Account',
      category: 'accounts',
      details: `${displayName(a)} was ${newLocked ? 'deactivated' : 'reactivated'}`,
      entityId: a.user_id
    });

    const idx = allAccounts.findIndex(x => x.user_id === a.user_id);
    if (idx !== -1) {
      allAccounts[idx].is_locked = newLocked;
      allAccounts[idx]._status = newLocked ? 'deactivated' : (!allAccounts[idx].last_sign_in_at ? 'invited' : 'active');
    }

    applyFilters();
    updateStats();
    closeConfirmModal();
  };
  openModalWithTrap(document.getElementById('confirmModal'));
}

// ── CLEAR LOGIN LOCKOUT ──────────────────────────────────────────
// The failed-attempt lockout (supabase/migrations/20260904_login_lockout_
// enforcement.sql) is separate from the manual Deactivate/Reactivate
// switch above — this clears the failure counter/cooldown, not is_locked.
// Always offered (not conditional on the account actually being locked
// right now) since checking that would need an extra round trip; clearing
// an account that isn't locked is a harmless no-op. This is the shared
// staff/board tablet account's real recovery path — the whole café floor
// is locked out with it, so an Admin must be able to clear it immediately
// rather than wait out the cooldown.
async function clearLoginLock(a) {
  const { error } = await supabase.rpc('admin_clear_login_lock', { p_user_id: a.user_id });
  if (error) {
    alert('Failed to clear login lockout: ' + error.message);
    return;
  }
  alert(`Login lockout cleared for ${displayName(a)}. They can sign in again immediately.`);
}

// ── RESET BOARD PASSWORD ─────────────────────────────────────────
function openBoardResetConfirm(a) {
  document.getElementById('confirmTitle').textContent = 'Reset Board Password';
  document.getElementById('confirmSub').textContent   = displayName(a);
  document.getElementById('confirmBody').textContent  =
    'This will sign out the counter display. The board must be logged in again with the new password. ' +
    'It may take up to an hour for an already-open display to actually be signed out.';
  const msg = document.getElementById('confirmMsg');
  msg.className = 'modal-message hidden';
  msg.textContent = '';

  document.getElementById('confirmOk').onclick = async () => {
    msg.className = 'modal-message info';
    msg.textContent = 'Resetting password…';

    const { data, error: fnErr } = await supabase.functions.invoke('reset-board-password', {
      body: { user_id: a.user_id }
    });

    if (fnErr || !data?.password) {
      msg.className = 'modal-message error';
      msg.textContent = await extractFnError(fnErr, data);
      return;
    }

    // Never include the password itself here — audit trail records that the
    // shared credential was rotated and by whom, not what it was rotated to.
    await logAudit({ action: 'Reset Board Password', category: 'accounts', details: `Shared board account password was reset (${displayName(a)})`, entityId: a.user_id });

    msg.className = 'modal-message success';
    msg.textContent = `New password: ${data.password} — copy this now, it will not be shown again.`;
  };
  openModalWithTrap(document.getElementById('confirmModal'));
}

// ── REMOVE (hard delete when unreferenced, else guided to Deactivate) ──
function openRemoveConfirm(a) {
  document.getElementById('confirmTitle').textContent = 'Remove Account';
  document.getElementById('confirmSub').textContent   = displayName(a);
  document.getElementById('confirmBody').textContent  =
    `This permanently removes ${displayName(a)}'s login and profile. This can't be undone. If anything still references this account, it will be deactivated instead.`;
  const msg = document.getElementById('confirmMsg');
  msg.className = 'modal-message hidden';
  msg.textContent = '';

  document.getElementById('confirmOk').onclick = async () => {
    msg.className = 'modal-message info';
    msg.textContent = 'Removing…';

    const { data, error: fnErr } = await supabase.functions.invoke('delete-staff-account', {
      body: { user_id: a.user_id }
    });

    if (fnErr || data?.error) {
      msg.className = 'modal-message error';
      msg.textContent = await extractFnError(fnErr, data);
      return;
    }

    await logAudit({ action: 'Removed Account', category: 'accounts', details: `Removed ${displayName(a)} (${a.email})`, entityId: a.user_id });

    allAccounts = allAccounts.filter(x => x.user_id !== a.user_id);
    updateStats();
    applyFilters();
    closeConfirmModal();
  };
  openModalWithTrap(document.getElementById('confirmModal'));
}

// ── HELPERS ──────────────────────────────────────────────────────
const closeAccountModal = () => closeModalReturnFocus(document.getElementById('accountModal'));
const closeConfirmModal  = () => closeModalReturnFocus(document.getElementById('confirmModal'));

function showMsg(text, type = '') {
  const el = document.getElementById('accountModalMsg');
  el.textContent = text;
  el.className   = 'modal-message' + (type ? ' ' + type : '');
}
function hideMsg() {
  document.getElementById('accountModalMsg').className = 'modal-message hidden';
}
function disableSave(val) {
  document.getElementById('accountModalSave').disabled = val;
}
const v = id => (document.getElementById(id)?.value || '').trim();
const clearFields = ids => ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

document.getElementById('accountModalClose').addEventListener('click', closeAccountModal);
document.getElementById('accountModalCancel').addEventListener('click', closeAccountModal);
document.getElementById('confirmClose').addEventListener('click', closeConfirmModal);
document.getElementById('confirmCancel').addEventListener('click', closeConfirmModal);

['accountModal', 'confirmModal'].forEach(id => {
  const overlay = document.getElementById(id);
  const card    = overlay.querySelector('[role="dialog"]');

  card.addEventListener('click', e => e.stopPropagation());

  overlay.addEventListener('click', () => {
    id === 'accountModal' ? closeAccountModal() : closeConfirmModal();
  });
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('accountModal').classList.contains('hidden')) closeAccountModal();
  if (!document.getElementById('confirmModal').classList.contains('hidden')) closeConfirmModal();
});

// ── PASSWORD TOGGLE ──────────────────────────────────────────────
document.addEventListener('click', e => {
  const toggleBtn = e.target.closest('.password-toggle-btn');
  if (!toggleBtn) return;
  const input = document.getElementById(toggleBtn.dataset.target);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    toggleBtn.classList.add('showing');
  } else {
    input.type = 'password';
    toggleBtn.classList.remove('showing');
  }
});

// ── PASSWORD REQUIREMENTS VALIDATION ─────────────────────────────
function validatePasswordRequirements() {
  const pw = document.getElementById('securityNewPassword')?.value || '';
  const confirm = document.getElementById('securityConfirmPassword')?.value || '';
  const reqLength = document.getElementById('reqLength');
  const reqMatch = document.getElementById('reqMatch');

  const lengthMet = pw.length >= 8;
  const matchMet = pw.length > 0 && pw === confirm;

  if (reqLength) {
    reqLength.classList.toggle('met', lengthMet);
    reqLength.querySelector('.req-icon').textContent = lengthMet ? '✓' : '○';
  }
  if (reqMatch) {
    reqMatch.classList.toggle('met', matchMet);
    reqMatch.querySelector('.req-icon').textContent = matchMet ? '✓' : '○';
  }
}
document.getElementById('securityNewPassword').addEventListener('input', validatePasswordRequirements);
document.getElementById('securityConfirmPassword').addEventListener('input', validatePasswordRequirements);

// ── SESSION ──────────────────────────────────────────────────────
async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Super Admin' });
  if (!result) return;

  if (result.profile.role !== 'admin') {
    window.location.replace('/admin/dashboard.html');
    return;
  }

  const avatarEl = document.getElementById('sidebarAvatar');
  if (avatarEl) avatarEl.textContent = getPortalInitials(result.profile);
  const roleBottomEl = document.getElementById('sidebarRoleBottom');
  if (roleBottomEl) roleBottomEl.textContent = 'Super Admin';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });
  loadAccounts();
}

init();