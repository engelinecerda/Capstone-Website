    //super_admin_accounts.js
    import { portalSupabase as supabase } from '/js/supabase.js';
    import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
    import { setupInactivityLogout } from './super_admin_inactivity.js';
    import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

   
    // ── STATE ────────────────────────────────────────────────────────
    let allAccounts = [];
    let filtered    = [];
    let currentPage = 1;
    const PER_PAGE  = 10;
    const statusMap = {}; // local status overrides until you add a DB column

    // ── LOAD ─────────────────────────────────────────────────────────
    async function loadAccounts() {
      document.getElementById('accountsBody').innerHTML =
        `<tr><td colspan="8"><div class="table-empty"><p style="color:var(--muted);">Loading accounts…</p></div></td></tr>`;

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        //.select('user_id, first_name, middle_name, last_name, email, phone_number, role, staff_role, date_registered, is_locked')
        .in('role', ['admin', 'staff'])
        .order('date_registered', { ascending: false });

      if (error) {
        document.getElementById('accountsBody').innerHTML =
          `<tr><td colspan="8"><div class="table-empty"><p>Failed to load accounts</p><span>${error.message}</span></div></td></tr>`;
        return;
      }

      allAccounts = (data || []).map(a => ({
      ...a,
      _status: a.is_locked === true
        ? 'locked'
        : (statusMap[a.user_id] || 'active')
    }));
      updateStats();
      applyFilters();
    }

    // ── STATS ────────────────────────────────────────────────────────
    function updateStats() {
      const total  = allAccounts.length;

      //const activeAccounts = allAccounts.filter(a => a._status === 'active');
      const admins = allAccounts.filter(a => a.role === 'admin').length;
      const staff  = allAccounts.filter(a => a.role === 'staff').length;
      document.getElementById('statTotal').textContent    = total;
      document.getElementById('statTotalSub').textContent = `${admins} admin${admins !== 1 ? 's' : ''}, ${staff} staff`;
      document.getElementById('statAdmins').textContent   = admins;
      document.getElementById('statStaff').textContent    = staff;
    }

    // ── FILTERS ──────────────────────────────────────────────────────
    function applyFilters() {
      const q       = document.getElementById('searchInput').value.trim().toLowerCase();
      const roleF   = document.getElementById('roleFilter').value;
      const statusF = document.getElementById('statusFilter').value;

      filtered = allAccounts.filter(a => {
        const name      = [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' ').toLowerCase();
        const matchQ    = !q || name.includes(q) || (a.email||'').toLowerCase().includes(q) || (a.phone_number||'').includes(q);
        const matchRole = !roleF   || a.role === roleF;
        const matchSt   = !statusF || a._status === statusF;
        return matchQ && matchRole && matchSt;
      });

      currentPage = 1;
      renderTable();
    }

    // ── RENDER ───────────────────────────────────────────────────────
    const fmtDate = iso => iso
      ? new Date(iso).toLocaleDateString('en-PH', { year:'numeric', month:'short', day:'numeric' })
      : '—';

    const initials = a => {
      const p = [a.first_name, a.last_name].filter(Boolean);
      return p.map(x => x[0].toUpperCase()).join('') || (a.email||'?')[0].toUpperCase();
    };

    const displayName = a =>
      [a.first_name, a.middle_name, a.last_name].filter(Boolean).join(' ') || a.email || '—';

    function renderTable() {
      const tbody = document.getElementById('accountsBody');
      const total = filtered.length;
      const start = (currentPage - 1) * PER_PAGE;
      const page  = filtered.slice(start, start + PER_PAGE);

      if (!page.length) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="table-empty">
          <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <p>No accounts found</p><span>Try adjusting your search or filters.</span>
        </div></td></tr>`;
      } else {
        tbody.innerHTML = page.map(a => {
          const avClass    = a.role === 'admin' ? 'avatar-admin' : 'avatar-staff';
          const roleBadge  = a.role === 'admin' ? 'badge-admin'  : 'badge-staff';
          const roleLabel  = a.role === 'admin' ? 'Admin'        : 'Staff';
          const stBadge    = { active:'badge-active', inactive:'badge-inactive', locked:'badge-locked' }[a._status] || 'badge-inactive';
          const stLabel    = a._status.charAt(0).toUpperCase() + a._status.slice(1);
          const lockTitle  = a._status === 'locked' ? 'Unlock Account' : 'Lock Account';
          return `<tr>
            <td>
              <div class="user-cell">
                <div class="avatar ${avClass}">${initials(a)}</div>
                <div>
                  <div class="user-name">${displayName(a)}</div>
                  <div class="user-email">${a.email||'—'}</div>
                </div>
              </div>
            </td>
            <td>
              <div class="contact-primary">${a.phone_number||'—'}</div>
              <div class="contact-secondary">${a.email||''}</div>
            </td>
            <td><span class="badge ${roleBadge}">${roleLabel}${a.staff_role ? ` · ${a.staff_role}` : ''}</span></td>
            <td><span class="badge ${stBadge}">${stLabel}</span></td>
            <td style="font-size:12.5px;color:var(--muted);">${a.last_sign_in_at ? fmtDate(a.last_sign_in_at) : '—'}</td>
            <td style="font-size:12.5px;color:var(--muted);">${a._activity||'No recent activity'}</td>
            <td style="font-size:12.5px;color:var(--muted);">${fmtDate(a.date_registered)}</td>
            <td>
              <div class="actions-cell">
                <button type="button" class="btn-outline-sm" data-action="view"   data-uid="${a.user_id}">
                  <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  View
                </button>
                <button type="button" class="btn-icon"       data-action="lock"   data-uid="${a.user_id}" title="${lockTitle}">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </button>
                <!-- <button type="button" class="btn-icon danger" data-action="delete" data-uid="${a.user_id}" title="Delete Account">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button> -->
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

    // ── TABLE ACTIONS ────────────────────────────────────────────────
    document.getElementById('accountsBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const a = allAccounts.find(x => x.user_id === btn.dataset.uid);
      if (!a) return;
      if (btn.dataset.action === 'view')   openEditModal(a);
      if (btn.dataset.action === 'lock')   openLockConfirm(a);
      //if (btn.dataset.action === 'delete') openDeleteConfirm(a);
    });

    // ── FILTER EVENTS ────────────────────────────────────────────────
    document.getElementById('searchInput').addEventListener('input',  applyFilters);
    document.getElementById('roleFilter').addEventListener('change',  applyFilters);
    document.getElementById('statusFilter').addEventListener('change', applyFilters);
    document.getElementById('refreshBtn').addEventListener('click',   loadAccounts);

    // ── ADD MODAL ────────────────────────────────────────────────────
    document.getElementById('addAccountBtn').addEventListener('click', openAddModal);

    function openAddModal() {
      document.getElementById('accountModalTitle').textContent = 'Add Account';
      document.getElementById('accountModalSub').textContent   = 'Create a new admin or staff portal account';
      document.getElementById('accountModalTabs').style.display = 'none';
      document.getElementById('addModeExtra').style.display     = 'block';
      document.getElementById('tab-info').classList.add('active');
      ['tab-access','tab-activity'].forEach(id => document.getElementById(id).classList.remove('active'));

      clearFields(['fieldFirstName','fieldMiddleName','fieldLastName','fieldPhone','fieldEmail','fieldPassword','fieldPasswordConfirm','addFieldStaffRole']);
      document.getElementById('addFieldRole').value   = 'admin';
      document.getElementById('fieldEmail').readOnly  = false;
      document.getElementById('fieldEmailHint').style.display = 'none';
      hideMsg();

      document.getElementById('accountModalSave').onclick = handleCreateAccount;
      document.getElementById('accountModalSave').innerHTML =
        '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Create Account';

      document.getElementById('accountModal')._current = null;
      document.getElementById('accountModal').classList.remove('hidden');
    }

    // ── EDIT MODAL ───────────────────────────────────────────────────
    function openEditModal(a) {
      document.getElementById('accountModalTitle').textContent = 'Edit Account';
      document.getElementById('accountModalSub').textContent   = displayName(a);
      document.getElementById('accountModalTabs').style.display = 'flex';
      document.getElementById('addModeExtra').style.display     = 'none';
      switchTab('info');

      document.getElementById('fieldFirstName').value  = a.first_name  || '';
      document.getElementById('fieldMiddleName').value = a.middle_name || '';
      document.getElementById('fieldLastName').value   = a.last_name   || '';
      document.getElementById('fieldPhone').value      = a.phone_number || '';
      document.getElementById('fieldEmail').value      = a.email || '';
      document.getElementById('fieldEmail').readOnly   = true;
      document.getElementById('fieldEmailHint').style.display = 'block';

      document.getElementById('fieldRole').value      = a.role || 'admin';
      document.getElementById('fieldStaffRole').value = a.staff_role || '';
      document.getElementById('fieldStatus').value    = a._status || 'active';

      document.getElementById('viewDateRegistered').textContent = fmtDate(a.date_registered);
      document.getElementById('viewLastSignIn').textContent     = a.last_sign_in_at ? fmtDate(a.last_sign_in_at) : '—';
      document.getElementById('viewRole').textContent           = a.role === 'admin' ? 'Admin' : 'Staff';
      document.getElementById('viewStaffRole').textContent      = a.staff_role || '—';

      hideMsg();
      document.getElementById('accountModalSave').onclick = () => handleUpdateAccount(a);
      document.getElementById('accountModalSave').innerHTML =
        '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Save Changes';

      document.getElementById('accountModal')._current = a;
      document.getElementById('accountModal').classList.remove('hidden');
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
      const phone      = v('fieldPhone');
      const role       = document.getElementById('addFieldRole').value;
      const staffRole  = v('addFieldStaffRole');
      const password   = document.getElementById('fieldPassword').value;
      const confirm    = document.getElementById('fieldPasswordConfirm').value;

      if (!firstName || !lastName) { showMsg('First and last name are required.', 'error'); return; }
      if (!email)    { showMsg('Email address is required.', 'error'); return; }
      if (!password) { showMsg('Password is required.', 'error'); return; }
      if (password.length < 8) { showMsg('Password must be at least 8 characters.', 'error'); return; }
      if (password !== confirm) { showMsg('Passwords do not match.', 'error'); return; }

      showMsg('Creating account…', 'info');
      disableSave(true);

      try {
        const { data: authData, error: authErr } = await supabase.auth.signUp({ email, password });
        if (authErr) throw authErr;

        const userId = authData.user?.id;
        if (!userId) throw new Error('Account was created but no user ID was returned.');

        const { error: profileErr } = await supabase.from('profiles').upsert({
          user_id: userId,
          first_name: firstName,
          middle_name: middleName || null,
          last_name: lastName,
          email,
          phone_number: phone || '',
          role,
          staff_role: staffRole || null,
          date_registered: new Date().toISOString()
        });

        if (profileErr) throw profileErr;

        showMsg('Account created successfully!', 'success');
        await loadAccounts();
        setTimeout(closeAccountModal, 1400);

      } catch (err) {
        showMsg(err.message || 'Failed to create account.', 'error');
      } finally {
        disableSave(false);
      }
    }

    // ── UPDATE ───────────────────────────────────────────────────────
    async function handleUpdateAccount(a) {
      const firstName  = v('fieldFirstName');
      const lastName   = v('fieldLastName');
      const middleName = v('fieldMiddleName');
      const phone      = v('fieldPhone');
      const role       = document.getElementById('fieldRole').value;
      const staffRole  = v('fieldStaffRole');
      const status     = document.getElementById('fieldStatus').value;

      if (!firstName || !lastName) { showMsg('First and last name are required.', 'error'); return; }

      showMsg('Saving changes…', 'info');
      disableSave(true);

      try {
        const { error } = await supabase.from('profiles').update({
          first_name: firstName,
          middle_name: middleName || null,
          last_name: lastName,
          phone_number: phone || '',
          role,
          staff_role: staffRole || null
        }).eq('user_id', a.user_id);

        if (error) throw error;

        statusMap[a.user_id] = status;
        const idx = allAccounts.findIndex(x => x.user_id === a.user_id);
        if (idx !== -1) {
          allAccounts[idx] = { ...allAccounts[idx], first_name: firstName, middle_name: middleName,
            last_name: lastName, phone_number: phone, role, staff_role: staffRole, _status: status };
        }

        showMsg('Changes saved successfully.', 'success');
        updateStats();
        applyFilters();

      } catch (err) {
        showMsg(err.message || 'Failed to save changes.', 'error');
      } finally {
        disableSave(false);
      }
    }

    // ── PASSWORD RESET ───────────────────────────────────────────────
    document.getElementById('sendPasswordResetBtn').addEventListener('click', async () => {
      const a = document.getElementById('accountModal')._current;
      if (!a?.email) return;
      showMsg('Sending password reset email…', 'info');
      const { error } = await supabase.auth.resetPasswordForEmail(a.email);
      if (error) showMsg('Failed: ' + error.message, 'error');
      else       showMsg(`Password reset email sent to ${a.email}.`, 'success');
    });

    // ── LOCK ─────────────────────────────────────────────────────────
    function openLockConfirm(a) {
      const isLocked = a._status === 'locked';
      document.getElementById('confirmTitle').textContent = isLocked ? 'Unlock Account' : 'Lock Account';
      document.getElementById('confirmSub').textContent   = displayName(a);
      document.getElementById('confirmBody').textContent  = isLocked
        ? `This will restore portal access for ${displayName(a)}.`
        : `This will prevent ${displayName(a)} from signing in until unlocked.`;
      document.getElementById('confirmOk').onclick = async () => {
      const newStatus = isLocked ? false : true;

      // UPDATE DATABASE
      const { error } = await supabase
        .from('profiles')
        .update({ is_locked: newStatus })
        .eq('user_id', a.user_id);

      if (error) {
        alert('Failed to update lock status: ' + error.message);
        return;
      }

      // update UI
      statusMap[a.user_id] = newStatus ? 'locked' : 'active';
      const idx = allAccounts.findIndex(x => x.user_id === a.user_id);
      if (idx !== -1) allAccounts[idx]._status = statusMap[a.user_id];

      //updateStats();
      applyFilters();
      closeConfirmModal();
    };
      document.getElementById('confirmModal').classList.remove('hidden');
    }

    // ── DELETE ───────────────────────────────────────────────────────
    /*function openDeleteConfirm(a) {
      document.getElementById('confirmTitle').textContent = 'Delete Account';
      document.getElementById('confirmSub').textContent   = displayName(a);
      document.getElementById('confirmBody').textContent  =
        `This will permanently delete ${displayName(a)}'s profile. This action cannot be undone.`;
      document.getElementById('confirmOk').textContent = 'Delete Account';
      document.getElementById('confirmMsg').className = 'modal-message hidden';

      document.getElementById('confirmOk').onclick = async () => {
        const msg = document.getElementById('confirmMsg');
        msg.className = 'modal-message info'; msg.textContent = 'Deleting…';

        const { error } = await supabase.from('profiles').delete().eq('user_id', a.user_id);
        if (error) { msg.className = 'modal-message'; msg.textContent = error.message; return; }

        allAccounts = allAccounts.filter(x => x.user_id !== a.user_id);
        updateStats(); applyFilters();
        closeConfirmModal();
      };

      document.getElementById('confirmModal').classList.remove('hidden');
    }*/

    // ── HELPERS ──────────────────────────────────────────────────────
    const closeAccountModal = () => document.getElementById('accountModal').classList.add('hidden');
    const closeConfirmModal  = () => document.getElementById('confirmModal').classList.add('hidden');

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

    ['accountModal','confirmModal'].forEach(id => {
      document.getElementById(id).addEventListener('click', e => {
        if (e.target.id === id) {
          id === 'accountModal' ? closeAccountModal() : closeConfirmModal();
        }
      });
    });

   

     // ── SESSION ──────────────────────────────────────────────────────
    async function init() {
    const result = await validateAdminSession({ fallbackLabel: 'Super Admin' });
    if (!result) return;

    watchAuthState();
    wireLogoutButton();
    setupInactivityLogout();
    initAdminSidebarBadges(supabase);
    loadAccounts();
    }

    init();