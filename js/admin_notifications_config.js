// admin_notifications_config.js — Notifications Configuration (Phase 1)
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { TOKEN_INFO, SAMPLE_RESERVATION, mergeTokens, findUnknownTokens } from './merge_tokens.js';

// Reminders are the only triggers with a lead_days timing control — see
// supabase/migrations/20260815_reminder_notifications.sql. The catalogue is
// fixed (no admin-added triggers), so a small static set here is simpler
// and safer than inferring "is this a reminder" from lead_days being
// non-null on whatever template row happens to be loaded.
const REMINDER_TRIGGER_CODES = new Set(['payment_due', 'balance_due', 'event_reminder']);

// ── STATE ────────────────────────────────────────────────────────
let triggers  = [];   // notification_trigger rows
let templates = {};   // trigger_code -> notification_template row
let logRows   = [];
let editingTriggerCode = null;

// ── DOM refs ─────────────────────────────────────────────────────
const triggerList     = document.getElementById('triggerList');
const logTableBody    = document.getElementById('logTableBody');
const logTriggerFilter = document.getElementById('logTriggerFilter');
const logStatusFilter  = document.getElementById('logStatusFilter');

const editorModal        = document.getElementById('editorModal');
const editorModalTitle   = document.getElementById('editorModalTitle');
const editorModalSub     = document.getElementById('editorModalSub');
const editorModalMessage = document.getElementById('editorModalMessage');
const editorLeadDaysField = document.getElementById('editorLeadDaysField');
const editorLeadDaysInput = document.getElementById('editorLeadDaysInput');
const editorSendInApp    = document.getElementById('editorSendInApp');
const editorSendEmail    = document.getElementById('editorSendEmail');
const editorSubjectField = document.getElementById('editorSubjectField');
const editorSubjectInput = document.getElementById('editorSubjectInput');
const editorBodyInput    = document.getElementById('editorBodyInput');
const editorTokenError   = document.getElementById('editorTokenError');
const tokenPicker        = document.getElementById('tokenPicker');
const editorPreview      = document.getElementById('editorPreview');
const editorModalSave    = document.getElementById('editorModalSave');

// ── UTILITIES ────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function setModalMsg(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `modal-message ${type}`;
}
function openModal(modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; }
function closeModal(modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
}

// ── LOAD ─────────────────────────────────────────────────────────
async function loadAll() {
  const [{ data: triggerRows }, { data: templateRows }] = await Promise.all([
    supabase.from('notification_trigger').select('*').order('sort_order', { ascending: true }),
    supabase.from('notification_template').select('*'),
  ]);

  triggers = triggerRows || [];
  templates = {};
  (templateRows || []).forEach(t => { templates[t.trigger_code] = t; });

  renderTriggerList();
  populateLogTriggerFilter();
  await loadLog();
}

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER LIST
// ═══════════════════════════════════════════════════════════════════════════
function renderTriggerList() {
  triggerList.innerHTML = triggers.map(t => {
    const tpl = templates[t.code];
    if (!tpl) return '';
    const locked = !t.is_disableable;
    return `
      <div class="trigger-row ${tpl.is_enabled ? '' : 'is-disabled'}" data-code="${escapeHtml(t.code)}">
        <label class="pm2-toggle" title="${locked ? 'This notification is required and cannot be turned off' : (tpl.is_enabled ? 'Turn off' : 'Turn on')}">
          <input type="checkbox" data-trigger-toggle="${escapeHtml(t.code)}" ${tpl.is_enabled ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${tpl.is_enabled ? 'Deactivate' : 'Activate'} ${escapeHtml(t.label)}">
          <span class="pm2-toggle-track"></span>
        </label>
        <div class="trigger-body">
          <div class="trigger-label-row">
            <span class="trigger-label">${escapeHtml(t.label)}</span>
            ${locked ? '<span class="trigger-required-pill">Required</span>' : ''}
          </div>
          <p class="trigger-desc">${escapeHtml(t.description)}</p>
        </div>
        <div class="trigger-channels">
          ${REMINDER_TRIGGER_CODES.has(t.code)
            ? `<span class="timing-pill">${Number.isFinite(tpl.lead_days) ? `${tpl.lead_days} day${tpl.lead_days === 1 ? '' : 's'} before` : 'Not timed yet'}</span>`
            : ''}
          <span class="channel-pill ${tpl.send_in_app ? 'is-on' : ''}">In-app</span>
          <span class="channel-pill ${tpl.send_email ? 'is-on' : ''}">Email</span>
        </div>
        <div class="trigger-actions">
          <button type="button" class="btn-outline-sm" data-edit-trigger="${escapeHtml(t.code)}">Edit message</button>
        </div>
      </div>`;
  }).join('');
}

