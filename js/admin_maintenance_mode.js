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

const titleInput = document.getElementById('mmTitleInput');
const messageInput = document.getElementById('mmMessageInput');
const formMessage = document.getElementById('mmFormMessage');
const saveContentBtn = document.getElementById('mmSaveContentBtn');
const previewFrame = document.getElementById('mmPreviewFrame');

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
