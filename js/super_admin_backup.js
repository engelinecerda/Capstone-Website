// super_admin_backup.js
// Demo data is used for display. Wire up real Supabase/backend calls where noted.

// ─── Imports (uncomment when integrating) ────────────────────────────────────
// import { portalSupabase as supabase } from './supabase.js';
// import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
// import { setupInactivityLogout } from './super_admin_inactivity.js';

// ─── Demo backup history ──────────────────────────────────────────────────────
let backupHistory = [
  {
    backup_id: 'BKP-001',
    name: 'Full System Backup - Mar 11, 2026',
    date: 'March 11, 2026 2:00 AM',
    size: '2.4 GB',
    type: 'Automatic',
    status: 'completed'
  },
  {
    backup_id: 'BKP-002',
    name: 'Full System Backup - Mar 10, 2026',
    date: 'March 10, 2026 2:00 AM',
    size: '2.3 GB',
    type: 'Automatic',
    status: 'completed'
  },
  {
    backup_id: 'BKP-003',
    name: 'Manual Backup - Mar 8, 2026',
    date: 'March 8, 2026 4:30 PM',
    size: '2.2 GB',
    type: 'Manual',
    status: 'completed'
  }
];

let settings = {
  retentionDays: 30,
  storageLocation: 'Cloud Storage (Azure)'
};

let pendingRestoreId = null;
let pendingSettingsAction = null; // 'retention' | 'storage'

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const createBackupBtn      = document.getElementById('createBackupBtn');
const restoreSystemBtn     = document.getElementById('restoreSystemBtn');
const pageMessage          = document.getElementById('pageMessage');
const lastBackupDate       = document.getElementById('lastBackupDate');
const lastBackupStatus     = document.getElementById('lastBackupStatus');
const totalBackups         = document.getElementById('totalBackups');
const totalSize            = document.getElementById('totalSize');
const storageLocation      = document.getElementById('storageLocation');
const storageLocationSetting = document.getElementById('storageLocationSetting');
const historyList          = document.getElementById('historyList');
const emptyHistory         = document.getElementById('emptyHistory');
const configureRetentionBtn= document.getElementById('configureRetentionBtn');
const changeStorageBtn     = document.getElementById('changeStorageBtn');

// Confirm backup modal
const confirmBackupModal   = document.getElementById('confirmBackupModal');
const confirmBackupClose   = document.getElementById('confirmBackupClose');
const confirmBackupCancel  = document.getElementById('confirmBackupCancel');
const confirmBackupOk      = document.getElementById('confirmBackupOk');
const confirmBackupMessage = document.getElementById('confirmBackupMessage');

// Restore modal
const restoreModal         = document.getElementById('restoreModal');
const restoreModalSub      = document.getElementById('restoreModalSub');
const restoreCopy          = document.getElementById('restoreCopy');
const restoreClose         = document.getElementById('restoreClose');
const restoreCancel        = document.getElementById('restoreCancel');
const restoreOk            = document.getElementById('restoreOk');
const restoreMessage       = document.getElementById('restoreMessage');

// Settings modal
const settingsModal        = document.getElementById('settingsModal');
const settingsModalTitle   = document.getElementById('settingsModalTitle');
const settingsModalBody    = document.getElementById('settingsModalBody');
const settingsClose        = document.getElementById('settingsClose');
const settingsCancel       = document.getElementById('settingsCancel');
const settingsSave         = document.getElementById('settingsSave');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function setPageMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className = 'page-message' + (type ? ` ${type}` : '');
}

function setModalMessage(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `modal-message ${type}`;
}

function openModal(modal) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// ─── Status card ──────────────────────────────────────────────────────────────
function updateStatusCard() {
  const completed = backupHistory.filter(b => b.status === 'completed');
  const latest    = completed[0];

  if (latest) {
    lastBackupDate.textContent = latest.date;
  } else {
    lastBackupDate.textContent = 'No backups yet';
    lastBackupStatus.style.display = 'none';
  }

  totalBackups.textContent = `${backupHistory.length} backup${backupHistory.length !== 1 ? 's' : ''}`;

  const totalGB = backupHistory.reduce((sum, b) => {
    const gb = parseFloat(b.size) || 0;
    return sum + gb;
  }, 0);
  totalSize.textContent = `~${totalGB.toFixed(1)} GB total size`;

  storageLocation.textContent    = settings.storageLocation;
  storageLocationSetting.textContent = settings.storageLocation;
}

