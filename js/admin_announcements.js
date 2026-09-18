// admin_announcements.js — Announcements (Maintenance module, Part B)
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { computeAnnouncementStatus, renderAnnouncementBannerHtml, KIND_LABELS } from './announcement_helpers.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

// ── STATE ────────────────────────────────────────────────────────
let announcements = [];
let editingId = null; // null while creating a new announcement
let statusTransitionTimer = null; // precise timeout aimed at the next starts_at/ends_at boundary
let statusFallbackTimer = null; // cheap safety-net interval in case a transition is ever missed

// ── DOM refs ─────────────────────────────────────────────────────
const tableBody = document.getElementById('announcementsTableBody');
const addBtn = document.getElementById('addAnnouncementBtn');

const modal = document.getElementById('announcementModal');
const modalTitle = document.getElementById('announcementModalTitle');
const modalMessage = document.getElementById('announcementModalMessage');
const messageInput = document.getElementById('announceMessage');
const kindInput = document.getElementById('announceKind');
const enabledInput = document.getElementById('announceEnabled');
const startsInput = document.getElementById('announceStartsAt');
const endsInput = document.getElementById('announceEndsAt');
const dismissibleInput = document.getElementById('announceDismissible');
const linkLabelInput = document.getElementById('announceLinkLabel');
const linkUrlInput = document.getElementById('announceLinkUrl');
const linkError = document.getElementById('announceLinkError');
const previewWrap = document.getElementById('announcePreviewWrap');
const saveBtn = document.getElementById('announcementModalSave');

// ── UTILITIES ────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function setModalMsg(msg, type = 'error') {
  if (!msg) { modalMessage.className = 'modal-message hidden'; modalMessage.textContent = ''; return; }
  modalMessage.textContent = msg;
  modalMessage.className = `modal-message ${type}`;
}
function openModal() { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); lockBodyScroll(); }
function closeModal() { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); unlockBodyScroll(); }

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}
function fmtWindow(a) {
  const fmt = iso => iso ? new Date(iso).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const starts = fmt(a.starts_at);
  const ends = fmt(a.ends_at);
  if (!starts && !ends) return 'Always (until turned off)';
  if (starts && !ends) return `From ${starts}`;
  if (!starts && ends) return `Until ${ends}`;
  return `${starts} → ${ends}`;
}

// ── LOAD / RENDER LIST ───────────────────────────────────────────
async function loadAll() {
  tableBody.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  const { data, error } = await supabase.from('announcement').select('*').order('created_at', { ascending: false });
  if (error) {
    tableBody.innerHTML = `<tr><td colspan="5">Failed to load: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  announcements = data || [];
  renderTable();
  scheduleNextStatusUpdate(); // data may have changed which boundary is soonest
}

function renderTable() {
  if (!announcements.length) {
    tableBody.innerHTML = `<tr><td colspan="5"><div class="ann-empty">No announcements. Post a notice when the café has news or upcoming maintenance.</div></td></tr>`;
    return;
  }

  tableBody.innerHTML = announcements.map(a => {
    const status = computeAnnouncementStatus(a);
    const preview = (a.message || '').length > 70 ? a.message.slice(0, 70) + '…' : a.message;
    return `
      <tr>
        <td class="ann-msg-cell">${escapeHtml(preview)}</td>
        <td><span class="ann-kind-badge ann-kind-${escapeHtml(a.kind)}">${escapeHtml(KIND_LABELS[a.kind] || a.kind)}</span></td>
        <td><span class="status-pill ann-status-${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</span></td>
        <td class="mono ann-window-cell">${escapeHtml(fmtWindow(a))}</td>
        <td class="ann-actions-cell">
          <button type="button" class="btn-outline-sm" data-action="edit" data-id="${escapeHtml(a.id)}">Edit</button>
          <button type="button" class="btn-outline-sm" data-action="toggle" data-id="${escapeHtml(a.id)}">${a.is_enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" class="btn-outline-sm btn-danger-sm" data-action="delete" data-id="${escapeHtml(a.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');
}

// Find the soonest upcoming starts_at/ends_at across all loaded, enabled
// announcements (relative to `now`). Returns a Date or null if nothing is
// pending a transition (e.g. everything's already live-forever or expired).
function getNextTransitionTime(now = new Date()) {
  let soonest = null;
  for (const a of announcements) {
    if (!a.is_enabled) continue;
    for (const iso of [a.starts_at, a.ends_at]) {
      if (!iso) continue;
      const t = new Date(iso);
      if (t > now && (!soonest || t < soonest)) soonest = t;
    }
  }
  return soonest;
}

// Re-paint status pills/window text using already-loaded data (no Supabase
// refetch — computeAnnouncementStatus is time-based). Instead of polling on
// a flat interval, this schedules a single setTimeout aimed precisely at
// the next boundary so Scheduled → Live → Expired flips within ~a second
// of the real moment, then reschedules for whatever's next.
function scheduleNextStatusUpdate() {
  if (statusTransitionTimer) { clearTimeout(statusTransitionTimer); statusTransitionTimer = null; }
  const next = getNextTransitionTime();
  if (!next) return; // nothing pending — fallback interval still covers us if data changes underneath

  const delay = Math.max(250, next.getTime() - Date.now() + 250); // small buffer past the exact boundary
  statusTransitionTimer = setTimeout(() => {
    statusTransitionTimer = null;
    if (announcements.length) renderTable();
    scheduleNextStatusUpdate();
  }, delay);
}

// Cheap safety net — in case a transition is ever missed (e.g. system sleep,
// throttled background tab, or a bug in the scheduling above), this catches
// up within 30s worst case and re-arms the precise scheduler.
function startStatusAutoRefresh() {
  scheduleNextStatusUpdate();
  if (statusFallbackTimer) return;
  statusFallbackTimer = setInterval(() => {
    if (announcements.length) renderTable();
    scheduleNextStatusUpdate();
  }, 30000);
}
function stopStatusAutoRefresh() {
  if (statusTransitionTimer) { clearTimeout(statusTransitionTimer); statusTransitionTimer = null; }
  if (statusFallbackTimer) { clearInterval(statusFallbackTimer); statusFallbackTimer = null; }
}
// Pause timers while tab is hidden (setTimeout/setInterval drift or get
// throttled in background tabs anyway), and force an immediate repaint +
// reschedule on return so nothing shows stale right when the admin looks
// back at the tab.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopStatusAutoRefresh();
  } else {
    if (announcements.length) renderTable();
    startStatusAutoRefresh();
  }
});

tableBody.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  const a = announcements.find(x => x.id === id);
  if (!a) return;

  if (action === 'edit') { openEditor(a); return; }

  if (action === 'toggle') {
    const nextEnabled = !a.is_enabled;
    const { error } = await supabase.from('announcement').update({ is_enabled: nextEnabled }).eq('id', id);
    if (error) { alert(`Failed to update: ${error.message}`); return; }
    await logAudit({ action: nextEnabled ? 'Enabled Announcement' : 'Disabled Announcement', category: 'announcements', details: (a.message || '').slice(0, 80), entityId: id });
    await loadAll();
    return;
  }

  if (action === 'delete') {
    if (!confirm('Delete this announcement permanently? This can\'t be undone.')) return;
    const { error } = await supabase.from('announcement').delete().eq('id', id);
    if (error) { alert(`Failed to delete: ${error.message}`); return; }
    await logAudit({ action: 'Deleted Announcement', category: 'announcements', details: (a.message || '').slice(0, 80), entityId: id });
    await loadAll();
  }
});

