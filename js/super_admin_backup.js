// super_admin_backup.js
// Backup: reads all Supabase tables → bundles into JSON → uploads to Google Drive
// Restore: lists JSON files from Google Drive → lets user pick → upserts back into Supabase

import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { logAudit } from './audit_logger.js';

// ─── Google Drive config ──────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID  = '419921262357-ci1j9bi3i9v3hebp11m3077fa0b805pv.apps.googleusercontent.com';
const DRIVE_FOLDER_NAME = 'ELI Coffee Backups';
const DRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file';


// ─── All tables to back up (in dependency order for safe restore) ─────────────
const BACKUP_TABLES = [
  'profiles',
  'package_category',
  'package',
  'package_tier',
  'contract_templates',
  'reservations',
  'reservation_contracts',
  'reservation_staff_assignments',
  'reservation_status',
  'payment',
  'payment_method',
  'receipts',
  'reschedule_requests',
  'reservation_cancellations',
  'calendar_blackouts',
  'reservation_forecast',
  'reviews',
  'audit_log',            
];

// ─── State ────────────────────────────────────────────────────────────────────
let driveAccessToken      = null;
let driveFolderId         = null;
let backupHistory         = [];
let pendingRestoreFile    = null;
let pendingSettingsAction = null;
let settings              = { retentionDays: 90};
let currentAdminId        = null;
let pendingDeleteFile = null;
let historyCurrentPage  = 1;
const HISTORY_PAGE_SIZE = 10;


// ─── DOM refs ─────────────────────────────────────────────────────────────────
const pageMessage           = document.getElementById('pageMessage');
const createBackupBtn       = document.getElementById('createBackupBtn');
const restoreSystemBtn      = document.getElementById('restoreSystemBtn');
const lastBackupDate        = document.getElementById('lastBackupDate');
const lastBackupStatus      = document.getElementById('lastBackupStatus');
const totalBackupsEl        = document.getElementById('totalBackups');
const totalSizeEl           = document.getElementById('totalSize');
const storageLocationEl     = document.getElementById('storageLocation');
const historyList           = document.getElementById('historyList');
const emptyHistory          = document.getElementById('emptyHistory');
const configureRetentionBtn = document.getElementById('configureRetentionBtn');
const googleAuthBtn         = document.getElementById('googleAuthBtn');
const googleAuthStatus      = document.getElementById('googleAuthStatus');
const deleteBackupModal   = document.getElementById('deleteBackupModal');
const deleteBackupClose   = document.getElementById('deleteBackupClose');
const deleteBackupCancel  = document.getElementById('deleteBackupCancel');
const deleteBackupOk      = document.getElementById('deleteBackupOk');
const deleteBackupCopy    = document.getElementById('deleteBackupCopy');
const deleteBackupMessage = document.getElementById('deleteBackupMessage');

// Confirm backup modal
const confirmBackupModal   = document.getElementById('confirmBackupModal');
const confirmBackupClose   = document.getElementById('confirmBackupClose');
const confirmBackupCancel  = document.getElementById('confirmBackupCancel');
const confirmBackupOk      = document.getElementById('confirmBackupOk');
const confirmBackupMessage = document.getElementById('confirmBackupMessage');
const backupProgressWrap   = document.getElementById('backupProgressWrap');
const backupProgressBar    = document.getElementById('backupProgressBar');
const backupProgressLabel  = document.getElementById('backupProgressLabel');

// Restore modal
const restoreModal        = document.getElementById('restoreModal');
const restoreModalSub     = document.getElementById('restoreModalSub');
const restoreCopy         = document.getElementById('restoreCopy');
const restoreClose        = document.getElementById('restoreClose');
const restoreCancel       = document.getElementById('restoreCancel');
const restoreOk           = document.getElementById('restoreOk');
const restoreMessage      = document.getElementById('restoreMessage');
const restoreProgressWrap = document.getElementById('restoreProgressWrap');
const restoreProgressBar  = document.getElementById('restoreProgressBar');
const restoreProgressLabel= document.getElementById('restoreProgressLabel');

