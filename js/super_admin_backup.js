// super_admin_backup.js
// Backup: reads all Supabase tables → bundles into JSON → uploads to Google Drive
// Restore: lists JSON files from Google Drive → lets user pick → upserts back into Supabase
//
// SETUP REQUIRED:
//   1. Go to console.cloud.google.com → create a project → enable "Google Drive API"
//   2. Create OAuth 2.0 credentials (Web Application)
//      - Authorised JavaScript origins: your site's origin (e.g. https://yoursite.com)
//      - Authorised redirect URIs: same origin
//   3. Replace GOOGLE_CLIENT_ID below with your OAuth Client ID
//   4. The Google Identity Services (GIS) script is loaded in the HTML

import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

// ─── Google Drive config ──────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID   = '840885111053-9o5sunpcth34kfv4c1fc74fp0h9nn2ub.apps.googleusercontent.com'; // ← replace
const DRIVE_FOLDER_NAME  = 'ELI Coffee Backups';   // folder created automatically in Drive
const DRIVE_SCOPE        = 'https://www.googleapis.com/auth/drive.file'; // only files this app creates

// ─── All tables to back up (in dependency order for safe restore) ─────────────
const BACKUP_TABLES = [
  'profiles',
  'package',
  'contract_templates',
  'reservations',
  'reservation_contracts',
  'reservation_staff_assignments',
  'reservation_status',
  'payment',
  'receipts',
  'reschedule_requests',
  'cancellation',
  'calendar_blackouts',
  'reservation_forecast',
  'reviews',
];

// ─── State ────────────────────────────────────────────────────────────────────
let driveAccessToken   = null;   // set after Google OAuth
let driveFolderId      = null;   // resolved once after auth
let backupHistory      = [];     // loaded from Drive file list
let pendingRestoreFile = null;   // { id, name } of the Drive file chosen
let pendingSettingsAction = null;
let settings = { retentionDays: 30 };
let currentAdminId = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const pageMessage            = document.getElementById('pageMessage');
const createBackupBtn        = document.getElementById('createBackupBtn');
const restoreSystemBtn       = document.getElementById('restoreSystemBtn');
const lastBackupDate         = document.getElementById('lastBackupDate');
const lastBackupStatus       = document.getElementById('lastBackupStatus');
const totalBackupsEl         = document.getElementById('totalBackups');
const totalSizeEl            = document.getElementById('totalSize');
const storageLocationEl      = document.getElementById('storageLocation');
const historyList            = document.getElementById('historyList');
const emptyHistory           = document.getElementById('emptyHistory');
const configureRetentionBtn  = document.getElementById('configureRetentionBtn');
const googleAuthBtn          = document.getElementById('googleAuthBtn');
const googleAuthStatus       = document.getElementById('googleAuthStatus');

// Confirm backup modal
const confirmBackupModal     = document.getElementById('confirmBackupModal');
const confirmBackupClose     = document.getElementById('confirmBackupClose');
const confirmBackupCancel    = document.getElementById('confirmBackupCancel');
const confirmBackupOk        = document.getElementById('confirmBackupOk');
const confirmBackupMessage   = document.getElementById('confirmBackupMessage');
const backupProgressWrap     = document.getElementById('backupProgressWrap');
const backupProgressBar      = document.getElementById('backupProgressBar');
const backupProgressLabel    = document.getElementById('backupProgressLabel');

// Restore modal
const restoreModal           = document.getElementById('restoreModal');
const restoreModalSub        = document.getElementById('restoreModalSub');
const restoreCopy            = document.getElementById('restoreCopy');
const restoreClose           = document.getElementById('restoreClose');
const restoreCancel          = document.getElementById('restoreCancel');
const restoreOk              = document.getElementById('restoreOk');
const restoreMessage         = document.getElementById('restoreMessage');
const restoreProgressWrap    = document.getElementById('restoreProgressWrap');
const restoreProgressBar     = document.getElementById('restoreProgressBar');
const restoreProgressLabel   = document.getElementById('restoreProgressLabel');

// Settings modal
const settingsModal          = document.getElementById('settingsModal');
const settingsModalTitle     = document.getElementById('settingsModalTitle');
const settingsModalBody      = document.getElementById('settingsModalBody');
const settingsClose          = document.getElementById('settingsClose');
const settingsCancel         = document.getElementById('settingsCancel');
const settingsSave           = document.getElementById('settingsSave');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function setPageMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => setPageMessage(''), 5000);
}

