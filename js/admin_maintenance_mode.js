// admin_maintenance_mode.js — Maintenance Mode (Maintenance module, Part C)
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { buildMaintenancePageHtml } from './maintenance_template.js';

// ── STATE ────────────────────────────────────────────────────────
let mode = null;
let businessContact = null;

// ── DOM refs ─────────────────────────────────────────────────────
const stateLabel = document.getElementById('mmStateLabel');
const stateDetail = document.getElementById('mmStateDetail');
const toggleBtn = document.getElementById('mmToggleBtn');

const scheduleDetail = document.getElementById('mmScheduleDetail');

const titleInput = document.getElementById('mmTitleInput');
const messageInput = document.getElementById('mmMessageInput');
const formMessage = document.getElementById('mmFormMessage');
const saveContentBtn = document.getElementById('mmSaveContentBtn');
const previewFrame = document.getElementById('mmPreviewFrame');

const scheduledStartInput = document.getElementById('mmScheduledStartInput');
const scheduledEndInput = document.getElementById('mmScheduledEndInput');
const scheduleMessage = document.getElementById('mmScheduleMessage');
const saveScheduleBtn = document.getElementById('mmSaveScheduleBtn');
const clearScheduleBtn = document.getElementById('mmClearScheduleBtn');

const confirmModal = document.getElementById('mmConfirmModal');
const confirmOk = document.getElementById('mmConfirmOk');
const confirmCancel = document.getElementById('mmConfirmCancel');
const confirmClose = document.getElementById('mmConfirmClose');