// Settings modal
const settingsModal      = document.getElementById('settingsModal');
const settingsModalTitle = document.getElementById('settingsModalTitle');
const settingsModalBody  = document.getElementById('settingsModalBody');
const settingsClose      = document.getElementById('settingsClose');
const settingsCancel     = document.getElementById('settingsCancel');
const settingsSave       = document.getElementById('settingsSave');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function setPageMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className   = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => setPageMessage(''), 5000);
}

function setModalMsg(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className   = `modal-message ${type}`;
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
  bar.style.width       = `${percent}%`;
  label.textContent     = text;
  const pctEl = wrap.querySelector('.progress-pct');
  if (pctEl) pctEl.textContent = `${percent}%`;
}

function hideProgress(wrap) {
  wrap.classList.add('hidden');
}

// ─── Token helpers ────────────────────────────────────────────────────────────
function isTokenExpired() {
  const expiresAt = parseInt(localStorage.getItem('drive_token_expires_at') || '0', 10);
  // Treat as expired 2 minutes before actual expiry (safety buffer)
  return Date.now() >= expiresAt - 120_000;
}

function clearSavedToken() {
  driveAccessToken = null;
  driveFolderId    = null;
  localStorage.removeItem('drive_token');
  localStorage.removeItem('drive_token_expires_at');
}

function resetAuthUI() {
  googleAuthBtn.textContent    = 'Connect Google Drive';
  googleAuthBtn.disabled       = false;
  googleAuthStatus.textContent = 'Session expired — please reconnect';
  googleAuthStatus.className   = 'auth-status error';
  createBackupBtn.disabled     = true;
  restoreSystemBtn.disabled    = true;
}

// Called whenever we have a fresh, valid token ready to use
async function onTokenReady() {
  googleAuthBtn.textContent    = 'Google Drive Connected';
  googleAuthBtn.disabled       = true;
  googleAuthStatus.textContent = 'Connected — backups will be saved to your Drive';
  googleAuthStatus.className   = 'auth-status success';
  createBackupBtn.disabled     = false;
  restoreSystemBtn.disabled    = false;

  await resolveDriveFolder(currentAdminId);
  await loadBackupHistory();
}

// ─── Google OAuth (GIS token flow) ───────────────────────────────────────────
function initGoogleAuth() {
  window._tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     DRIVE_SCOPE,
    callback:  async (response) => {
      if (response.error) {
        setPageMessage(`Google sign-in failed: ${response.error}`, 'error');
        return;
      }

      driveAccessToken = response.access_token;

      const expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
      localStorage.setItem('drive_token', driveAccessToken);
      localStorage.setItem('drive_token_expires_at', String(expiresAt));

      await logAudit({
        action:   'Connected Google Drive',
        category: 'system',
        details:  'Admin authenticated with Google Drive for backup access',
        entityId: currentAdminId || null
      });

      await onTokenReady();
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

// ─── Silent token refresh ─────────────────────────────────────────────────────
function refreshToken() {
  return new Promise((resolve, reject) => {
    if (!window._tokenClient) {
      reject(new Error('Google auth not initialised.'));
      return;
    }

    // Temporarily override callback just for this refresh
    window._tokenClient.callback = async (response) => {
      if (response.error) {
        clearSavedToken();
        reject(new Error(`Token refresh failed: ${response.error}`));
        return;
      }

      driveAccessToken = response.access_token;
      const expiresAt  = Date.now() + (response.expires_in ?? 3600) * 1000;
      localStorage.setItem('drive_token', driveAccessToken);
      localStorage.setItem('drive_token_expires_at', String(expiresAt));

      resolve();
    };

    // prompt: '' = silent refresh (no popup if Google session still active)
    window._tokenClient.requestAccessToken({ prompt: '' });
  });
}

// ─── Token guard — call before every Drive operation ─────────────────────────
async function ensureValidToken() {
  if (!driveAccessToken) {
    throw new Error('Not connected to Google Drive. Please reconnect.');
  }

  if (isTokenExpired()) {
    setPageMessage('Google session expired — refreshing…');
    try {
      await refreshToken();
      setPageMessage('');
    } catch (err) {
      clearSavedToken();
      resetAuthUI();
      throw new Error('Your Google session expired. Please reconnect to Google Drive.');
    }
  }
}

// ─── Drive helpers ────────────────────────────────────────────────────────────
async function driveRequest(path, options = {}) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${driveAccessToken}`,
      'Content-Type':  'application/json',
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Drive API error (${res.status})`);
  }

  return res.json();
}