// ─── History list ─────────────────────────────────────────────────────────────
function renderHistory() {
  if (!backupHistory.length) {
    historyList.innerHTML = '';
    emptyHistory.classList.remove('hidden');
    return;
  }

  emptyHistory.classList.add('hidden');

  historyList.innerHTML = backupHistory.map(b => `
    <div class="history-row">
      <div class="history-left">
        <div class="history-icon">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        </div>
        <div>
          <div class="history-name">${escapeHtml(b.name)}</div>
          <div class="history-meta">${escapeHtml(b.date)} · ${escapeHtml(b.size)} · ${escapeHtml(b.type)}</div>
        </div>
      </div>
      <div class="history-right">
        <span class="completed-badge">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          completed
        </span>
        <button class="history-btn" data-action="download" data-id="${escapeHtml(b.backup_id)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
        <button class="history-btn restore-btn" data-action="restore" data-id="${escapeHtml(b.backup_id)}" data-name="${escapeHtml(b.name)}" data-date="${escapeHtml(b.date)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Restore
        </button>
      </div>
    </div>
  `).join('');
}

// ─── History click delegation ─────────────────────────────────────────────────
historyList.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action = btn.dataset.action;
  const id     = btn.dataset.id;

  if (action === 'download') {
    handleDownload(id);
  }

  if (action === 'restore') {
    const name = btn.dataset.name;
    const date = btn.dataset.date;
    openRestoreModal(id, name, date);
  }
});

// ─── Create backup ────────────────────────────────────────────────────────────
createBackupBtn.addEventListener('click', () => {
  setModalMessage(confirmBackupMessage, '');
  openModal(confirmBackupModal);
});