function setModalMsg(el, msg, type = 'error') {
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

function formatBytes(bytes) {
  if (!bytes) return '—';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function formatDriveDate(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function setProgress(bar, label, wrap, percent, text) {
  wrap.classList.remove('hidden');
  bar.style.width = `${percent}%`;
  label.textContent = text;
  // Update the percentage counter next to the label (sibling .progress-pct)
  const pctEl = wrap.querySelector('.progress-pct');
  if (pctEl) pctEl.textContent = `${percent}%`;
}

function hideProgress(wrap) {
  wrap.classList.add('hidden');
}

// ─── Google OAuth (GIS token flow) ───────────────────────────────────────────
function initGoogleAuth() {
  // GIS tokenClient — requests an access token without redirect
  window._tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: async (response) => {
      if (response.error) {
        setPageMessage(`Google sign-in failed: ${response.error}`, 'error');
        return;
      }
      driveAccessToken = response.access_token;
      localStorage.setItem('drive_token', driveAccessToken);
      googleAuthBtn.textContent = 'Google Drive Connected';
      googleAuthBtn.disabled = true;
      googleAuthStatus.textContent = 'Connected — backups will be saved to your Drive';
      googleAuthStatus.className = 'auth-status success';
      createBackupBtn.disabled = false;
      restoreSystemBtn.disabled = false;
      await resolveDriveFolder();
      await loadBackupHistory();
    }
  });
}

function requestGoogleToken() {
  if (!window.google?.accounts?.oauth2) {
    setPageMessage('Google Identity Services not loaded. Check your internet connection.', 'error');
    return;
  }
  window._tokenClient.requestAccessToken({ prompt: 'consent' });
}

googleAuthBtn?.addEventListener('click', requestGoogleToken);

// ─── Drive folder helpers ─────────────────────────────────────────────────────
async function driveRequest(path, options = {}) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${driveAccessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Drive API error (${res.status})`);
  }
  return res.json();
}

async function resolveDriveFolder() {
  // Check if folder already exists
  const search = await driveRequest(
    `files?q=name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`
  );

  if (search.files?.length) {
    driveFolderId = search.files[0].id;
    return;
  }

  // Create folder
  const created = await driveRequest('files', {
    method: 'POST',
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });
  driveFolderId = created.id;
}

// ─── Load backup history from Drive ──────────────────────────────────────────
async function loadBackupHistory() {
  if (!driveAccessToken || !driveFolderId) return;

  setPageMessage('Loading backup history…');

  try {
    const res = await driveRequest(
      `files?q='${driveFolderId}' in parents and mimeType='application/json' and trashed=false` +
      `&fields=files(id,name,size,createdTime,description)&orderBy=createdTime desc`
    );

    backupHistory = res.files || [];
    renderHistory();
    updateStatusCard();
    setPageMessage('');
  } catch (err) {
    setPageMessage(`Failed to load backup history: ${err.message}`, 'error');
    renderHistory();
  }
}

// ─── Read all Supabase tables ─────────────────────────────────────────────────
async function readAllTables(onProgress) {
  const snapshot = {};

  for (let i = 0; i < BACKUP_TABLES.length; i++) {
    const table = BACKUP_TABLES[i];
    const percent = Math.round(((i) / BACKUP_TABLES.length) * 70); // 0–70%
    onProgress(percent, `Reading ${table}…`);

    const { data, error } = await supabase.from(table).select('*');
    if (error) throw new Error(`Failed to read table "${table}": ${error.message}`);
    snapshot[table] = data || [];
  }

  return snapshot;
}

// ─── Upload JSON to Google Drive ──────────────────────────────────────────────
async function uploadToDrive(filename, jsonContent, description, onProgress) {
  onProgress(75, 'Uploading to Google Drive…');

  const blob = new Blob([jsonContent], { type: 'application/json' });

  // Multipart upload: metadata + file body in one request
  const boundary = '-------ELICoffeeBackup';
  const metadata = JSON.stringify({
    name: filename,
    description,
    parents: [driveFolderId],
    mimeType: 'application/json'
  });

  const multipart = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonContent}\r\n`,
    `--${boundary}--`
  ].join('');

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${driveAccessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: multipart
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Drive upload failed (${res.status})`);
  }

  onProgress(95, 'Finalising…');
  return res.json();
}

// ─── Create backup ────────────────────────────────────────────────────────────
createBackupBtn?.addEventListener('click', () => {
  if (!driveAccessToken) {
    setPageMessage('Connect Google Drive first before creating a backup.', 'error');
    return;
  }
  setModalMsg(confirmBackupMessage, '');
  hideProgress(backupProgressWrap);
  openModal(confirmBackupModal);
});

confirmBackupOk?.addEventListener('click', async () => {
  confirmBackupOk.disabled = true;
  confirmBackupCancel.disabled = true;
  setModalMsg(confirmBackupMessage, '');

  const onProgress = (pct, text) => setProgress(backupProgressBar, backupProgressLabel, backupProgressWrap, pct, text);

  try {
    // 1. Read all tables
    const snapshot = await readAllTables(onProgress);

    // 2. Build JSON bundle
    onProgress(72, 'Building backup file…');
    const now = new Date();
    const bundle = {
      meta: {
        created_at: now.toISOString(),
        created_by: currentAdminId,
        tables: BACKUP_TABLES,
        table_counts: Object.fromEntries(
          BACKUP_TABLES.map(t => [t, snapshot[t]?.length ?? 0])
        ),
        version: '1.0'
      },
      data: snapshot
    };

    const jsonContent = JSON.stringify(bundle, null, 2);
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5).replace(':', '-'); // HH-MM
    const filename = `eli_backup_${dateStr}_${timeStr}.json`;
    const description = `Manual backup — ${now.toLocaleString('en-PH')}`;

    // 3. Upload to Drive
    const uploaded = await uploadToDrive(filename, jsonContent, description, onProgress);
    onProgress(100, 'Done!');

    // 4. Refresh history
    await loadBackupHistory();
    closeModal(confirmBackupModal);
    setPageMessage(`Backup created and saved to Google Drive: ${uploaded.name}`, 'success');

  } catch (err) {
    setModalMsg(confirmBackupMessage, `Backup failed: ${err.message}`);
    hideProgress(backupProgressWrap);
  } finally {
    confirmBackupOk.disabled = false;
    confirmBackupCancel.disabled = false;
  }
});

// ─── Restore: open modal from history row ─────────────────────────────────────
restoreSystemBtn?.addEventListener('click', () => {
  if (!driveAccessToken) {
    setPageMessage('Connect Google Drive first before restoring.', 'error');
    return;
  }
  if (!backupHistory.length) {
    setPageMessage('No backups available to restore from.', 'error');
    return;
  }
  const latest = backupHistory[0];
  openRestoreModal(latest.id, latest.name, latest.createdTime);
});

function openRestoreModal(fileId, name, createdTime) {
  pendingRestoreFile = { id: fileId, name };
  restoreModalSub.textContent = name;
  restoreCopy.textContent = `Restoring from the backup created on ${formatDriveDate(createdTime)} will overwrite all current data in every table.`;
  setModalMsg(restoreMessage, '');
  hideProgress(restoreProgressWrap);
  restoreOk.disabled = false;
  restoreOk.textContent = 'Restore Now';
  openModal(restoreModal);
}

// ─── Restore: download from Drive and upsert ──────────────────────────────────
restoreOk?.addEventListener('click', async () => {
  if (!pendingRestoreFile) return;

  restoreOk.disabled = true;
  restoreCancel.disabled = true;
  setModalMsg(restoreMessage, '');

  const onProgress = (pct, text) => setProgress(restoreProgressBar, restoreProgressLabel, restoreProgressWrap, pct, text);

  try {
    // 1. Download the JSON file from Drive
    onProgress(5, 'Downloading backup from Google Drive…');
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${pendingRestoreFile.id}?alt=media`,
      { headers: { 'Authorization': `Bearer ${driveAccessToken}` } }
    );

    if (!res.ok) throw new Error(`Failed to download backup (HTTP ${res.status})`);

    onProgress(20, 'Parsing backup file…');
    const bundle = await res.json();

    if (!bundle?.data || !bundle?.meta) {
      throw new Error('Invalid backup file format.');
    }

    const { data } = bundle;

    // 2. Upsert each table in dependency order
    const tables = bundle.meta.tables || BACKUP_TABLES;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows  = data[table];
      if (!rows?.length) continue;

      const pct = 20 + Math.round(((i + 1) / tables.length) * 75);
      onProgress(pct, `Restoring ${table} (${rows.length} rows)…`);

      // Upsert in batches of 500 to stay under Supabase row limits
      const BATCH = 500;
      for (let b = 0; b < rows.length; b += BATCH) {
        const chunk = rows.slice(b, b + BATCH);
        const { error } = await supabase
          .from(table)
          .upsert(chunk, { onConflict: getPrimaryKey(table) });

        if (error) throw new Error(`Failed to restore table "${table}": ${error.message}`);
      }
    }

    onProgress(100, 'Restore complete!');
    setTimeout(() => {
      closeModal(restoreModal);
      setPageMessage('System restored successfully from the selected backup.', 'success');
    }, 800);

  } catch (err) {
    setModalMsg(restoreMessage, `Restore failed: ${err.message}`);
    hideProgress(restoreProgressWrap);
    restoreOk.disabled = false;
    restoreOk.textContent = 'Restore Now';
  } finally {
    restoreCancel.disabled = false;
  }
});

