// admin_payment_options.js
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { uploadToCloudinary } from './cloudinary_payment_methods.js';
import { logAudit } from './audit_logger.js';
import { initAdminNav } from './admin_nav.js';
import { paymentMethodIconSvg } from './admin_payment_method_icons.js';

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
// { type: 'toggle', id, activate } | { type: 'archive', id } | { type: 'delete', id }
let pm2PendingAction = null;

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
  if (method.type === 'cash' || method.type === 'card') return method.pay_location || `${method.cash_window_days ?? '?'} day(s) before event`;
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
      <td>
        <span class="pm2-icon-pill">
          ${paymentMethodIconSvg(m.icon_key)}
          <span class="pm2-type-pill ${escHtml(m.type)}">${escHtml(m.type)}</span>
        </span>
      </td>
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
        <button type="button" class="action-btn decline pm2-delete-btn" data-id="${escHtml(m.payment_method_id)}">Delete</button>
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

// icon_key defaults per type — matches the same 1:1 mapping the
// evidence_source DB trigger derives server-side (see the migration).
// Overridable per-method, this just seeds a sensible starting value
// whenever the type changes.
const PM2_DEFAULT_ICON_BY_TYPE = {
  bank: 'building-bank',
  ewallet: 'wallet',
  cash: 'cash',
  card: 'credit-card'
};