async function resolveDriveFolder(userId) {
  // Scope cache key to the current user to avoid cross-account contamination
  const cacheKey = `drive_folder_id_${userId}`;
  const savedFolderId = localStorage.getItem(cacheKey);

  // 1. Validate cached folder — and confirm it actually has backups
  if (savedFolderId) {
    try {
      const existing = await driveRequest(
        `files/${savedFolderId}?fields=id,name,trashed`
      );

      if (existing?.id && !existing.trashed) {
        // Verify this folder has at least one backup before trusting cache
        const check = await driveRequest(
          `files?q='${existing.id}' in parents and mimeType='application/json' and trashed=false` +
          `&fields=files(id)&pageSize=1`
        );

        if (check.files?.length) {
          driveFolderId = existing.id;
          return;
        }
        // Cached folder is empty — don't trust it, fall through to search
      }
      localStorage.removeItem(cacheKey);
    } catch {
      localStorage.removeItem(cacheKey);
    }
  }

  // 2. Find ALL matching folders
  const search = await driveRequest(
    `files?q=name='${DRIVE_FOLDER_NAME}'` +
    ` and mimeType='application/vnd.google-apps.folder'` +
    ` and trashed=false` +
    `&fields=files(id,name,createdTime)` +
    `&orderBy=createdTime asc`
  );

  const candidates = search.files || [];

  if (candidates.length > 0) {
    // 3. For each candidate, count its backup files
    const counts = await Promise.all(
      candidates.map(async (folder) => {
        try {
          const res = await driveRequest(
            `files?q='${folder.id}' in parents and mimeType='application/json' and trashed=false` +
            `&fields=files(id)&pageSize=1000`
          );
          return { folder, count: res.files?.length || 0 };
        } catch {
          return { folder, count: 0 };
        }
      })
    );

    // 4. Pick the folder with the most backups; tiebreak by oldest
    counts.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return new Date(a.folder.createdTime) - new Date(b.folder.createdTime);
    });

    const winner = counts[0].folder;
    driveFolderId = winner.id;
    localStorage.setItem(cacheKey, driveFolderId);

    // Warn the user about duplicates
    if (candidates.length > 1) {
      console.warn(
        `Found ${candidates.length} folders named "${DRIVE_FOLDER_NAME}". ` +
        `Using the one with ${counts[0].count} backups (created ${winner.createdTime}). ` +
        `Consider consolidating duplicate folders.`
      );
    }

    return;
  }

  // 5. Create only if nothing exists at all
  const created = await driveRequest('files', {
    method: 'POST',
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });

  if (!created?.id) throw new Error('Failed to create Drive folder');

  driveFolderId = created.id;
  localStorage.setItem(cacheKey, driveFolderId);
}

// ─── Load backup history from Drive ──────────────────────────────────────────
let loadHistoryRequestId = 0;