// ── ADD / EDIT MODAL ─────────────────────────────────────────────
function updatePreview() {
  const draft = {
    id: 'preview',
    message: messageInput.value || 'Your announcement message will appear here.',
    kind: kindInput.value,
    is_dismissible: dismissibleInput.checked,
    link_label: linkLabelInput.value.trim(),
    link_url: linkUrlInput.value.trim()
  };
  previewWrap.innerHTML = renderAnnouncementBannerHtml(draft);
}

[messageInput, kindInput, dismissibleInput, linkLabelInput, linkUrlInput].forEach(el => {
  el.addEventListener('input', updatePreview);
  el.addEventListener('change', updatePreview);
});

function openEditor(a = null) {
  editingId = a ? a.id : null;
  modalTitle.textContent = a ? 'Edit Announcement' : 'New Announcement';

  messageInput.value = a?.message || '';
  kindInput.value = a?.kind || 'info';
  enabledInput.checked = a ? a.is_enabled : true;
  startsInput.value = isoToLocalInput(a?.starts_at);
  endsInput.value = isoToLocalInput(a?.ends_at);
  dismissibleInput.checked = a ? a.is_dismissible : true;
  linkLabelInput.value = a?.link_label || '';
  linkUrlInput.value = a?.link_url || '';

  linkError.textContent = '';
  setModalMsg('');
  updatePreview();
  openModal();
}

addBtn.addEventListener('click', () => openEditor(null));
document.getElementById('announcementModalClose').addEventListener('click', closeModal);
document.getElementById('announcementModalCancel').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal(); });

saveBtn.addEventListener('click', async () => {
  linkError.textContent = '';
  setModalMsg('');

  const message = messageInput.value.trim();
  if (!message) { setModalMsg('Message is required.'); return; }

  const startsIso = localInputToIso(startsInput.value);
  const endsIso = localInputToIso(endsInput.value);
  if (startsIso && endsIso && new Date(endsIso) <= new Date(startsIso)) {
    setModalMsg('End must be after start.');
    return;
  }

  const linkLabel = linkLabelInput.value.trim();
  const linkUrl = linkUrlInput.value.trim();
  if (linkLabel && !linkUrl) { linkError.textContent = 'Add a link URL, or clear the CTA label.'; linkError.className = 'modal-hint error'; return; }
  if (linkUrl && !linkLabel) { linkError.textContent = 'Add a CTA label, or clear the link URL.'; linkError.className = 'modal-hint error'; return; }

  const payload = {
    message,
    kind: kindInput.value,
    is_enabled: enabledInput.checked,
    starts_at: startsIso,
    ends_at: endsIso,
    is_dismissible: dismissibleInput.checked,
    link_label: linkLabel || null,
    link_url: linkUrl || null
  };

  saveBtn.disabled = true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    payload.updated_by = user?.id ?? null;

    const { error } = editingId
      ? await supabase.from('announcement').update(payload).eq('id', editingId)
      : await supabase.from('announcement').insert(payload);
    if (error) throw error;

    await logAudit({
      action: editingId ? 'Updated Announcement' : 'Created Announcement',
      category: 'announcements',
      details: message.slice(0, 80),
      entityId: editingId || undefined
    });

    closeModal();
    await loadAll();
  } catch (err) {
    setModalMsg(`Failed to save: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
  }
});

// ── SESSION ──────────────────────────────────────────────────────
async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Admin' });
  if (!result) return;

  if (result.profile.role !== 'admin') {
    window.location.replace('/admin/dashboard.html');
    return;
  }

  const avatarEl = document.getElementById('sidebarAvatar');
  if (avatarEl) avatarEl.textContent = getPortalInitials(result.profile);
  const roleBottomEl = document.getElementById('sidebarRoleBottom');
  if (roleBottomEl) roleBottomEl.textContent = 'Admin';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout(result.profile.role);
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });
  await loadAll();
  startStatusAutoRefresh();
}

init();