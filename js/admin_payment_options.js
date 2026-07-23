// admin_payment_options.js
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { uploadToCloudinary } from './cloudinary_payment_methods.js';
import { logAudit } from './audit_logger.js';
import { initAdminNav } from './admin_nav.js';

// ── Confirm modal (Payment Rules) ────────────────────────────────────────────
function showSettingsConfirm(title, oldValueLabel, newValueLabel, onConfirm) {
  const modal = document.getElementById('settingsConfirmModal');
  if (!modal) { onConfirm(); return; }

  document.getElementById('settingsConfirmTitle').textContent = title;
  document.getElementById('settingsConfirmCopy').textContent = `${oldValueLabel} → ${newValueLabel}`;

  document.getElementById('settingsConfirmOk').onclick = () => {
    modal.classList.add('hidden');
    onConfirm();
  };
  document.getElementById('settingsConfirmCancel').onclick = () => modal.classList.add('hidden');
  modal.classList.remove('hidden');
}

// ── Payment methods ───────────────────────────────────────────────────────
let pm2Methods = [];
let pm2EditingId = null;
let pm2PendingFile = null;
let pm2PendingToggle = null;

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setPm2Message(msg, isError = false) {
  const el = document.getElementById('pm2-message');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function pm2DetailLabel(method) {
  if (method.type === 'bank') return method.account_number ? `•••• ${String(method.account_number).slice(-4)}` : '—';
  if (method.type === 'ewallet') return method.phone_number || '—';
  if (method.type === 'cash') return method.pay_location || `${method.cash_window_days ?? '?'} day(s) before event`;
  return '—';
}

function renderPm2Rows() {
  const body = document.getElementById('pm2Body');
  if (!body) return;

  if (!pm2Methods.length) {
    body.innerHTML = `<tr><td colspan="6">No payment methods yet — add one so customers can pay.</td></tr>`;
    return;
  }

  body.innerHTML = pm2Methods.map((m) => `
    <tr>
      <td class="pm2-label-cell">${escHtml(m.label)}</td>
      <td><span class="pm2-type-pill ${escHtml(m.type)}">${escHtml(m.type)}</span></td>
      <td class="pm2-detail-cell">${escHtml(pm2DetailLabel(m))}</td>
      <td>${m.qr_image ? `<img class="pm2-qr-thumb" src="${escHtml(m.qr_image)}" alt="QR for ${escHtml(m.label)}">` : '—'}</td>
      <td>
        <label class="pm2-toggle">
          <input type="checkbox" class="pm2-active-toggle" data-id="${escHtml(m.payment_method_id)}" ${m.is_active ? 'checked' : ''}>
          <span class="pm2-toggle-track"></span>
        </label>
      </td>
      <td class="pm2-actions-cell">
        <button type="button" class="action-btn view pm2-edit-btn" data-id="${escHtml(m.payment_method_id)}">Edit</button>
      </td>
    </tr>
  `).join('');
}

async function loadPaymentMethods() {
  const body = document.getElementById('pm2Body');
  if (!body) return;

  const { data, error } = await supabase
    .from('payment_method')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    body.innerHTML = `<tr><td colspan="6">Failed to load payment methods.</td></tr>`;
    setPm2Message('Failed to load: ' + error.message, true);
    return;
  }

  pm2Methods = data || [];
  renderPm2Rows();
}

function pm2SetTypeFields(type) {
  document.querySelectorAll('.pm2-fields-bank').forEach(el => { el.style.display = type === 'bank' ? '' : 'none'; });
  document.querySelectorAll('.pm2-fields-ewallet').forEach(el => { el.style.display = type === 'ewallet' ? '' : 'none'; });
  document.querySelectorAll('.pm2-fields-cash').forEach(el => { el.style.display = type === 'cash' ? '' : 'none'; });
}

function pm2UpdatePreview() {
  const type = document.getElementById('pm2Type')?.value;
  const label = document.getElementById('pm2Label')?.value || '(no label)';
  const lines = [label];

  if (type === 'bank') {
    lines.push(document.getElementById('pm2AccountName')?.value || '');
    lines.push(document.getElementById('pm2AccountNumber')?.value || '');
  } else if (type === 'ewallet') {
    lines.push(document.getElementById('pm2AccountName')?.value || '');
    lines.push(document.getElementById('pm2PhoneNumber')?.value || '');
  } else if (type === 'cash') {
    lines.push(document.getElementById('pm2Instructions')?.value || '');
    const days = document.getElementById('pm2CashWindowDays')?.value;
    if (days) lines.push(`Pay by ${days} day(s) before the event.`);
  }

  const preview = document.getElementById('pm2Preview');
  if (preview) preview.textContent = lines.filter(Boolean).join('\n') || '—';
}