async function loadBackupHistory() {
  if (!driveAccessToken || !driveFolderId) return;

  // Race condition guard: only the latest call updates state
  const requestId = ++loadHistoryRequestId;

  setPageMessage('Loading backup history…');

  try {
    const allFiles = [];
    let pageToken = null;

    // Paginate to get all backups, not just the first 100
    do {
      const query =
        `files?q='${driveFolderId}' in parents` +
        ` and mimeType='application/json'` +
        ` and trashed=false` +
        `&fields=nextPageToken,files(id,name,size,createdTime,modifiedTime,description)` +
        `&orderBy=createdTime desc` +
        `&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

      const res = await driveRequest(query);

      // Abort if a newer call has superseded this one
      if (requestId !== loadHistoryRequestId) return;

      if (res.files?.length) allFiles.push(...res.files);
      pageToken = res.nextPageToken || null;
    } while (pageToken);

    backupHistory = allFiles;
    historyCurrentPage = 1;
    renderHistory();
    updateStatusCard();
    setPageMessage('');
  } catch (err) {
    // Only show error if this is still the most recent call
    if (requestId !== loadHistoryRequestId) return;

    setPageMessage(`Failed to load backup history: ${err.message}`, 'error');
    renderHistory();
  }
}

// ─── Read all Supabase tables ─────────────────────────────────────────────────
async function readAllTables(onProgress) {
  const snapshot = {};
  const skipped  = [];

  for (let i = 0; i < BACKUP_TABLES.length; i++) {
    const table   = BACKUP_TABLES[i];
    const percent = Math.round((i / BACKUP_TABLES.length) * 70);
    onProgress(percent, `Reading ${table}…`);

    const { data, error } = await supabase.from(table).select('*');

    if (error) {
      console.warn(`Skipping table "${table}": ${error.message}`);
      skipped.push(table);
      snapshot[table] = [];
      continue;
    }

    snapshot[table] = data || [];
  }

  if (skipped.length) {
    console.warn('Skipped tables during backup:', skipped.join(', '));
  }

  return snapshot;
}

// ─── Upload JSON to Google Drive ──────────────────────────────────────────────
async function uploadToDrive(filename, jsonContent, description, onProgress) {
  onProgress(75, 'Uploading to Google Drive…');

  const boundary = '-------ELICoffeeBackup';
  const metadata = JSON.stringify({
    name:        filename,
    description,
    parents:     [driveFolderId],
    mimeType:    'application/json'
  });

  const multipart = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${jsonContent}\r\n`,
    `--${boundary}--`
  ].join('');

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,createdTime',
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${driveAccessToken}`,
        'Content-Type':  `multipart/related; boundary=${boundary}`
      },
      body: multipart
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Drive upload failed (${res.status})`);
  }

  onProgress(95, 'Finalising…');
  return res.json();
}

// ─── Create backup ────────────────────────────────────────────────────────────
createBackupBtn?.addEventListener('click', async () => {
  try {
    await ensureValidToken(); // check before opening modal
  } catch (err) {
    setPageMessage(err.message, 'error');
    return;
  }

  setModalMsg(confirmBackupMessage, '');
  hideProgress(backupProgressWrap);
  openModal(confirmBackupModal);
});

confirmBackupOk?.addEventListener('click', async () => {
  confirmBackupOk.disabled    = true;
  confirmBackupCancel.disabled = true;
  setModalMsg(confirmBackupMessage, '');

  const onProgress = (pct, text) =>
    setProgress(backupProgressBar, backupProgressLabel, backupProgressWrap, pct, text);

  try {
    await ensureValidToken(); // re-check at point of use

    const snapshot = await readAllTables(onProgress);

    onProgress(72, 'Building backup file…');
    const now    = new Date();
    const bundle = {
      meta: {
        created_at:   now.toISOString(),
        created_by:   currentAdminId,
        tables:       BACKUP_TABLES,
        table_counts: Object.fromEntries(
          BACKUP_TABLES.map(t => [t, snapshot[t]?.length ?? 0])
        ),
        version: '1.0'
      },
      data: snapshot
    };

    const jsonContent = JSON.stringify(bundle, null, 2);
    const dateStr     = now.toISOString().slice(0, 10);
    const timeStr     = now.toTimeString().slice(0, 5).replace(':', '-');
    const filename    = `eli_backup_${dateStr}_${timeStr}.json`;
    const description = `Manual backup — ${now.toLocaleString('en-PH')}`;

    const uploaded = await uploadToDrive(filename, jsonContent, description, onProgress);
    onProgress(100, 'Done!');

    await loadBackupHistory();
    await logAudit({
      action:   'Created Backup',
      category: 'system',
      details:  `Backup created and uploaded to Google Drive: ${uploaded.name} (${formatBytes(parseInt(uploaded.size || 0))})`,
      entityId: uploaded.id || null
    });
    closeModal(confirmBackupModal);
    setPageMessage(`Backup created and saved to Google Drive: ${uploaded.name}`, 'success');

  } catch (err) {
    setModalMsg(confirmBackupMessage, `Backup failed: ${err.message}`);
    hideProgress(backupProgressWrap);
  } finally {
    confirmBackupOk.disabled    = false;
    confirmBackupCancel.disabled = false;
  }
});