// Primary key map for upsert conflict resolution
function getPrimaryKey(table) {
  const keys = {
    profiles:                    'user_id',
    package:                     'package_id',
    contract_templates:          'template_id',
    reservations:                'reservation_id',
    reservation_contracts:       'reservation_contract_id',
    reservation_staff_assignments: 'assignment_id',
    reservation_status:          'status_id',
    payment:                     'payment_id',
    receipts:                    'receipt_id',
    reschedule_requests:         'reschedule_request_id',
    cancellation:                'cancellation_id',
    calendar_blackouts:          'blackout_id',
    reservation_forecast:        'forecast_id',
    reviews:                     'review_id',
  };
  return keys[table] || 'id';
}

// ─── Download backup file ─────────────────────────────────────────────────────
async function handleDownload(fileId, filename) {
  if (!driveAccessToken) return;
  try {
    setPageMessage('Preparing download…');
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { 'Authorization': `Bearer ${driveAccessToken}` } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setPageMessage('Download started.', 'success');
  } catch (err) {
    setPageMessage(`Download failed: ${err.message}`, 'error');
  }
}

// ─── Delete backup from Drive ─────────────────────────────────────────────────
async function handleDelete(fileId, filename) {
  if (!confirm(`Delete "${filename}" from Google Drive? This cannot be undone.`)) return;
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${driveAccessToken}` }
    });
    setPageMessage('Backup deleted.', 'success');
    await loadBackupHistory();
  } catch (err) {
    setPageMessage(`Delete failed: ${err.message}`, 'error');
  }
}

// ─── Enforce retention policy ─────────────────────────────────────────────────
async function enforceRetention() {
  if (!driveAccessToken || !backupHistory.length) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.retentionDays);

  const expired = backupHistory.filter(b => new Date(b.createdTime) < cutoff);
  if (!expired.length) return;

  for (const file of expired) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${driveAccessToken}` }
    }).catch(() => {}); // silently ignore individual delete failures
  }

  if (expired.length) {
    await loadBackupHistory();
    setPageMessage(`Removed ${expired.length} expired backup(s) per retention policy.`, 'success');
  }
}