function pm2ResetModal() {
  pm2EditingId = null;
  pm2PendingFile = null;
  document.getElementById('pm2Type').value = 'bank';
  document.getElementById('pm2Label').value = '';
  document.getElementById('pm2AccountName').value = '';
  document.getElementById('pm2AccountNumber').value = '';
  document.getElementById('pm2PhoneNumber').value = '';
  document.getElementById('pm2Instructions').value = '';
  document.getElementById('pm2CashWindowDays').value = '1';
  document.getElementById('pm2PayLocation').value = '';
  document.getElementById('pm2QrFile').value = '';
  document.getElementById('pm2QrPreviewImg').src = '';
  document.getElementById('pm2QrPreviewWrap').classList.add('hidden');
  document.getElementById('pm2ProgressWrap').classList.add('hidden');
  document.getElementById('pm2ModalMsg').textContent = '';
  pm2SetTypeFields('bank');
  pm2UpdatePreview();
}

function pm2OpenModal() { document.getElementById('pm2Modal')?.classList.remove('hidden'); }
function pm2CloseModal() { document.getElementById('pm2Modal')?.classList.add('hidden'); }

function openAddMethodModal() {
  pm2ResetModal();
  document.getElementById('pm2ModalEyebrow').textContent = 'Add Method';
  document.getElementById('pm2ModalTitle').textContent = 'Add payment method';
  document.getElementById('pm2ModalSave').textContent = 'Save method';
  pm2OpenModal();
}

function openEditMethodModal(id) {
  const method = pm2Methods.find(m => m.payment_method_id === id);
  if (!method) return;

  pm2ResetModal();
  pm2EditingId = id;
  document.getElementById('pm2ModalEyebrow').textContent = 'Edit Method';
  document.getElementById('pm2ModalTitle').textContent = 'Edit payment method';
  document.getElementById('pm2ModalSave').textContent = 'Save changes';
  document.getElementById('pm2Type').value = method.type;
  document.getElementById('pm2Label').value = method.label || '';
  document.getElementById('pm2AccountName').value = method.account_name || '';
  document.getElementById('pm2AccountNumber').value = method.account_number || '';
  document.getElementById('pm2PhoneNumber').value = method.phone_number || '';
  document.getElementById('pm2Instructions').value = method.instructions || '';
  document.getElementById('pm2CashWindowDays').value = method.cash_window_days ?? 1;
  document.getElementById('pm2PayLocation').value = method.pay_location || '';

  if (method.qr_image) {
    document.getElementById('pm2QrPreviewImg').src = method.qr_image;
    document.getElementById('pm2QrPreviewWrap').classList.remove('hidden');
  }

  pm2SetTypeFields(method.type);
  pm2UpdatePreview();
  pm2OpenModal();
}

function pm2ValidateFields(type, fields) {
  if (!fields.label) return 'Label is required.';
  if (type === 'bank') {
    if (!fields.account_name) return 'Account name is required for bank methods.';
    if (!fields.account_number) return 'Account number is required for bank methods.';
  } else if (type === 'ewallet') {
    if (!fields.account_name) return 'Account name is required for e-wallet methods.';
    if (!fields.phone_number) return 'Mobile number is required for e-wallet methods.';
  } else if (type === 'cash') {
    if (fields.cash_window_days === null || Number.isNaN(fields.cash_window_days) || fields.cash_window_days < 0) {
      return 'Latest pay-by (days before event) is required for cash methods.';
    }
  }
  return null;
}

function pm2ValidateFile(file) {
  if (!file) return null;
  if (!['image/png', 'image/jpeg'].includes(file.type)) return 'QR image must be PNG or JPG.';
  if (file.size > 2 * 1024 * 1024) return 'QR image must be 2 MB or smaller.';
  return null;
}

function pm2HandleFileChange(e) {
  const file = e.target.files[0] || null;
  const msgEl = document.getElementById('pm2ModalMsg');
  const err = pm2ValidateFile(file);

  if (err) {
    if (msgEl) { msgEl.textContent = err; msgEl.style.color = '#c0392b'; }
    e.target.value = '';
    pm2PendingFile = null;
    return;
  }

  pm2PendingFile = file;
  if (file) {
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('pm2QrPreviewImg').src = reader.result;
      document.getElementById('pm2QrPreviewWrap').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  }
}