confirmBackupOk.addEventListener('click', async () => {
  confirmBackupOk.disabled = true;
  confirmBackupOk.textContent = 'Creating backup...';
  setModalMessage(confirmBackupMessage, '');

  try {
    // ── Real integration: call your backend or Supabase Edge Function ──
    // const { data, error } = await supabase.functions.invoke('create-backup');
    // if (error) throw error;

    // Simulate async work
    await new Promise(r => setTimeout(r, 1200));

    const now = new Date();
    const label = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const newBackup = {
      backup_id: `BKP-${String(Date.now()).slice(-6)}`,
      name: `Manual Backup - ${label}`,
      date: now.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      size: '2.4 GB',
      type: 'Manual',
      status: 'completed'
    };

    backupHistory.unshift(newBackup);
    renderHistory();
    updateStatusCard();
    closeModal(confirmBackupModal);
    setPageMessage('Backup created successfully.', 'success');
  } catch (err) {
    setModalMessage(confirmBackupMessage, `Failed to create backup: ${err.message}`);
  } finally {
    confirmBackupOk.disabled = false;
    confirmBackupOk.innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg> Start Backup`;
  }
});

// "Restore Database" top button — opens restore modal without a specific backup selected
restoreSystemBtn.addEventListener('click', () => {
  if (!backupHistory.length) {
    setPageMessage('No backups available to restore from.', 'error');
    return;
  }
  const latest = backupHistory[0];
  openRestoreModal(latest.backup_id, latest.name, latest.date);
});

// ─── Restore ──────────────────────────────────────────────────────────────────
function openRestoreModal(backupId, name, date) {
  pendingRestoreId = backupId;
  restoreModalSub.textContent = name;
  restoreCopy.textContent = `You are about to restore the system from the backup created on ${date}. All current data will be replaced.`;
  setModalMessage(restoreMessage, '');
  restoreOk.disabled = false;
  restoreOk.textContent = 'Restore Now';
  openModal(restoreModal);
}

restoreOk.addEventListener('click', async () => {
  if (!pendingRestoreId) return;
  restoreOk.disabled = true;
  restoreOk.textContent = 'Restoring...';
  setModalMessage(restoreMessage, '');

  try {
    // ── Real integration ──
    // const { error } = await supabase.functions.invoke('restore-backup', { body: { backupId: pendingRestoreId } });
    // if (error) throw error;

    await new Promise(r => setTimeout(r, 1400));

    closeModal(restoreModal);
    setPageMessage('System restored successfully from the selected backup.', 'success');
  } catch (err) {
    setModalMessage(restoreMessage, `Restore failed: ${err.message}`);
    restoreOk.disabled = false;
    restoreOk.textContent = 'Restore Now';
  }
});

// ─── Download ─────────────────────────────────────────────────────────────────
function handleDownload(backupId) {
  // Real integration: generate a signed download URL from your backend
  // const { data } = await supabase.storage.from('backups').createSignedUrl(backupId, 60);
  // window.open(data.signedUrl, '_blank');
  setPageMessage(`Download started for backup ${backupId}.`, 'success');
  setTimeout(() => setPageMessage(''), 3000);
}

// ─── Settings ─────────────────────────────────────────────────────────────────
configureRetentionBtn.addEventListener('click', () => {
  pendingSettingsAction = 'retention';
  settingsModalTitle.textContent = 'Configure Backup Retention';
  settingsModalBody.innerHTML = `
    <div class="modal-field">
      <label class="modal-label" for="retentionInput">Retain backups for (days)</label>
      <input type="number" id="retentionInput" class="modal-input" min="1" max="365" value="${settings.retentionDays}">
    </div>
  `;
  openModal(settingsModal);
});

changeStorageBtn.addEventListener('click', () => {
  pendingSettingsAction = 'storage';
  settingsModalTitle.textContent = 'Change Storage Location';
  settingsModalBody.innerHTML = `
    <div class="modal-field">
      <label class="modal-label" for="storageInput">Storage location</label>
      <select id="storageInput" class="modal-input modal-select">
        <option value="Cloud Storage (Azure)"  ${settings.storageLocation === 'Cloud Storage (Azure)'  ? 'selected' : ''}>Cloud Storage (Azure)</option>
        <option value="Cloud Storage (AWS S3)" ${settings.storageLocation === 'Cloud Storage (AWS S3)' ? 'selected' : ''}>Cloud Storage (AWS S3)</option>
        <option value="Cloud Storage (GCP)"    ${settings.storageLocation === 'Cloud Storage (GCP)'    ? 'selected' : ''}>Cloud Storage (GCP)</option>
        <option value="Local Storage"          ${settings.storageLocation === 'Local Storage'          ? 'selected' : ''}>Local Storage</option>
      </select>
    </div>
  `;
  openModal(settingsModal);
});

settingsSave.addEventListener('click', () => {
  if (pendingSettingsAction === 'retention') {
    const val = parseInt(document.getElementById('retentionInput')?.value, 10);
    if (!val || val < 1) {
      setPageMessage('Please enter a valid retention period.', 'error');
      return;
    }
    settings.retentionDays = val;
    document.querySelector('.settings-row:first-child .settings-row-sub').textContent = `Keep backups for ${val} days`;
    setPageMessage('Retention period updated.', 'success');
  }

  if (pendingSettingsAction === 'storage') {
    const val = document.getElementById('storageInput')?.value;
    if (val) {
      settings.storageLocation = val;
      updateStatusCard();
      setPageMessage('Storage location updated.', 'success');
    }
  }

  closeModal(settingsModal);
  setTimeout(() => setPageMessage(''), 3000);
});

// ─── Modal close wiring ───────────────────────────────────────────────────────
confirmBackupClose.addEventListener('click',  () => closeModal(confirmBackupModal));
confirmBackupCancel.addEventListener('click', () => closeModal(confirmBackupModal));
restoreClose.addEventListener('click',   () => closeModal(restoreModal));
restoreCancel.addEventListener('click',  () => closeModal(restoreModal));
settingsClose.addEventListener('click',  () => closeModal(settingsModal));
settingsCancel.addEventListener('click', () => closeModal(settingsModal));

confirmBackupModal.addEventListener('click', e => { if (e.target === confirmBackupModal) closeModal(confirmBackupModal); });
restoreModal.addEventListener('click',       e => { if (e.target === restoreModal)       closeModal(restoreModal); });
settingsModal.addEventListener('click',      e => { if (e.target === settingsModal)      closeModal(settingsModal); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!confirmBackupModal.classList.contains('hidden')) closeModal(confirmBackupModal);
  if (!restoreModal.classList.contains('hidden'))       closeModal(restoreModal);
  if (!settingsModal.classList.contains('hidden'))      closeModal(settingsModal);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  // ── Auth (uncomment when integrating) ──
  // wireLogoutButton('logoutBtn');
  // watchAuthState();
  // validateAdminSession({
  //   onSuccess: ({ session, profile }) => {
  //     setupInactivityLogout(profile.role);
  //     loadBackupsFromSupabase();
  //   }
  // });

  updateStatusCard();
  renderHistory();
}

// ─── Supabase stub ────────────────────────────────────────────────────────────
// async function loadBackupsFromSupabase() {
//   const { data, error } = await supabase
//     .from('system_backups')
//     .select('*')
//     .order('created_at', { ascending: false });
//   if (error) { setPageMessage(`Failed to load backups: ${error.message}`, 'error'); return; }
//   backupHistory = data || [];
//   updateStatusCard();
//   renderHistory();
// }

init();