// ─── Status card ──────────────────────────────────────────────────────────────
function updateStatusCard() {
  const latest = backupHistory[0];

  if (latest) {
    lastBackupDate.textContent = formatDriveDate(latest.createdTime);
    lastBackupStatus.style.display = '';
  } else {
    lastBackupDate.textContent = 'No backups yet';
    lastBackupStatus.style.display = 'none';
  }

  totalBackupsEl.textContent = `${backupHistory.length} backup${backupHistory.length !== 1 ? 's' : ''}`;

  const totalBytes = backupHistory.reduce((sum, b) => sum + (parseInt(b.size) || 0), 0);
  totalSizeEl.textContent = totalBytes ? `~${formatBytes(totalBytes)} total size` : '— total size';

  storageLocationEl.textContent = 'Google Drive';
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
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
        </div>
        <div>
          <div class="history-name">${escapeHtml(b.name)}</div>
          <div class="history-meta">${escapeHtml(formatDriveDate(b.createdTime))} · ${escapeHtml(formatBytes(parseInt(b.size)))} · Google Drive</div>
        </div>
      </div>
      <div class="history-right">
        <span class="completed-badge">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          completed
        </span>
        <button class="history-btn" data-action="download" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
        <button class="history-btn restore-btn" data-action="restore" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}" data-date="${escapeHtml(b.createdTime)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
          </svg>
          Restore
        </button>
        <button class="history-btn delete-btn" data-action="delete" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
          Delete
        </button>
      </div>
    </div>
  `).join('');
}

// ─── History click delegation ─────────────────────────────────────────────────
historyList?.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, name, date } = btn.dataset;

  if (action === 'download') handleDownload(id, name);
  if (action === 'restore')  openRestoreModal(id, name, date);
  if (action === 'delete')   handleDelete(id, name);
});

// ─── Settings ─────────────────────────────────────────────────────────────────
configureRetentionBtn?.addEventListener('click', () => {
  pendingSettingsAction = 'retention';
  settingsModalTitle.textContent = 'Configure Backup Retention';
  settingsModalBody.innerHTML = `
    <div class="modal-field">
      <label class="modal-label" for="retentionInput">Retain backups for (days)</label>
      <input type="number" id="retentionInput" class="modal-input" min="1" max="365" value="${settings.retentionDays}">
      <span class="modal-hint">Backups older than this will be deleted from Google Drive when a new backup is created.</span>
    </div>
  `;
  openModal(settingsModal);
});

settingsSave?.addEventListener('click', async () => {
  if (pendingSettingsAction === 'retention') {
    const val = parseInt(document.getElementById('retentionInput')?.value, 10);
    if (!val || val < 1) { setPageMessage('Enter a valid number of days.', 'error'); return; }
    settings.retentionDays = val;
    document.querySelector('.settings-row .settings-row-sub').textContent = `Keep backups for ${val} days`;
    setPageMessage('Retention period updated.', 'success');
  }
  closeModal(settingsModal);
});

// ─── Modal close wiring ───────────────────────────────────────────────────────
confirmBackupClose?.addEventListener('click',  () => closeModal(confirmBackupModal));
confirmBackupCancel?.addEventListener('click', () => closeModal(confirmBackupModal));
restoreClose?.addEventListener('click',        () => closeModal(restoreModal));
restoreCancel?.addEventListener('click',       () => closeModal(restoreModal));
settingsClose?.addEventListener('click',       () => closeModal(settingsModal));
settingsCancel?.addEventListener('click',      () => closeModal(settingsModal));

confirmBackupModal?.addEventListener('click', e => { if (e.target === confirmBackupModal) closeModal(confirmBackupModal); });
restoreModal?.addEventListener('click',       e => { if (e.target === restoreModal)       closeModal(restoreModal); });
settingsModal?.addEventListener('click',      e => { if (e.target === settingsModal)      closeModal(settingsModal); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!confirmBackupModal?.classList.contains('hidden')) closeModal(confirmBackupModal);
  if (!restoreModal?.classList.contains('hidden'))       closeModal(restoreModal);
  if (!settingsModal?.classList.contains('hidden'))      closeModal(settingsModal);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  wireLogoutButton('logoutBtn');
  watchAuthState();

  validateAdminSession({
    onSuccess: async ({ session, profile }) => {
      currentAdminId = session.user.id;
      setupInactivityLogout(profile.role);
      initAdminSidebarBadges(supabase);

      // Disable buttons first
      createBackupBtn.disabled  = true;
      restoreSystemBtn.disabled = true;

      // Init Google OAuth
      if (window.google?.accounts?.oauth2) {
        initGoogleAuth();
      } else {
        window.addEventListener('load', initGoogleAuth);
      }
      const savedToken = localStorage.getItem('drive_token');

      if (savedToken) {
        driveAccessToken = savedToken;

        googleAuthBtn.textContent = 'Google Drive Connected';
        googleAuthBtn.disabled = true;
        googleAuthStatus.textContent = 'Connected — backups will be saved to your Drive';
        googleAuthStatus.className = 'auth-status success';

        createBackupBtn.disabled = false;
        restoreSystemBtn.disabled = false;

        await resolveDriveFolder();
        await loadBackupHistory();
      } else{
        googleAuthStatus.textContent = 'Not connected';
        googleAuthStatus.className = 'auth-status';
      }
    }
  });

  updateStatusCard();
  renderHistory();
}

init();