async function pm2SaveMethod() {
  const msgEl = document.getElementById('pm2ModalMsg');
  const setMsg = (m, isErr = false) => { if (msgEl) { msgEl.textContent = m; msgEl.style.color = isErr ? '#c0392b' : '#27ae60'; } };

  const type = document.getElementById('pm2Type').value;
  const fields = {
    label: document.getElementById('pm2Label').value.trim(),
    account_name: document.getElementById('pm2AccountName').value.trim() || null,
    account_number: document.getElementById('pm2AccountNumber').value.trim() || null,
    phone_number: document.getElementById('pm2PhoneNumber').value.trim() || null,
    instructions: document.getElementById('pm2Instructions').value.trim() || null,
    cash_window_days: type === 'cash' ? Number(document.getElementById('pm2CashWindowDays').value) : null,
    pay_location: document.getElementById('pm2PayLocation').value.trim() || null,
  };

  const validationError = pm2ValidateFields(type, fields);
  if (validationError) { setMsg(validationError, true); return; }

  const saveBtn = document.getElementById('pm2ModalSave');
  saveBtn.disabled = true;
  setMsg('Saving…');

  try {
    let qrImage = pm2EditingId
      ? (pm2Methods.find(m => m.payment_method_id === pm2EditingId)?.qr_image ?? null)
      : null;

    if (pm2PendingFile) {
      setMsg('Uploading QR image…');
      const progressWrap = document.getElementById('pm2ProgressWrap');
      const progressBar = document.getElementById('pm2ProgressBar');
      progressWrap?.classList.remove('hidden');

      const safeName = pm2PendingFile.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_');
      const { secureUrl } = await uploadToCloudinary(pm2PendingFile, {
        publicId: `payment-methods/${Date.now()}_${safeName}`,
        onProgress: (pct) => { if (progressBar) progressBar.style.width = `${pct}%`; }
      });
      qrImage = secureUrl;
      progressWrap?.classList.add('hidden');
    }

    const payload = { type, ...fields, qr_image: qrImage };

    if (pm2EditingId) {
      const { error } = await supabase.from('payment_method').update(payload).eq('payment_method_id', pm2EditingId);
      if (error) throw error;
      await logAudit({ action: 'Updated Payment Method', category: 'payment_config', details: `Updated ${type} method: ${fields.label}`, entityId: pm2EditingId });
    } else {
      const { data, error } = await supabase.from('payment_method').insert({ ...payload, is_active: true }).select('payment_method_id').maybeSingle();
      if (error) throw error;
      await logAudit({ action: 'Added Payment Method', category: 'payment_config', details: `Added ${type} method: ${fields.label}`, entityId: data?.payment_method_id });
    }

    setMsg('Method saved.');
    await loadPaymentMethods();
    setTimeout(pm2CloseModal, 900);
  } catch (err) {
    setMsg('Failed to save: ' + err.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

function pm2HandleBodyChange(e) {
  const toggle = e.target.closest('.pm2-active-toggle');
  if (!toggle) return;

  const id = toggle.dataset.id;
  const method = pm2Methods.find(m => m.payment_method_id === id);
  if (!method) return;

  const activate = toggle.checked;
  toggle.checked = !activate; // revert until confirmed

  pm2PendingToggle = { id, activate };
  document.getElementById('pm2ConfirmTitle').textContent = activate ? 'Activate Method' : 'Deactivate Method';
  document.getElementById('pm2ConfirmCopy').textContent = activate
    ? `Activate "${method.label}"? Customers will see it at checkout again.`
    : `Deactivate "${method.label}"? Customers will no longer see it at checkout.`;
  document.getElementById('pm2ConfirmModal').classList.remove('hidden');
}

function pm2HandleBodyClick(e) {
  const btn = e.target.closest('.pm2-edit-btn');
  if (!btn) return;
  openEditMethodModal(btn.dataset.id);
}

async function pm2ConfirmToggle() {
  if (!pm2PendingToggle) return;
  const { id, activate } = pm2PendingToggle;
  const okBtn = document.getElementById('pm2ConfirmOk');
  okBtn.disabled = true;

  try {
    const { error } = await supabase.from('payment_method').update({ is_active: activate }).eq('payment_method_id', id);
    if (error) throw error;

    const method = pm2Methods.find(m => m.payment_method_id === id);
    await logAudit({
      action: activate ? 'Activated Payment Method' : 'Deactivated Payment Method',
      category: 'payment_config',
      details: `${activate ? 'Activated' : 'Deactivated'} method: ${method?.label}`,
      entityId: id
    });

    await loadPaymentMethods();
    setPm2Message(activate ? 'Method activated.' : 'Method deactivated.');
  } catch (err) {
    setPm2Message('Failed to update: ' + err.message, true);
  } finally {
    okBtn.disabled = false;
    pm2PendingToggle = null;
    document.getElementById('pm2ConfirmModal').classList.add('hidden');
  }
}

// ── Payment rules ────────────────────────────────────────────────────────────
// deposit_pct / full_payment_days already live under system_settings.
// reservation_rules (Settings → Reservation Rules tab) — deliberately not
// duplicated here to avoid two editable sources of truth for the same number.
const DEFAULT_PAYMENT_RULES = {
  max_installments: 2,
  auto_hold_enabled: true,
  refund_window_days: 14,
  currency: 'PHP'
};

function populatePaymentRulesFields(config) {
  const maxInst = document.getElementById('pr-max-installments');
  const autoHold = document.getElementById('pr-auto-hold');
  const refundWindow = document.getElementById('pr-refund-window');
  const currency = document.getElementById('pr-currency');
  if (maxInst) maxInst.value = config.max_installments ?? '';
  if (autoHold) autoHold.checked = !!config.auto_hold_enabled;
  if (refundWindow) refundWindow.value = config.refund_window_days ?? '';
  if (currency) currency.value = config.currency ?? 'PHP';
}

function readPaymentRulesFields() {
  return {
    max_installments: Number(document.getElementById('pr-max-installments')?.value),
    auto_hold_enabled: !!document.getElementById('pr-auto-hold')?.checked,
    refund_window_days: Number(document.getElementById('pr-refund-window')?.value),
    currency: 'PHP'
  };
}

function validatePaymentRules(config) {
  if (!Number.isFinite(config.max_installments) || config.max_installments < 1) return 'Maximum installments must be at least 1.';
  if (!Number.isFinite(config.refund_window_days) || config.refund_window_days < 0) return 'Refund window must be zero or more days.';
  return null;
}

function setPrMsg(msg, isError = false) {
  const el = document.getElementById('pr-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadPaymentRules() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  if (error || !data) {
    populatePaymentRulesFields(DEFAULT_PAYMENT_RULES);
    return;
  }
  populatePaymentRulesFields({ ...DEFAULT_PAYMENT_RULES, ...JSON.parse(data.setting_value) });
}

async function savePaymentRules() {
  const config = readPaymentRulesFields();
  const validationError = validatePaymentRules(config);
  if (validationError) { setPrMsg(validationError, true); return; }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();
  const oldConfig = current ? { ...DEFAULT_PAYMENT_RULES, ...JSON.parse(current.setting_value) } : DEFAULT_PAYMENT_RULES;

  showSettingsConfirm(
    'Change Payment Rules',
    `${oldConfig.max_installments} installments, ${oldConfig.refund_window_days}d refund window, auto-hold ${oldConfig.auto_hold_enabled ? 'on' : 'off'}`,
    `${config.max_installments} installments, ${config.refund_window_days}d refund window, auto-hold ${config.auto_hold_enabled ? 'on' : 'off'}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'payment_rules', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setPrMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Payment Rules', category: 'payment_config', details: JSON.stringify(config) });
      setPrMsg('Payment rules saved successfully.');
    }
  );
}

// ── Init ────────────────────────────────────────────────────────────────────
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
  const adminBadge = document.getElementById('adminBadge');
  if (adminBadge) adminBadge.textContent = result.profile.role === 'admin' ? 'Admin' : 'Manager';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });

  await loadPaymentMethods();
  await loadPaymentRules();

  document.getElementById('pm2AddBtn')?.addEventListener('click', openAddMethodModal);
  document.getElementById('pm2ModalCancel')?.addEventListener('click', pm2CloseModal);
  document.getElementById('pm2ModalSave')?.addEventListener('click', pm2SaveMethod);
  document.getElementById('pm2Type')?.addEventListener('change', (e) => {
    pm2SetTypeFields(e.target.value);
    pm2UpdatePreview();
  });
  ['pm2Label', 'pm2AccountName', 'pm2AccountNumber', 'pm2PhoneNumber', 'pm2Instructions', 'pm2CashWindowDays'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', pm2UpdatePreview);
  });
  document.getElementById('pm2QrFile')?.addEventListener('change', pm2HandleFileChange);
  document.getElementById('pm2Body')?.addEventListener('change', pm2HandleBodyChange);
  document.getElementById('pm2Body')?.addEventListener('click', pm2HandleBodyClick);
  document.getElementById('pm2ConfirmCancel')?.addEventListener('click', () => {
    pm2PendingToggle = null;
    document.getElementById('pm2ConfirmModal').classList.add('hidden');
  });
  document.getElementById('pm2ConfirmOk')?.addEventListener('click', pm2ConfirmToggle);

  document.getElementById('pr-save-btn')?.addEventListener('click', savePaymentRules);
}

init();