function pm2SetTypeFields(type) {
  document.querySelectorAll('.pm2-fields-bank').forEach(el => { el.style.display = type === 'bank' ? '' : 'none'; });
  document.querySelectorAll('.pm2-fields-ewallet').forEach(el => { el.style.display = type === 'ewallet' ? '' : 'none'; });
  // Card is the same on-site flow as cash (pick an arrival date, staff
  // confirms in person), so it reuses the exact same field group.
  document.querySelectorAll('.pm2-fields-cash').forEach(el => { el.style.display = (type === 'cash' || type === 'card') ? '' : 'none'; });
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
  } else if (type === 'cash' || type === 'card') {
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
  document.getElementById('pm2IconKey').value = PM2_DEFAULT_ICON_BY_TYPE.bank;
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
  document.getElementById('pm2IconKey').value = method.icon_key || PM2_DEFAULT_ICON_BY_TYPE[method.type] || 'receipt';

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
  } else if (type === 'cash' || type === 'card') {
    if (fields.cash_window_days === null || Number.isNaN(fields.cash_window_days) || fields.cash_window_days < 0) {
      return 'Latest pay-by (days before event) is required for cash and card methods.';
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
    cash_window_days: (type === 'cash' || type === 'card') ? Number(document.getElementById('pm2CashWindowDays').value) : null,
    pay_location: document.getElementById('pm2PayLocation').value.trim() || null,
    icon_key: document.getElementById('pm2IconKey').value || PM2_DEFAULT_ICON_BY_TYPE[type] || 'receipt',
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

  pm2PendingAction = { type: 'toggle', id, activate };
  document.getElementById('pm2ConfirmTitle').textContent = activate ? 'Activate Method' : 'Deactivate Method';
  document.getElementById('pm2ConfirmCopy').textContent = activate
    ? `Activate "${method.label}"? Customers will see it at checkout again.`
    : `Deactivate "${method.label}"? Customers will no longer see it at checkout.`;
  document.getElementById('pm2ConfirmOk').textContent = 'Confirm';
  document.getElementById('pm2ConfirmModal').classList.remove('hidden');
}

function pm2HandleBodyClick(e) {
  const editBtn = e.target.closest('.pm2-edit-btn');
  if (editBtn) {
    openEditMethodModal(editBtn.dataset.id);
    return;
  }

  const deleteBtn = e.target.closest('.pm2-delete-btn');
  if (deleteBtn) {
    pm2HandleDeleteClick(deleteBtn.dataset.id);
  }
}

// Zero payment references → offer a real delete. One or more → skip the
// delete confirm entirely and offer archive instead, showing the count.
async function pm2HandleDeleteClick(id) {
  const method = pm2Methods.find(m => m.payment_method_id === id);
  if (!method) return;

  setPm2Message('Checking payment history…');
  const { count, error } = await supabase
    .from('payment')
    .select('payment_id', { count: 'exact', head: true })
    .eq('payment_method_id', id);

  if (error) {
    setPm2Message('Failed to check payment references: ' + error.message, true);
    return;
  }
  setPm2Message('');

  if (count > 0) {
    pm2PendingAction = { type: 'archive', id };
    document.getElementById('pm2ConfirmTitle').textContent = 'Archive Instead';
    document.getElementById('pm2ConfirmCopy').textContent =
      `${count} payment${count === 1 ? '' : 's'} used this method. Archive it instead — it stays on those records but is hidden from customers.`;
    document.getElementById('pm2ConfirmOk').textContent = 'Archive';
  } else {
    pm2PendingAction = { type: 'delete', id };
    document.getElementById('pm2ConfirmTitle').textContent = 'Delete Method';
    document.getElementById('pm2ConfirmCopy').textContent = `Delete "${method.label}"? This can't be undone.`;
    document.getElementById('pm2ConfirmOk').textContent = 'Delete';
  }
  document.getElementById('pm2ConfirmModal').classList.remove('hidden');
}

async function pm2ConfirmAction() {
  if (!pm2PendingAction) return;
  const { type, id } = pm2PendingAction;
  const okBtn = document.getElementById('pm2ConfirmOk');
  okBtn.disabled = true;

  try {
    const method = pm2Methods.find(m => m.payment_method_id === id);

    if (type === 'toggle') {
      const activate = pm2PendingAction.activate;
      const { error } = await supabase.from('payment_method').update({ is_active: activate }).eq('payment_method_id', id);
      if (error) throw error;
      await logAudit({
        action: activate ? 'Activated Payment Method' : 'Deactivated Payment Method',
        category: 'payment_config',
        details: `${activate ? 'Activated' : 'Deactivated'} method: ${method?.label}`,
        entityId: id
      });
      await loadPaymentMethods();
      setPm2Message(activate ? 'Method activated.' : 'Method deactivated.');
    } else if (type === 'archive') {
      const { error } = await supabase.from('payment_method').update({ is_active: false }).eq('payment_method_id', id);
      if (error) throw error;
      await logAudit({
        action: 'Archived Payment Method',
        category: 'payment_config',
        details: `Archived method (has payment history): ${method?.label}`,
        entityId: id
      });
      await loadPaymentMethods();
      setPm2Message('Method archived.');
    } else if (type === 'delete') {
      const { data, error } = await supabase.functions.invoke('delete-payment-method', {
        body: { payment_method_id: id }
      });
      if (error) throw new Error(data?.error || error.message);
      await logAudit({
        action: 'Deleted Payment Method',
        category: 'payment_config',
        details: `Deleted method: ${method?.label}`,
        entityId: id
      });
      await loadPaymentMethods();
      setPm2Message('Method deleted.');
    }
  } catch (err) {
    setPm2Message('Failed: ' + err.message, true);
  } finally {
    okBtn.disabled = false;
    pm2PendingAction = null;
    document.getElementById('pm2ConfirmModal').classList.add('hidden');
  }
}

// ── Payment types ──────────────────────────────────────────────────────────
// Fixed 4 codes (reservation_fee, down_payment, full_payment, partial_payment)
// — no add/delete, deactivate instead, mirroring payment_method's own
// is_active pattern. Each row saves independently via its own Save button.
let ptTypes = [];

function setPtMessage(msg, isError = false) {
  const el = document.getElementById('pt-message');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function populatePaymentTypeRow(row) {
  const code = row.code;
  const labelEl = document.getElementById(`pt-${code}-label`);
  const activeEl = document.getElementById(`pt-${code}-active`);
  if (labelEl) labelEl.value = row.label || '';
  if (activeEl) activeEl.checked = !!row.is_active;

  if (code === 'reservation_fee') {
    const flatEl = document.getElementById('pt-reservation_fee-flat');
    if (flatEl) flatEl.value = row.flat_amount ?? '';
  } else if (code === 'down_payment') {
    const percentEl = document.getElementById('pt-down_payment-percent');
    if (percentEl) percentEl.value = row.percent_of_total ?? '';
  } else if (code === 'partial_payment') {
    const percentEl = document.getElementById('pt-partial_payment-percent');
    const floorEl = document.getElementById('pt-partial_payment-floor');
    if (percentEl) percentEl.value = row.percent_of_total ?? '';
    if (floorEl) floorEl.value = row.min_amount ?? '';
  }
}

async function loadPaymentTypes() {
  const { data, error } = await supabase
    .from('payment_type')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) {
    setPtMessage('Failed to load payment types: ' + error.message, true);
    return;
  }

  ptTypes = data || [];
  ptTypes.forEach(populatePaymentTypeRow);
}

function ptValidate(code, payload) {
  if (!payload.label) return 'Label is required.';
  if (code === 'reservation_fee') {
    if (!Number.isFinite(payload.flat_amount) || payload.flat_amount < 0) return 'Flat amount must be zero or more.';
  } else if (code === 'down_payment') {
    if (!Number.isFinite(payload.percent_of_total) || payload.percent_of_total < 0 || payload.percent_of_total > 100) return 'Percentage must be between 0 and 100.';
  } else if (code === 'partial_payment') {
    if (!Number.isFinite(payload.percent_of_total) || payload.percent_of_total < 0 || payload.percent_of_total > 100) return 'Minimum percentage must be between 0 and 100.';
    if (payload.min_amount !== null && (!Number.isFinite(payload.min_amount) || payload.min_amount < 0)) return 'Peso floor must be zero or more.';
  }
  return null;
}

async function ptSaveType(code) {
  const btn = document.querySelector(`.pt-save-btn[data-code="${code}"]`);
  const labelEl = document.getElementById(`pt-${code}-label`);
  const activeEl = document.getElementById(`pt-${code}-active`);

  const payload = {
    label: labelEl?.value.trim() || '',
    is_active: !!activeEl?.checked
  };

  if (code === 'reservation_fee') {
    payload.flat_amount = Number(document.getElementById('pt-reservation_fee-flat')?.value);
  } else if (code === 'down_payment') {
    payload.percent_of_total = Number(document.getElementById('pt-down_payment-percent')?.value);
  } else if (code === 'partial_payment') {
    payload.percent_of_total = Number(document.getElementById('pt-partial_payment-percent')?.value);
    const floorRaw = document.getElementById('pt-partial_payment-floor')?.value;
    payload.min_amount = floorRaw === '' ? null : Number(floorRaw);
  }

  const validationError = ptValidate(code, payload);
  if (validationError) { setPtMessage(validationError, true); return; }

  if (btn) btn.disabled = true;
  setPtMessage('Saving…');

  try {
    const { error } = await supabase.from('payment_type').update(payload).eq('code', code);
    if (error) throw error;
    await logAudit({
      action: 'Updated Payment Type',
      category: 'payment_config',
      details: `Updated ${code}: ${JSON.stringify(payload)}`,
      entityId: code
    });
    await loadPaymentTypes();
    setPtMessage('Saved.');
  } catch (err) {
    setPtMessage('Failed to save: ' + err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Payment rules ────────────────────────────────────────────────────────────
// deposit_pct is set on this page under Payment Types > Custom Amount
// (percent_of_total), not duplicated here. full_payment_days still lives in
// system_settings.reservation_rules, but that settings tab was removed
// (see super_admin_settings.html) — it's DB-only until a UI need for it
// comes back.
//
// cancellation_min_notice_days / cancellation_request_window_days moved to
// the "Cancellation Notice Rules" card on Availability and Scheduling
// (js/super_admin_settings.js) — this page no longer has inputs for them,
// but they still live in this same system_settings.payment_rules JSON blob.
// currentPaymentRulesConfig caches whatever was last loaded from the DB so
// savePaymentRules() below can pass those two fields straight through
// unchanged instead of wiping them out on every save from this page.
const DEFAULT_PAYMENT_RULES = {
  max_installments: 2,
  auto_hold_enabled: true,
  refund_window_days: 14,
  proof_of_payment_window_days: 3,
  currency: 'PHP',
  cancellation_fee_onsite: 500,
  cancellation_fee_offsite: 2000,
  reschedule_fee: 3000,
  service_charge_percent: 10,
  // Safe default: unchanged current behaviour (offsite charged 0%) until
  // an admin deliberately turns this on — the café has not confirmed
  // offsite should be charged, so this must never default to true.
  service_charge_applies_offsite: false,
  cancellation_min_notice_days: null,
  cancellation_request_window_days: null
};

let currentPaymentRulesConfig = DEFAULT_PAYMENT_RULES;

function populatePaymentRulesFields(config) {
  currentPaymentRulesConfig = config;
  const maxInst = document.getElementById('pr-max-installments');
  const autoHold = document.getElementById('pr-auto-hold');
  const refundWindow = document.getElementById('pr-refund-window');
  const proofWindow = document.getElementById('pr-proof-window');
  const currency = document.getElementById('pr-currency');
  const cancelOnsite = document.getElementById('pr-cancellation-fee-onsite');
  const cancelOffsite = document.getElementById('pr-cancellation-fee-offsite');
  const rescheduleFee = document.getElementById('pr-reschedule-fee');

  if (maxInst) maxInst.value = config.max_installments ?? '';
  if (autoHold) autoHold.checked = !!config.auto_hold_enabled;
  if (refundWindow) refundWindow.value = config.refund_window_days ?? '';
  if (proofWindow) proofWindow.value = config.proof_of_payment_window_days ?? '';
  if (currency) currency.value = config.currency ?? 'PHP';
  if (cancelOnsite) cancelOnsite.value = config.cancellation_fee_onsite ?? '';
  if (cancelOffsite) cancelOffsite.value = config.cancellation_fee_offsite ?? '';
  if (rescheduleFee) rescheduleFee.value = config.reschedule_fee ?? '';
}

function readPaymentRulesFields() {
  return {
    max_installments: Number(document.getElementById('pr-max-installments')?.value),
    auto_hold_enabled: !!document.getElementById('pr-auto-hold')?.checked,
    refund_window_days: Number(document.getElementById('pr-refund-window')?.value),
    proof_of_payment_window_days: Number(document.getElementById('pr-proof-window')?.value),
    currency: 'PHP',
    cancellation_fee_onsite: Number(document.getElementById('pr-cancellation-fee-onsite')?.value),
    cancellation_fee_offsite: Number(document.getElementById('pr-cancellation-fee-offsite')?.value),
    reschedule_fee: Number(document.getElementById('pr-reschedule-fee')?.value),
    // Not editable on this page anymore — pass through whatever is
    // currently saved so this page's save can't clobber the other page's card.
    cancellation_min_notice_days: currentPaymentRulesConfig.cancellation_min_notice_days ?? null,
    cancellation_request_window_days: currentPaymentRulesConfig.cancellation_request_window_days ?? null
  };
}

function validatePaymentRules(config) {
  if (!Number.isFinite(config.max_installments) || config.max_installments < 1) return 'Maximum installments must be at least 1.';
  if (!Number.isFinite(config.refund_window_days) || config.refund_window_days < 0) return 'Refund window must be zero or more days.';
  if (!Number.isFinite(config.proof_of_payment_window_days) || config.proof_of_payment_window_days < 0) return 'Proof of payment window must be zero or more days.';
  if (!Number.isFinite(config.cancellation_fee_onsite) || config.cancellation_fee_onsite < 0) return 'Onsite cancellation fee must be zero or more.';
  if (!Number.isFinite(config.cancellation_fee_offsite) || config.cancellation_fee_offsite < 0) return 'Offsite cancellation fee must be zero or more.';
  if (!Number.isFinite(config.reschedule_fee) || config.reschedule_fee < 0) return 'Reschedule fee must be zero or more.';
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
  // Re-sync the fields this form doesn't render with whatever is freshest
  // in the DB right before saving — this upsert replaces the whole JSON
  // blob, so any field readPaymentRulesFields() doesn't return would
  // otherwise silently revert to DEFAULT_PAYMENT_RULES the next time this
  // (unrelated) form is saved. cancellation_min_notice_days/_window_days
  // belong to the Availability and Scheduling page; service_charge_percent
  // and service_charge_applies_offsite belong to the Service Charge
  // section's own mini-save further down this same page.
  config.cancellation_min_notice_days = oldConfig.cancellation_min_notice_days ?? null;
  config.cancellation_request_window_days = oldConfig.cancellation_request_window_days ?? null;
  config.service_charge_percent = oldConfig.service_charge_percent;
  config.service_charge_applies_offsite = !!oldConfig.service_charge_applies_offsite;

  showSettingsConfirm(
    'Change Payment Rules',
    `${oldConfig.max_installments} installments, ${oldConfig.refund_window_days}d refund window, ${oldConfig.proof_of_payment_window_days}d proof-of-payment window, auto-hold ${oldConfig.auto_hold_enabled ? 'on' : 'off'}, cancellation fee ₱${oldConfig.cancellation_fee_onsite}/₱${oldConfig.cancellation_fee_offsite}, reschedule fee ₱${oldConfig.reschedule_fee}`,
    `${config.max_installments} installments, ${config.refund_window_days}d refund window, ${config.proof_of_payment_window_days}d proof-of-payment window, auto-hold ${config.auto_hold_enabled ? 'on' : 'off'}, cancellation fee ₱${config.cancellation_fee_onsite}/₱${config.cancellation_fee_offsite}, reschedule fee ₱${config.reschedule_fee}`,
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

// ── Service charge ───────────────────────────────────────────────────────────
// Global default and the offsite toggle live in the same system_settings.
// payment_rules blob as reschedule_fee/cancellation_fee (see
// DEFAULT_PAYMENT_RULES above) — this section has its own mini load/save so
// editing it doesn't require touching the rest of the Payment Rules form.
// Per-category override is a real column on package_category
// (service_charge_percent, null = inherit).
//
// Resolution used everywhere this actually applies (js/reservations.js,
// resolveServiceCharge()): offsite bookings are 0% UNLESS
// service_charge_applies_offsite is on, regardless of category (a category
// can hold both onsite and offsite packages, so category alone can't carry
// "offsite-only" intent); once on, offsite resolves exactly like onsite —
// coalesce(category override, this global default). Applies to the
// package + add-on total only; there's no separate travel-fee amount
// anywhere in this codebase to include or exclude.
let scCategories = [];

function setScMsg(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadServiceChargeSection() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  let globalPct = DEFAULT_PAYMENT_RULES.service_charge_percent;
  let appliesOffsite = DEFAULT_PAYMENT_RULES.service_charge_applies_offsite;
  if (data?.setting_value) {
    try {
      const parsed = JSON.parse(data.setting_value);
      if (Number.isFinite(Number(parsed.service_charge_percent))) globalPct = Number(parsed.service_charge_percent);
      appliesOffsite = !!parsed.service_charge_applies_offsite;
    } catch { /* keep defaults */ }
  }

  const globalInput = document.getElementById('sc-global-percent');
  if (globalInput) globalInput.value = globalPct;

  const offsiteToggle = document.getElementById('sc-offsite-toggle');
  if (offsiteToggle) offsiteToggle.checked = appliesOffsite;

  const { data: categories, error } = await supabase
    .from('package_category')
    .select('package_category_id, category_name, is_active, service_charge_percent')
    .order('sort_order', { ascending: true });

  const body = document.getElementById('sc-category-body');
  if (error || !categories) {
    if (body) body.innerHTML = '<tr><td colspan="4">Failed to load categories.</td></tr>';
  } else {
    scCategories = categories;
    renderCategoryOverrideTable(globalPct);
  }

  updateWorkedExample(globalPct, appliesOffsite);
}

function renderCategoryOverrideTable(globalPct) {
  const body = document.getElementById('sc-category-body');
  if (!body) return;

  if (!scCategories.length) {
    body.innerHTML = '<tr><td colspan="4">No categories yet.</td></tr>';
    return;
  }

  body.innerHTML = scCategories.map((cat) => {
    const hasOverride = cat.service_charge_percent !== null && cat.service_charge_percent !== undefined;
    const effective = hasOverride ? Number(cat.service_charge_percent) : globalPct;
    return `
      <tr data-category-id="${cat.package_category_id}">
        <td>${escapeHtmlSc(cat.category_name || 'Untitled')}${cat.is_active === false ? ' <span class="field-note" style="margin:0;">(inactive)</span>' : ''}</td>
        <td>${effective}%</td>
        <td>
          <input type="number" class="pr-input-inline sc-override-input" min="0" max="100" step="0.5"
                 placeholder="Inherits default (${globalPct}%)"
                 value="${hasOverride ? effective : ''}">
        </td>
        <td><button type="button" class="action-btn view sc-save-category-btn">Save</button></td>
      </tr>`;
  }).join('');
}

function escapeHtmlSc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function computeWorkedExample(base, pct) {
  const charge = Math.round(base * pct) / 100;
  const total = base + charge;
  const deposit = Math.round(total * 0.5);
  return { charge, total, deposit };
}

function updateWorkedExample(globalPctOverride, appliesOffsiteOverride) {
  const globalInput = document.getElementById('sc-global-percent');
  const pct = Number.isFinite(globalPctOverride) ? globalPctOverride : Number(globalInput?.value);
  const offsiteToggle = document.getElementById('sc-offsite-toggle');
  const appliesOffsite = typeof appliesOffsiteOverride === 'boolean' ? appliesOffsiteOverride : !!offsiteToggle?.checked;

  const exampleEl = document.getElementById('sc-example-text');
  const offsiteExampleEl = document.getElementById('sc-example-text-offsite');
  if (!Number.isFinite(pct)) return;

  const base = 28000;

  if (exampleEl) {
    const { charge, total, deposit } = computeWorkedExample(base, pct);
    exampleEl.textContent =
      `Onsite — on a ₱${base.toLocaleString()} package, a ${pct}% service charge adds ₱${charge.toLocaleString()} ` +
      `for a ₱${total.toLocaleString()} total; a 50% deposit is ₱${deposit.toLocaleString()}.`;
  }

  if (offsiteExampleEl) {
    const offsitePct = appliesOffsite ? pct : 0;
    const { charge, total, deposit } = computeWorkedExample(base, offsitePct);
    offsiteExampleEl.textContent = appliesOffsite
      ? `Offsite (toggle on) — the same ₱${base.toLocaleString()} package is charged the same ${offsitePct}%, adding ₱${charge.toLocaleString()} ` +
        `for a ₱${total.toLocaleString()} total; a 50% deposit is ₱${deposit.toLocaleString()}.`
      : `Offsite (toggle off) — the same ₱${base.toLocaleString()} package is charged 0% service charge, so the total stays ₱${total.toLocaleString()}; a 50% deposit is ₱${deposit.toLocaleString()}.`;
  }
}

async function saveGlobalServiceCharge() {
  const input = document.getElementById('sc-global-percent');
  const pct = Number(input?.value);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    setScMsg('sc-global-msg', 'Service charge must be between 0 and 100.', true);
    return;
  }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  let config = { ...DEFAULT_PAYMENT_RULES };
  if (current?.setting_value) {
    try { config = { ...DEFAULT_PAYMENT_RULES, ...JSON.parse(current.setting_value) }; } catch { /* use default */ }
  }
  config.service_charge_percent = pct;

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'payment_rules', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) { setScMsg('sc-global-msg', 'Failed to save: ' + error.message, true); return; }

  await logAudit({ action: 'Updated Service Charge Default', category: 'payment_config', details: `Global default set to ${pct}%` });
  setScMsg('sc-global-msg', 'Saved.');
  renderCategoryOverrideTable(pct);
  updateWorkedExample(pct);
}

async function saveOffsiteToggle() {
  const toggle = document.getElementById('sc-offsite-toggle');
  if (!toggle) return;
  const appliesOffsite = toggle.checked;

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  let config = { ...DEFAULT_PAYMENT_RULES };
  if (current?.setting_value) {
    try { config = { ...DEFAULT_PAYMENT_RULES, ...JSON.parse(current.setting_value) }; } catch { /* use default */ }
  }
  config.service_charge_applies_offsite = appliesOffsite;

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'payment_rules', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) {
    setScMsg('sc-offsite-msg', 'Failed to save: ' + error.message, true);
    toggle.checked = !appliesOffsite; // revert the visible toggle to match what's actually saved
    return;
  }

  await logAudit({
    action: 'Updated Offsite Service Charge Setting',
    category: 'payment_config',
    details: `Offsite packages now ${appliesOffsite ? 'DO' : 'do NOT'} receive the service charge`
  });
  setScMsg('sc-offsite-msg', 'Saved.');
  updateWorkedExample(Number(document.getElementById('sc-global-percent')?.value), appliesOffsite);
}

async function saveCategoryOverride(row) {
  const categoryId = row.dataset.categoryId;
  const input = row.querySelector('.sc-override-input');
  const raw = input?.value?.trim();
  const category = scCategories.find((c) => c.package_category_id === categoryId);

  // Empty input = clear the override (inherit the default again).
  let value = null;
  if (raw !== '') {
    value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setScMsg('sc-category-msg', 'Category override must be between 0 and 100, or left blank to inherit.', true);
      return;
    }
  }

  const { error } = await supabase
    .from('package_category')
    .update({ service_charge_percent: value })
    .eq('package_category_id', categoryId);

  if (error) { setScMsg('sc-category-msg', 'Failed to save: ' + error.message, true); return; }

  if (category) category.service_charge_percent = value;
  await logAudit({
    action: 'Updated Category Service Charge Override',
    category: 'payment_config',
    details: `${category?.category_name || categoryId}: ${value === null ? 'inherit default' : value + '%'}`
  });
  setScMsg('sc-category-msg', 'Saved.');
  const globalInput = document.getElementById('sc-global-percent');
  renderCategoryOverrideTable(Number(globalInput?.value) || DEFAULT_PAYMENT_RULES.service_charge_percent);
}

// ── Init ────────────────────────────────────────────────────────────────────
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
  const adminBadge = document.getElementById('adminBadge');
  if (adminBadge) adminBadge.textContent = result.profile.role === 'admin' ? 'Admin' : 'Manager';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });

  await loadPaymentMethods();
  await loadPaymentTypes();
  await loadPaymentRules();
  await loadServiceChargeSection();

  document.querySelectorAll('.pt-save-btn').forEach((btn) => {
    btn.addEventListener('click', () => ptSaveType(btn.dataset.code));
  });

  document.getElementById('pm2AddBtn')?.addEventListener('click', openAddMethodModal);
  document.getElementById('pm2ModalCancel')?.addEventListener('click', pm2CloseModal);
  document.getElementById('pm2ModalSave')?.addEventListener('click', pm2SaveMethod);
  document.getElementById('pm2Type')?.addEventListener('change', (e) => {
    pm2SetTypeFields(e.target.value);
    const iconField = document.getElementById('pm2IconKey');
    if (iconField) iconField.value = PM2_DEFAULT_ICON_BY_TYPE[e.target.value] || 'receipt';
    pm2UpdatePreview();
  });
  ['pm2Label', 'pm2AccountName', 'pm2AccountNumber', 'pm2PhoneNumber', 'pm2Instructions', 'pm2CashWindowDays'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', pm2UpdatePreview);
  });
  document.getElementById('pm2QrFile')?.addEventListener('change', pm2HandleFileChange);
  document.getElementById('pm2Body')?.addEventListener('change', pm2HandleBodyChange);
  document.getElementById('pm2Body')?.addEventListener('click', pm2HandleBodyClick);
  document.getElementById('pm2ConfirmCancel')?.addEventListener('click', () => {
    pm2PendingAction = null;
    document.getElementById('pm2ConfirmModal').classList.add('hidden');
  });
  document.getElementById('pm2ConfirmOk')?.addEventListener('click', pm2ConfirmAction);

  document.getElementById('pr-save-btn')?.addEventListener('click', savePaymentRules);

  document.getElementById('sc-save-global-btn')?.addEventListener('click', saveGlobalServiceCharge);
  document.getElementById('sc-global-percent')?.addEventListener('input', () => updateWorkedExample());
  document.getElementById('sc-save-offsite-btn')?.addEventListener('click', saveOffsiteToggle);
  // Live-preview the effect immediately on toggle, before the admin saves —
  // same "see it before committing" behaviour the global-percent input
  // already has above.
  document.getElementById('sc-offsite-toggle')?.addEventListener('change', () => updateWorkedExample());
  document.getElementById('sc-category-body')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sc-save-category-btn');
    if (!btn) return;
    saveCategoryOverride(btn.closest('tr'));
  });
}

init();