// ─── Delete backup ───────────────────────────────────────────────────────────
deleteBackupOk?.addEventListener('click', async () => {
  if (!pendingDeleteFile) return;

  deleteBackupOk.disabled    = true;
  deleteBackupCancel.disabled = true;
  setModalMsg(deleteBackupMessage, 'Deleting backup…', 'info');

  try {
    await ensureValidToken();

    await fetch(`https://www.googleapis.com/drive/v3/files/${pendingDeleteFile.id}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${driveAccessToken}` }
    });

    await logAudit({
      action:   'Deleted Backup',
      category: 'system',
      details:  `Backup file deleted from Google Drive: ${pendingDeleteFile.name}`,
      entityId: pendingDeleteFile.id || null
    });

    closeModal(deleteBackupModal);
    setPageMessage('Backup deleted.', 'success');
    await loadBackupHistory();

  } catch (err) {
    setModalMsg(deleteBackupMessage, `Delete failed: ${err.message}`);
  } finally {
    deleteBackupOk.disabled    = false;
    deleteBackupCancel.disabled = false;
    pendingDeleteFile           = null;
  }
});

// ─── Restore: open modal ──────────────────────────────────────────────────────
restoreSystemBtn?.addEventListener('click', async () => {
  try {
    await ensureValidToken(); // 
  } catch (err) {
    setPageMessage(err.message, 'error');
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
  pendingRestoreFile       = { id: fileId, name };
  restoreModalSub.textContent = name;
  restoreCopy.textContent  = `Restoring from the backup created on ${formatDriveDate(createdTime)} will overwrite all current data in every table.`;
  setModalMsg(restoreMessage, '');
  hideProgress(restoreProgressWrap);
  restoreOk.disabled       = false;
  restoreOk.textContent    = 'Restore Now';
  openModal(restoreModal);
}

// ─── Restore: download from Drive and upsert ──────────────────────────────────
restoreOk?.addEventListener('click', async () => {
  if (!pendingRestoreFile) return;

  restoreOk.disabled      = true;
  restoreCancel.disabled  = true;
  setModalMsg(restoreMessage, '');

  const onProgress = (pct, text) =>
    setProgress(restoreProgressBar, restoreProgressLabel, restoreProgressWrap, pct, text);

  try {
    await ensureValidToken(); // 

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

    const { data }  = bundle;
    const tables    = bundle.meta.tables || BACKUP_TABLES;

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows  = data[table];
      if (!rows?.length) continue;

      const pct = 20 + Math.round(((i + 1) / tables.length) * 75);
      onProgress(pct, `Restoring ${table} (${rows.length} rows)…`);

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
    await logAudit({
      action:   'Restored System Backup',
      category: 'system',
      details:  `System restored from backup file: ${pendingRestoreFile.name}`,
      entityId: pendingRestoreFile.id || null
    });
    setTimeout(() => {
      closeModal(restoreModal);
      setPageMessage('System restored successfully from the selected backup.', 'success');
    }, 800);

  } catch (err) {
    setModalMsg(restoreMessage, `Restore failed: ${err.message}`);
    hideProgress(restoreProgressWrap);
    restoreOk.disabled    = false;
    restoreOk.textContent = 'Restore Now';
  } finally {
    restoreCancel.disabled = false;
  }
});

// ─── Primary key map ──────────────────────────────────────────────────────────
function getPrimaryKey(table) {
  const keys = {
    profiles:                      'user_id',
    package_category:              'package_category_id',  
    package:                       'package_id',
    package_tier:                  'tier_id',           
    contract_templates:            'template_id',
    reservations:                  'reservation_id',
    reservation_contracts:         'reservation_contract_id',
    reservation_staff_assignments: 'assignment_id',
    reservation_status:            'status_id',
    payment:                       'payment_id',
    payment_method:                'payment_method_id',
    receipts:                      'receipt_id',
    reschedule_requests:           'reschedule_request_id',
    reservation_cancellations:     'cancellation_id',
    calendar_blackouts:            'blackout_id',
    reservation_forecast:          'forecast_id',
    reviews:                       'review_id',
    audit_log: 'audit_id',  
  };
  return keys[table] || 'id';
}

// ─── Download backup file ─────────────────────────────────────────────────────
async function handleDownload(fileId, filename) {
  try {
    await ensureValidToken(); // ✅
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
    await logAudit({
      action:   'Downloaded Backup',
      category: 'system',
      details:  `Backup file downloaded: ${filename}`,
      entityId: fileId || null
    });
    setPageMessage('Download started.', 'success');

  } catch (err) {
    setPageMessage(`Download failed: ${err.message}`, 'error');
  }
}

// ─── Delete backup from Drive ─────────────────────────────────────────────────
async function handleDelete(fileId, filename) {
  try {
    await ensureValidToken();
  } catch (err) {
    setPageMessage(err.message, 'error');
    return;
  }

  pendingDeleteFile = { id: fileId, name: filename };
  deleteBackupCopy.textContent = `Delete "${filename}" from Google Drive? This cannot be undone.`;
  setModalMsg(deleteBackupMessage, '');
  deleteBackupOk.disabled = false;
  openModal(deleteBackupModal);
}

// ─── Enforce retention policy ─────────────────────────────────────────────────
async function enforceRetention() {
  if (!driveAccessToken || !backupHistory.length) return;

  const cutoff  = new Date();
  cutoff.setDate(cutoff.getDate() - settings.retentionDays);

  const expired = backupHistory.filter(b => new Date(b.createdTime) < cutoff);
  if (!expired.length) return;

  for (const file of expired) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${driveAccessToken}` }
    }).catch(() => {});
  }

  await loadBackupHistory();
    await logAudit({
      action:   'Enforced Retention Policy',
      category: 'system',
      details:  `Removed ${expired.length} expired backup(s) older than ${settings.retentionDays} days`,
      entityId: null
    });
    setPageMessage(`Removed ${expired.length} expired backup(s) per retention policy.`, 'success');
}

// ─── Status card ──────────────────────────────────────────────────────────────
function updateStatusCard() {
  const latest = backupHistory[0];

  if (latest) {
    lastBackupDate.textContent     = formatDriveDate(latest.createdTime);
    lastBackupStatus.style.display = '';
  } else {
    lastBackupDate.textContent     = 'No backups yet';
    lastBackupStatus.style.display = 'none';
  }

  totalBackupsEl.textContent = `${backupHistory.length} backup${backupHistory.length !== 1 ? 's' : ''}`;

  const totalBytes = backupHistory.reduce((sum, b) => sum + (parseInt(b.size) || 0), 0);
  totalSizeEl.textContent     = totalBytes ? `~${formatBytes(totalBytes)} total size` : '— total size';
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

  const totalPages = Math.ceil(backupHistory.length / HISTORY_PAGE_SIZE);

  // Clamp current page in case backups got deleted
  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
  if (historyCurrentPage < 1) historyCurrentPage = 1;

  const start = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const end   = start + HISTORY_PAGE_SIZE;
  const pageItems = backupHistory.slice(start, end);

  const rowsHtml = pageItems.map(b => `
    <div class="history-row">
      <div class="history-left">
        <div class="history-icon">
          <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
        </div>
        <div>
          <div class="history-name">${escapeHtml(b.name)}</div>
          <div class="history-meta">
            ${escapeHtml(formatDriveDate(b.createdTime))} · 
            ${escapeHtml(formatBytes(parseInt(b.size)))} · 
            Google Drive
          </div>
        </div>
      </div>
      <div class="history-right">
        <span class="completed-badge">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          completed
        </span>
        <button class="history-btn" data-action="download" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
        <button class="history-btn restore-btn" data-action="restore" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}" data-date="${escapeHtml(b.createdTime)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="16 16 12 12 8 16"/>
            <line x1="12" y1="12" x2="12" y2="21"/>
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
          </svg>
          Restore
        </button>
        <button class="history-btn delete-btn" data-action="delete" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
          Delete
        </button>
      </div>
    </div>
  `).join('');

  // Only show pagination if we have more than one page
  const paginationHtml = totalPages > 1 ? `
    <div class="history-pagination">
      <button class="pagination-btn" data-action="prev-page" ${historyCurrentPage === 1 ? 'disabled' : ''}>
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        Previous
      </button>
      <span class="pagination-info">
        Page ${historyCurrentPage} of ${totalPages} · Showing ${start + 1}–${Math.min(end, backupHistory.length)} of ${backupHistory.length}
      </span>
      <button class="pagination-btn" data-action="next-page" ${historyCurrentPage === totalPages ? 'disabled' : ''}>
        Next
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>
    </div>
  ` : '';

  historyList.innerHTML = rowsHtml + paginationHtml;
}

// ─── History click delegation ─────────────────────────────────────────────────
historyList?.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, name, date } = btn.dataset;

  if (action === 'download') handleDownload(id, name);
  if (action === 'restore')  openRestoreModal(id, name, date);
  if (action === 'delete')   handleDelete(id, name);

  if (action === 'prev-page') {
    historyCurrentPage = Math.max(1, historyCurrentPage - 1);
    renderHistory();
  }
  if (action === 'next-page') {
    const totalPages = Math.ceil(backupHistory.length / HISTORY_PAGE_SIZE);
    historyCurrentPage = Math.min(totalPages, historyCurrentPage + 1);
    renderHistory();
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
configureRetentionBtn?.addEventListener('click', () => {
  pendingSettingsAction        = 'retention';
  settingsModalTitle.textContent = 'Configure Backup Retention';
  settingsModalBody.innerHTML  = `
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

deleteBackupClose?.addEventListener('click',  () => closeModal(deleteBackupModal));
deleteBackupCancel?.addEventListener('click', () => closeModal(deleteBackupModal));
deleteBackupModal?.addEventListener('click', e => {
  if (e.target === deleteBackupModal) closeModal(deleteBackupModal);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!confirmBackupModal?.classList.contains('hidden')) closeModal(confirmBackupModal);
  if (!restoreModal?.classList.contains('hidden'))       closeModal(restoreModal);
  if (!settingsModal?.classList.contains('hidden'))      closeModal(settingsModal);
  if (!deleteBackupModal?.classList.contains('hidden'))  closeModal(deleteBackupModal);
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

      createBackupBtn.disabled  = true;
      restoreSystemBtn.disabled = true;

      // Init Google OAuth client
      if (window.google?.accounts?.oauth2) {
        initGoogleAuth();
      } else {
        window.addEventListener('load', initGoogleAuth);
      }

      const savedToken = localStorage.getItem('drive_token');

      if (savedToken && !isTokenExpired()) {
        //  Token exists and is still valid — use it directly
        driveAccessToken = savedToken;
        await onTokenReady();

      } else if (savedToken && isTokenExpired()) {
        //  Token exists but expired — clear and prompt reconnect
        clearSavedToken();
        googleAuthStatus.textContent = 'Session expired — please reconnect to Google Drive';
        googleAuthStatus.className   = 'auth-status error';
        setPageMessage('Your Google Drive session has expired. Please reconnect.', 'error');

      } else {
        // No token at all
        googleAuthStatus.textContent = 'Not connected';
        googleAuthStatus.className   = 'auth-status';
      }
    }
  });

  updateStatusCard();
  renderHistory();
}

init();