// ── UTILITIES ────────────────────────────────────────────────────
function setFormMsg(msg, type = 'error') {
  if (!msg) { formMessage.className = 'modal-message hidden'; formMessage.textContent = ''; return; }
  formMessage.textContent = msg;
  formMessage.className = `modal-message ${type}`;
}
function openModal(modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; }
function closeModal(modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
function setScheduleMsg(msg, type = 'error') {
  if (!msg) { scheduleMessage.className = 'modal-message hidden'; scheduleMessage.textContent = ''; return; }
  scheduleMessage.textContent = msg;
  scheduleMessage.className = `modal-message ${type}`;
}
// <input type="datetime-local"> takes/returns "YYYY-MM-DDTHH:mm" with no
// timezone, interpreted as local time by both the browser and `new Date()`
// — matches how the admin actually thinks about "turn on at 2am."
function toDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocalValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function updatePreview() {
  const html = buildMaintenancePageHtml({
    title: titleInput.value,
    message: messageInput.value,
    brandName: businessContact?.brand_name,
    logoUrl: businessContact?.logo_url
  });
  previewFrame.srcdoc = html;
}

function renderState(turnedOnByName) {
  const isOn = mode.is_on;
  stateLabel.textContent = isOn ? 'Site is in MAINTENANCE' : 'Site is LIVE';
  stateLabel.className = `mm-state-label ${isOn ? 'is-off' : 'is-on'}`;

  if (mode.turned_on_at) {
    const who = turnedOnByName ? ` by ${turnedOnByName}` : '';
    stateDetail.textContent = isOn
      ? `Turned on ${fmtDateTime(mode.turned_on_at)}${who}.`
      : `Last turned on ${fmtDateTime(mode.turned_on_at)}${who}.`;
  } else {
    stateDetail.textContent = '';
  }

  toggleBtn.disabled = false;
  toggleBtn.textContent = isOn ? 'Turn Off Maintenance Mode' : 'Turn On Maintenance Mode';
  toggleBtn.className = `btn-primary ${isOn ? 'mm-btn-off' : 'mm-btn-on'}`;

  const scheduleParts = [];
  if (mode.scheduled_start) scheduleParts.push(`turns on ${fmtDateTime(mode.scheduled_start)}`);
  if (mode.scheduled_end) scheduleParts.push(`turns off ${fmtDateTime(mode.scheduled_end)}`);
  scheduleDetail.textContent = scheduleParts.length ? `Scheduled: ${scheduleParts.join(', ')}.` : '';
}

// ── LOAD ─────────────────────────────────────────────────────────
async function loadAll() {
  const [{ data: modeRow, error: modeErr }, { data: contactRow }] = await Promise.all([
    supabase.from('maintenance_mode').select('*').eq('id', true).maybeSingle(),
    supabase.from('business_contact').select('brand_name, logo_url').eq('id', true).maybeSingle()
  ]);

  if (modeErr || !modeRow) {
    stateLabel.textContent = 'Failed to load maintenance status.';
    return;
  }

  mode = modeRow;
  businessContact = contactRow || null;

  titleInput.value = mode.title || '';
  messageInput.value = mode.message || '';
  scheduledStartInput.value = toDatetimeLocalValue(mode.scheduled_start);
  scheduledEndInput.value = toDatetimeLocalValue(mode.scheduled_end);
  updatePreview();

  let turnedOnByName = '';
  if (mode.turned_on_by) {
    const { data: profile } = await supabase.from('profiles').select('first_name, last_name').eq('user_id', mode.turned_on_by).maybeSingle();
    if (profile) turnedOnByName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
  }

  renderState(turnedOnByName);
}

// ── LIVE PREVIEW WIRING ──────────────────────────────────────────
titleInput.addEventListener('input', updatePreview);
messageInput.addEventListener('input', updatePreview);

// ── SAVE MESSAGE ─────────────────────────────────────────────────
saveContentBtn.addEventListener('click', async () => {
  setFormMsg('');
  const title = titleInput.value.trim();
  const message = messageInput.value.trim();
  if (!title || !message) { setFormMsg('Title and message are both required.'); return; }

  saveContentBtn.disabled = true;
  try {
    const { error } = await supabase.from('maintenance_mode').update({ title, message }).eq('id', true);
    if (error) throw error;

    await logAudit({ action: 'Updated Maintenance Page Content', category: 'maintenance_mode', details: title.slice(0, 80) });
    mode.title = title;
    mode.message = message;
    setFormMsg('Saved.', 'success');
  } catch (err) {
    setFormMsg(`Failed to save: ${err.message}`);
  } finally {
    saveContentBtn.disabled = false;
  }
});

// ── TOGGLE ───────────────────────────────────────────────────────
toggleBtn.addEventListener('click', async () => {
  if (mode.is_on) {
    // Turning off needs no confirmation — it's the safe direction.
    toggleBtn.disabled = true;
    try {
      const { error } = await supabase.from('maintenance_mode').update({ is_on: false }).eq('id', true);
      if (error) throw error;
      await logAudit({ action: 'Turned Off Maintenance Mode', category: 'maintenance_mode', details: 'Customer site restored.' });
      await loadAll();
    } catch (err) {
      alert(`Failed to turn off: ${err.message}`);
      toggleBtn.disabled = false;
    }
    return;
  }

  openModal(confirmModal);
});

confirmCancel.addEventListener('click', () => closeModal(confirmModal));
confirmClose.addEventListener('click', () => closeModal(confirmModal));
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

confirmOk.addEventListener('click', async () => {
  confirmOk.disabled = true;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from('maintenance_mode').update({
      is_on: true,
      turned_on_at: new Date().toISOString(),
      turned_on_by: user?.id ?? null
    }).eq('id', true);
    if (error) throw error;

    await logAudit({ action: 'Turned On Maintenance Mode', category: 'maintenance_mode', details: 'Customer site taken offline.' });
    closeModal(confirmModal);
    await loadAll();
  } catch (err) {
    alert(`Failed to turn on: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
  }
});

// ── SCHEDULE ─────────────────────────────────────────────────────
// Enforcement is a pg_cron job (apply_scheduled_maintenance_mode(), every 5
// minutes — see 20260818_flagged_fixes.sql) that flips is_on when now()
// passes scheduled_start/scheduled_end, then clears whichever field it
// acted on so it's a one-shot schedule, not a recurring one, and can't
// fight a later manual toggle.
saveScheduleBtn.addEventListener('click', async () => {
  setScheduleMsg('');
  const scheduledStart = fromDatetimeLocalValue(scheduledStartInput.value);
  const scheduledEnd = fromDatetimeLocalValue(scheduledEndInput.value);

  if (scheduledStart && scheduledEnd && new Date(scheduledEnd) <= new Date(scheduledStart)) {
    setScheduleMsg('Turn-off time must be after turn-on time.');
    return;
  }

  saveScheduleBtn.disabled = true;
  try {
    const { error } = await supabase.from('maintenance_mode')
      .update({ scheduled_start: scheduledStart, scheduled_end: scheduledEnd })
      .eq('id', true);
    if (error) throw error;

    mode.scheduled_start = scheduledStart;
    mode.scheduled_end = scheduledEnd;
    await logAudit({ action: 'Updated Maintenance Schedule', category: 'maintenance_mode', details: `start=${scheduledStart || 'none'}, end=${scheduledEnd || 'none'}` });
    setScheduleMsg('Schedule saved.', 'success');
    renderState();
  } catch (err) {
    setScheduleMsg(`Failed to save: ${err.message}`);
  } finally {
    saveScheduleBtn.disabled = false;
  }
});

clearScheduleBtn.addEventListener('click', async () => {
  setScheduleMsg('');
  clearScheduleBtn.disabled = true;
  try {
    const { error } = await supabase.from('maintenance_mode')
      .update({ scheduled_start: null, scheduled_end: null })
      .eq('id', true);
    if (error) throw error;

    mode.scheduled_start = null;
    mode.scheduled_end = null;
    scheduledStartInput.value = '';
    scheduledEndInput.value = '';
    await logAudit({ action: 'Cleared Maintenance Schedule', category: 'maintenance_mode', details: 'Schedule removed — manual switch only.' });
    setScheduleMsg('Schedule cleared.', 'success');
    renderState();
  } catch (err) {
    setScheduleMsg(`Failed to clear: ${err.message}`);
  } finally {
    clearScheduleBtn.disabled = false;
  }
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