triggerList.addEventListener('click', e => {
  const editBtn = e.target.closest('[data-edit-trigger]');
  if (editBtn) openEditor(editBtn.dataset.editTrigger);
});

triggerList.addEventListener('change', async e => {
  const toggle = e.target.closest('[data-trigger-toggle]');
  if (!toggle) return;
  const code = toggle.dataset.triggerToggle;
  const trigger = triggers.find(t => t.code === code);
  if (!trigger || !trigger.is_disableable) { toggle.checked = templates[code]?.is_enabled ?? true; return; }

  const nextEnabled = toggle.checked;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('notification_template')
      .update({ is_enabled: nextEnabled, updated_at: new Date().toISOString(), updated_by: user?.id ?? null })
      .eq('trigger_code', code);
    if (error) throw error;
    templates[code].is_enabled = nextEnabled;
    await logAudit({ action: nextEnabled ? 'Enabled Notification' : 'Disabled Notification', category: 'notifications_config', details: `${trigger.label} ${nextEnabled ? 'enabled' : 'disabled'}`, entityId: code });
    renderTriggerList();
  } catch (err) {
    toggle.checked = !nextEnabled;
    alert(`Failed to update: ${err.message}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE EDITOR
// ═══════════════════════════════════════════════════════════════════════════
function renderTokenPicker() {
  tokenPicker.innerHTML = Object.entries(TOKEN_INFO).map(([token, desc]) =>
    `<button type="button" class="token-chip" data-token="${escapeHtml(token)}" title="${escapeHtml(desc)}">{{${escapeHtml(token)}}}</button>`
  ).join('');
}

tokenPicker.addEventListener('click', e => {
  const chip = e.target.closest('[data-token]');
  if (!chip) return;
  const token = `{{${chip.dataset.token}}}`;
  const el = editorBodyInput;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + token.length;
  updateEditorPreview();
});

function updateEditorPreview() {
  const body = editorBodyInput.value;
  const unknown = findUnknownTokens(body);
  if (unknown.length) {
    editorTokenError.textContent = `Unknown token${unknown.length === 1 ? '' : 's'}: ${unknown.map(t => `{{${t}}}`).join(', ')} — fix before saving.`;
    editorTokenError.className = 'modal-hint error';
  } else {
    editorTokenError.textContent = '';
    editorTokenError.className = 'modal-hint';
  }

  const showEmail = editorSendEmail.checked;
  const subjectHtml = showEmail
    ? `<div class="preview-subject">${escapeHtml(mergeTokens(editorSubjectInput.value || '(no subject)', SAMPLE_RESERVATION))}</div>`
    : '';
  editorPreview.innerHTML = subjectHtml + escapeHtml(mergeTokens(body, SAMPLE_RESERVATION));
}

editorBodyInput.addEventListener('input', updateEditorPreview);
editorSubjectInput.addEventListener('input', updateEditorPreview);
editorSendEmail.addEventListener('change', () => {
  editorSubjectField.style.display = editorSendEmail.checked ? '' : 'none';
  updateEditorPreview();
});

function openEditor(triggerCode) {
  const trigger = triggers.find(t => t.code === triggerCode);
  const tpl = templates[triggerCode];
  if (!trigger || !tpl) return;

  editingTriggerCode = triggerCode;
  editorModalTitle.textContent = `Edit Message — ${trigger.label}`;
  editorModalSub.textContent = trigger.description;

  const isReminder = REMINDER_TRIGGER_CODES.has(triggerCode);
  editorLeadDaysField.style.display = isReminder ? '' : 'none';
  editorLeadDaysInput.value = isReminder ? (tpl.lead_days ?? '') : '';

  editorSendInApp.checked = tpl.send_in_app;
  editorSendEmail.checked = tpl.send_email;
  editorSubjectInput.value = tpl.email_subject || '';
  editorBodyInput.value = tpl.body || '';
  editorSubjectField.style.display = tpl.send_email ? '' : 'none';

  renderTokenPicker();
  updateEditorPreview();
  setModalMsg(editorModalMessage, '');
  openModal(editorModal);
}

editorModalSave.addEventListener('click', async () => {
  const body = editorBodyInput.value.trim();
  if (!body) { setModalMsg(editorModalMessage, 'Message body is required.'); return; }
  if (!editorSendInApp.checked && !editorSendEmail.checked) { setModalMsg(editorModalMessage, 'At least one channel must be selected.'); return; }

  const isReminder = REMINDER_TRIGGER_CODES.has(editingTriggerCode);
  let leadDays = null;
  if (isReminder) {
    leadDays = Number(editorLeadDaysInput.value);
    if (!Number.isFinite(leadDays) || leadDays < 0 || !Number.isInteger(leadDays)) {
      setModalMsg(editorModalMessage, 'Days before must be a whole number, zero or more.');
      return;
    }
  }

  const unknownBody = findUnknownTokens(body);
  const unknownSubject = editorSendEmail.checked ? findUnknownTokens(editorSubjectInput.value) : [];
  const unknown = [...new Set([...unknownBody, ...unknownSubject])];
  if (unknown.length) {
    setModalMsg(editorModalMessage, `Unknown token${unknown.length === 1 ? '' : 's'}: ${unknown.map(t => `{{${t}}}`).join(', ')} — fix before saving.`);
    return;
  }

  editorModalSave.disabled = true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      send_in_app: editorSendInApp.checked,
      send_email: editorSendEmail.checked,
      email_subject: editorSendEmail.checked ? (editorSubjectInput.value.trim() || null) : null,
      body,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
    };
    // Only reminder triggers ever get lead_days written — omitted entirely
    // for the other 6, so that column stays null for them, never touched.
    if (isReminder) payload.lead_days = leadDays;

    const { error } = await supabase.from('notification_template').update(payload).eq('trigger_code', editingTriggerCode);
    if (error) throw error;

    templates[editingTriggerCode] = { ...templates[editingTriggerCode], ...payload };
    const trigger = triggers.find(t => t.code === editingTriggerCode);
    await logAudit({ action: 'Updated Notification Message', category: 'notifications_config', details: `Updated message for "${trigger?.label}"`, entityId: editingTriggerCode });

    renderTriggerList();
    closeModal(editorModal);
  } catch (err) {
    setModalMsg(editorModalMessage, `Failed to save: ${err.message}`);
  } finally {
    editorModalSave.disabled = false;
  }
});

document.getElementById('editorModalClose').addEventListener('click', () => closeModal(editorModal));
document.getElementById('editorModalCancel').addEventListener('click', () => closeModal(editorModal));
editorModal.addEventListener('click', e => { if (e.target === editorModal) closeModal(editorModal); });

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY LOG (read-only)
// ═══════════════════════════════════════════════════════════════════════════
function populateLogTriggerFilter() {
  logTriggerFilter.innerHTML = '<option value="">All triggers</option>' +
    triggers.map(t => `<option value="${escapeHtml(t.code)}">${escapeHtml(t.label)}</option>`).join('');
}

async function loadLog() {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('id, trigger_code, channel, status, created_at, sent_at, user_id')
      .not('trigger_code', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    logRows = data || [];
    renderLog();
  } catch (err) {
    logTableBody.innerHTML = `<tr class="log-empty"><td colspan="5">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderLog() {
  const triggerF = logTriggerFilter.value;
  const statusF = logStatusFilter.value;

  const filtered = logRows.filter(r =>
    (!triggerF || r.trigger_code === triggerF) &&
    (!statusF || r.status === statusF)
  );

  if (!filtered.length) {
    logTableBody.innerHTML = '<tr class="log-empty"><td colspan="5">No notifications yet. They\'ll appear here once one of the triggers above fires.</td></tr>';
    return;
  }

  logTableBody.innerHTML = filtered.map(r => {
    const trigger = triggers.find(t => t.code === r.trigger_code);
    return `<tr>
      <td>${escapeHtml(trigger?.label || r.trigger_code)}</td>
      <td class="mono">${escapeHtml(String(r.user_id || '').slice(0, 8))}…</td>
      <td>${r.channel === 'email' ? 'Email' : 'In-app'}</td>
      <td>${fmtDate(r.sent_at || r.created_at)}</td>
      <td><span class="status-pill ${r.status}">${escapeHtml(r.status)}</span></td>
    </tr>`;
  }).join('');
}

logTriggerFilter.addEventListener('change', renderLog);
logStatusFilter.addEventListener('change', renderLog);

// ── KEYBOARD: Escape closes modal ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !editorModal.classList.contains('hidden')) closeModal(editorModal);
});

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
  setupInactivityLogout(result.profile.role);
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });
  loadAll();
}

init();
