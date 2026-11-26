// admin_payment_options.js
import './money_inputs.js';
import { readTransportRules, priceTransportDistance, transportOrigins, TRANSPORT_DEFAULTS, TRANSPORT_DEFAULT_RANGES, MAX_TRANSPORT_KM } from './transport_fee.js';
import { formatMoney, moneyInputValue } from './money.js';
import { FEE_POLICY_DEFAULTS, getFeePolicy } from './reservation_shared.js';
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { uploadToCloudinary } from './cloudinary_payment_methods.js';
import { logAudit } from './audit_logger.js';
import { initAdminNav } from './admin_nav.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';
import { paymentMethodIconSvg } from './admin_payment_method_icons.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';
import { attachPhoneMask } from './phone_format.js';
import { clampNumberInput, clampNumberValue } from './numeric_input.js';

attachPhoneMask(document.getElementById('pm2PhoneNumber'));

// ── Confirm modal (Payment Rules) ────────────────────────────────────────────
function showSettingsConfirm(title, oldValueLabel, newValueLabel, onConfirm) {
  const modal = document.getElementById('settingsConfirmModal');
  if (!modal) { onConfirm(); return; }

  document.getElementById('settingsConfirmTitle').textContent = title;
  document.getElementById('settingsConfirmCopy').textContent = `${oldValueLabel} → ${newValueLabel}`;

  document.getElementById('settingsConfirmOk').onclick = () => {
    modal.classList.add('hidden');
    unlockBodyScroll();
    onConfirm();
  };
  document.getElementById('settingsConfirmCancel').onclick = () => {
    modal.classList.add('hidden');
    unlockBodyScroll();
  };
  modal.classList.remove('hidden');
  lockBodyScroll();
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
      <td class="pm2-label-cell" data-label="Label">${escHtml(m.label)}</td>
      <td data-label="Type">
        <span class="pm2-icon-pill">
          ${paymentMethodIconSvg(m.icon_key)}
          <span class="pm2-type-pill ${escHtml(m.type)}">${escHtml(m.type)}</span>
        </span>
      </td>
      <td class="pm2-detail-cell" data-label="Details">${escHtml(pm2DetailLabel(m))}</td>
      <td data-label="QR">${m.qr_image ? `<img class="pm2-qr-thumb" src="${escHtml(m.qr_image)}" alt="QR for ${escHtml(m.label)}">` : '—'}</td>
      <td data-label="Active">
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
  document.querySelectorAll('.pm2-fields-bank, .pm2-fields-ewallet').forEach(el => {
    const showForBank = type === 'bank' && el.classList.contains('pm2-fields-bank');
    const showForWallet = type === 'ewallet' && el.classList.contains('pm2-fields-ewallet');
    el.style.display = showForBank || showForWallet ? '' : 'none';
  });
  const accountName = document.getElementById('pm2AccountName');
  if (accountName) accountName.required = type === 'bank' || type === 'ewallet';
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
  document.getElementById('pm2Aliases').value = '';
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

function pm2OpenModal() { document.getElementById('pm2Modal')?.classList.remove('hidden'); lockBodyScroll(); }
function pm2CloseModal() { document.getElementById('pm2Modal')?.classList.add('hidden'); unlockBodyScroll(); }

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
  document.getElementById('pm2Aliases').value = Array.isArray(method.receipt_name_aliases) ? method.receipt_name_aliases.join(', ') : '';
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

// "Engeline Santos, E. Santos" -> ['Engeline Santos', 'E. Santos']. Trimmed,
// de-duplicated (case-insensitive), at most 10 names of 150 characters.
function parseReceiptAliases(raw) {
  const seen = new Set();
  const names = [];
  for (const part of String(raw || '').split(/[,\n;]/)) {
    const name = part.replace(/\s+/g, ' ').trim().slice(0, 150);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= 10) break;
  }
  return names;
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
    // Only bank / e-wallet receipts name a receiver; other types keep it empty.
    receipt_name_aliases: (type === 'bank' || type === 'ewallet')
      ? parseReceiptAliases(document.getElementById('pm2Aliases').value)
      : [],
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
  lockBodyScroll();
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
  lockBodyScroll();
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
    unlockBodyScroll();
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
    if (flatEl) flatEl.value = moneyInputValue(row.flat_amount);
  } else if (code === 'down_payment') {
    const percentEl = document.getElementById('pt-down_payment-percent');
    if (percentEl) percentEl.value = row.percent_of_total ?? '';
  } else if (code === 'partial_payment') {
    const percentEl = document.getElementById('pt-partial_payment-percent');
    const floorEl = document.getElementById('pt-partial_payment-floor');
    if (percentEl) percentEl.value = row.percent_of_total ?? '';
    if (floorEl) floorEl.value = moneyInputValue(row.min_amount);
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
// (percent_of_total), not duplicated here. full_payment_days and
// auto_cancel_days live in system_settings.reservation_rules and are edited
// in the "Payment Deadline and Grace Period" card below (see
// loadLatePaymentGrace / saveLatePaymentGrace). The rest of that blob
// (min_pax, etc.) has no admin UI and is DB-only.
//
// cancellation_min_notice_days / cancellation_request_window_days moved to
// the "Cancellation Notice Rules" card on Availability and Scheduling
// (js/super_admin_settings.js) — this page no longer has inputs for them,
// but they still live in this same system_settings.payment_rules JSON blob.
// currentPaymentRulesConfig caches whatever was last loaded from the DB so
// savePaymentRules() below can pass those two fields straight through
// unchanged instead of wiping them out on every save from this page.
const TRANSPORT_RULE_KEYS = ['transport_fee_enabled', 'transport_free_km', 'transport_ranges', 'transport_beyond', 'transport_rate_per_km', 'transport_max_fee', 'transport_road_factor', 'transport_package_overrides'];
const DEFAULT_PAYMENT_RULES = {
  max_installments: 2,
  auto_hold_enabled: true,
  proof_of_payment_window_days: 3,
  currency: 'PHP',
  // Flat fees: the overdue auto-cancel, and requests already in flight before
  // the percent policy (20261206). Customer-requested cancellations and
  // reschedules use the notice-based percentages below.
  cancellation_fee_onsite: 500,
  cancellation_fee_offsite: 2000,
  reschedule_fee: 3000,
  cancellation_fee_notice_days: FEE_POLICY_DEFAULTS.cancellationNoticeDays,
  cancellation_fee_percent: FEE_POLICY_DEFAULTS.cancellationFeePercent,
  reschedule_fee_notice_days: FEE_POLICY_DEFAULTS.rescheduleNoticeDays,
  reschedule_fee_percent: FEE_POLICY_DEFAULTS.rescheduleFeePercent,
  service_charge_percent: 10,
  // Safe default: unchanged current behaviour (offsite charged 0%) until
  // an admin deliberately turns this on — the café has not confirmed
  // offsite should be charged, so this must never default to true.
  service_charge_applies_offsite: false,
  // Transport fee (offsite) — owned by the Transport Fee card further down;
  // savePaymentRules() passes these straight through (see TRANSPORT_RULE_KEYS).
  // transport_free_km / transport_ranges / transport_beyond are deliberately
  // not defaulted here: until the Transport Fee card saves them, the helper
  // falls back to the old per-km rule so no live price changes.
  transport_fee_enabled: false,
  transport_road_factor: TRANSPORT_DEFAULTS.roadFactor,
  cancellation_min_notice_days: null,
  cancellation_request_window_days: null
};

let currentPaymentRulesConfig = DEFAULT_PAYMENT_RULES;

function populatePaymentRulesFields(config) {
  currentPaymentRulesConfig = config;
  const maxInst = document.getElementById('pr-max-installments');
  const autoHold = document.getElementById('pr-auto-hold');
  const proofWindow = document.getElementById('pr-proof-window');
  const currency = document.getElementById('pr-currency');
  const cancelOnsite = document.getElementById('pr-cancellation-fee-onsite');
  const cancelOffsite = document.getElementById('pr-cancellation-fee-offsite');
  const cancelNotice = document.getElementById('pr-cancellation-notice-days');
  const cancelPercent = document.getElementById('pr-cancellation-fee-percent');
  const rescheduleNotice = document.getElementById('pr-reschedule-notice-days');
  const reschedulePercent = document.getElementById('pr-reschedule-fee-percent');

  if (maxInst) maxInst.value = config.max_installments ?? '';
  if (autoHold) autoHold.checked = !!config.auto_hold_enabled;
  if (proofWindow) proofWindow.value = config.proof_of_payment_window_days ?? '';
  if (currency) currency.value = config.currency ?? 'PHP';
  if (cancelOnsite) cancelOnsite.value = moneyInputValue(config.cancellation_fee_onsite);
  if (cancelOffsite) cancelOffsite.value = moneyInputValue(config.cancellation_fee_offsite);
  const policy = getFeePolicy(config);
  if (cancelNotice) cancelNotice.value = policy.cancellationNoticeDays;
  if (cancelPercent) cancelPercent.value = policy.cancellationFeePercent;
  if (rescheduleNotice) rescheduleNotice.value = policy.rescheduleNoticeDays;
  if (reschedulePercent) reschedulePercent.value = policy.rescheduleFeePercent;
}

function readPaymentRulesFields() {
  return {
    max_installments: Number(document.getElementById('pr-max-installments')?.value),
    auto_hold_enabled: !!document.getElementById('pr-auto-hold')?.checked,
    proof_of_payment_window_days: Number(document.getElementById('pr-proof-window')?.value),
    currency: 'PHP',
    cancellation_fee_onsite: Number(document.getElementById('pr-cancellation-fee-onsite')?.value),
    cancellation_fee_offsite: Number(document.getElementById('pr-cancellation-fee-offsite')?.value),
    // The flat reschedule fee has no field any more (new requests use the
    // percentage); keep the saved value for requests made before it.
    reschedule_fee: Number(currentPaymentRulesConfig.reschedule_fee ?? DEFAULT_PAYMENT_RULES.reschedule_fee),
    cancellation_fee_notice_days: Number(document.getElementById('pr-cancellation-notice-days')?.value),
    cancellation_fee_percent: Number(document.getElementById('pr-cancellation-fee-percent')?.value),
    reschedule_fee_notice_days: Number(document.getElementById('pr-reschedule-notice-days')?.value),
    reschedule_fee_percent: Number(document.getElementById('pr-reschedule-fee-percent')?.value),
    // Not editable on this page anymore — pass through whatever is
    // currently saved so this page's save can't clobber the other page's card.
    cancellation_min_notice_days: currentPaymentRulesConfig.cancellation_min_notice_days ?? null,
    cancellation_request_window_days: currentPaymentRulesConfig.cancellation_request_window_days ?? null
  };
}

function validatePaymentRules(config) {
  if (!Number.isFinite(config.max_installments) || config.max_installments < 1) return 'Maximum installments must be at least 1.';
  if (!Number.isFinite(config.proof_of_payment_window_days) || config.proof_of_payment_window_days < 0) return 'Proof of payment window must be zero or more days.';
  if (!Number.isFinite(config.cancellation_fee_onsite) || config.cancellation_fee_onsite < 0) return 'Onsite cancellation fee must be zero or more.';
  if (!Number.isFinite(config.cancellation_fee_offsite) || config.cancellation_fee_offsite < 0) return 'Offsite cancellation fee must be zero or more.';
  if (!Number.isFinite(config.reschedule_fee) || config.reschedule_fee < 0) return 'Reschedule fee must be zero or more.';
  for (const [key, label] of [['cancellation_fee_notice_days', 'Cancellation fee notice period'], ['reschedule_fee_notice_days', 'Reschedule fee notice period']]) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 365 || !Number.isInteger(config[key])) return `${label} must be a whole number of days from 0 to 365.`;
  }
  for (const [key, label] of [['cancellation_fee_percent', 'Cancellation fee percentage'], ['reschedule_fee_percent', 'Reschedule fee percentage']]) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 100) return `${label} must be between 0 and 100.`;
  }
  return null;
}

// One-line summary of the fee rules for the confirm dialog.
function describeFeeRules(config) {
  const p = getFeePolicy(config);
  return `cancel under ${p.cancellationNoticeDays}d: ${p.cancellationFeePercent}% of total, reschedule under ${p.rescheduleNoticeDays}d: ${p.rescheduleFeePercent}% of total, auto-cancel fee ${formatMoney(config.cancellation_fee_onsite)}/${formatMoney(config.cancellation_fee_offsite)}`;
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
  const savedRaw = current?.setting_value ? JSON.parse(current.setting_value) : {};
  const oldConfig = current ? { ...DEFAULT_PAYMENT_RULES, ...savedRaw } : DEFAULT_PAYMENT_RULES;
  // This save replaces the whole JSON blob, so first lay the saved copy down
  // and let this form's values win: any setting the form does not show (the
  // cancellation payment deadline, reschedule limits, ...) is kept instead of
  // silently disappearing.
  for (const [key, value] of Object.entries(savedRaw)) {
    if (!(key in config)) config[key] = value;
  }
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
  // The Transport Fee card owns these — keep whatever is saved.
  for (const key of TRANSPORT_RULE_KEYS) config[key] = oldConfig[key];

  showSettingsConfirm(
    'Change Payment Rules',
    `${oldConfig.max_installments} installments, ${oldConfig.proof_of_payment_window_days}d proof-of-payment window, auto-hold ${oldConfig.auto_hold_enabled ? 'on' : 'off'}, ${describeFeeRules(oldConfig)}`,
    `${config.max_installments} installments, ${config.proof_of_payment_window_days}d proof-of-payment window, auto-hold ${config.auto_hold_enabled ? 'on' : 'off'}, ${describeFeeRules(config)}`,
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
        <td data-label="Category">${escapeHtmlSc(cat.category_name || 'Untitled')}${cat.is_active === false ? ' <span class="field-note" style="margin:0;">(inactive)</span>' : ''}</td>
        <td data-label="Effective rate">${effective}%</td>
        <td data-label="Override">
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
      `Onsite — on a ${formatMoney(base)} package, a ${pct}% service charge adds ${formatMoney(charge)} ` +
      `for a ${formatMoney(total)} total; a 50% deposit is ${formatMoney(deposit)}.`;
  }

  if (offsiteExampleEl) {
    const offsitePct = appliesOffsite ? pct : 0;
    const { charge, total, deposit } = computeWorkedExample(base, offsitePct);
    offsiteExampleEl.textContent = appliesOffsite
      ? `Offsite (toggle on) — the same ${formatMoney(base)} package is charged the same ${offsitePct}%, adding ${formatMoney(charge)} ` +
        `for a ${formatMoney(total)} total; a 50% deposit is ${formatMoney(deposit)}.`
      : `Offsite (toggle off) — the same ${formatMoney(base)} package is charged 0% service charge, so the total stays ${formatMoney(total)}; a 50% deposit is ${formatMoney(deposit)}.`;
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

// ── Transport fee (offsite) ──────────────────────────────────────────────────
// Same system_settings.payment_rules blob as everything above; this card
// owns the transport_* keys: transport_fee_enabled, transport_free_km,
// transport_ranges ([{ to_km, fee }, ...]), transport_beyond ('contact' |
// 'last') and transport_road_factor. The starting point(s) the distance is
// measured from are chosen per branch in Business profile (the "Transport fee
// starting point" checkbox + the branch's map pin).
//
// Ranges are chained: a range's start is always the end of the row above it
// (the first starts at the free distance), so the admin only types an end
// point and a fee, and gaps or overlaps cannot exist. A range includes its end
// point. The old transport_rate_per_km / transport_max_fee values are left in
// the blob untouched but are ignored once transport_ranges has been saved.
//
// Package-specific fees: transport_package_overrides is
// { "<package_id>": { free_km, ranges: [{ to_km, fee }, ...] } }. A package
// listed there uses its own free distance and ranges instead of the universal
// ones; every other package uses the universal fees. On/off, "beyond the last
// range" and the road factor stay universal. Priced by readTransportRules(raw,
// packageId) in transport_fee.js (and its edge-function twin).
let transportBranches = [];
let transportPackages = [];   // offsite-capable packages: { id, label }

function setTfMsg(msg, isError = false) {
  const el = document.getElementById('tf-msg');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.toggle('success', !isError && !!msg);
}

const tfRound1 = (n) => Math.round(n * 10) / 10;
const tfNumOrNaN = (raw) => (raw === '' || raw === null || raw === undefined ? NaN : Number(raw));
const tfKm = (n) => `${Number(n)} km`;

function tfRangeRowHtml(toKm, fee) {
  const toVal = Number.isFinite(toKm) ? toKm : '';
  const feeVal = Number.isFinite(fee) ? Number(fee).toFixed(2) : '';
  return `
    <div class="tf-range" role="listitem">
      <span class="tf-range-from"></span>
      <span class="tf-range-word">up to</span>
      <input type="number" class="pr-input-inline tf-range-to" min="0" max="${MAX_TRANSPORT_KM}" step="0.5" value="${toVal}" aria-label="Range ends at (km)">
      <span class="tf-range-word">km</span>
      <span class="tf-range-peso">&#8369;</span>
      <input type="number" class="pr-input-inline tf-range-fee" data-money min="0" max="10000000" step="0.01" value="${feeVal}" placeholder="0.00" aria-label="Flat fee for this range (pesos)">
      <button type="button" class="action-btn tf-range-remove" aria-label="Remove this distance range" title="Remove this range">&#10005;</button>
    </div>`;
}

// The range editor is used twice: once for the universal fees (#tf-ranges) and
// once inside every package-specific block. These helpers take the element
// that holds the rows plus the input that holds that editor's free distance.
function renderRangesIn(host, freeInput, rows) {
  if (!host) return;
  host.innerHTML = rows.map((r) => tfRangeRowHtml(r.toKm, r.fee)).join('');
  syncRangeLabelsIn(host, freeInput);
}

// Fills each row's "Over X km" from the row above (or the free distance).
function syncRangeLabelsIn(host, freeInput) {
  let prev = tfNumOrNaN(freeInput?.value);
  host?.querySelectorAll('.tf-range').forEach((row) => {
    const label = row.querySelector('.tf-range-from');
    if (label) label.textContent = Number.isFinite(prev) ? `Over ${tfKm(prev)},` : 'Over …,';
    prev = tfNumOrNaN(row.querySelector('.tf-range-to')?.value);
  });
}

function readRangeRowsIn(host) {
  return Array.from(host?.querySelectorAll('.tf-range') || []).map((row) => ({
    toKm: tfNumOrNaN(row.querySelector('.tf-range-to')?.value),
    fee: tfNumOrNaN(row.querySelector('.tf-range-fee')?.value)
  }));
}

function addRangeIn(host, freeInput) {
  const rows = readRangeRowsIn(host);
  const free = tfNumOrNaN(freeInput?.value);
  const lastTo = rows.length ? rows[rows.length - 1].toKm : free;
  // Suggest an end point 5 km past the last one; the fee is left for the admin.
  rows.push({ toKm: Number.isFinite(lastTo) ? tfRound1(lastTo + 5) : NaN, fee: NaN });
  renderRangesIn(host, freeInput, rows);
  const inputs = host.querySelectorAll('.tf-range-fee');
  inputs[inputs.length - 1]?.focus();
  updateTransportExample();
}

function removeRangeIn(host, freeInput, button) {
  const row = button.closest('.tf-range');
  if (!row) return;
  const index = Array.from(host.querySelectorAll('.tf-range')).indexOf(row);
  const rows = readRangeRowsIn(host);
  rows.splice(index, 1);
  renderRangesIn(host, freeInput, rows);
  updateTransportExample();
}

const tfGlobalHost = () => document.getElementById('tf-ranges');
const tfGlobalFree = () => document.getElementById('tf-free-km');
const renderTransportRanges = (rows) => renderRangesIn(tfGlobalHost(), tfGlobalFree(), rows);
const readTransportRangeRows = () => readRangeRowsIn(tfGlobalHost());

// Re-labels every range editor on the card (universal + each package block).
function syncTransportRangeLabels() {
  syncRangeLabelsIn(tfGlobalHost(), tfGlobalFree());
  document.querySelectorAll('#tf-overrides .tf-override').forEach((block) => {
    syncRangeLabelsIn(block.querySelector('.tf-override-ranges'), block.querySelector('.tf-override-free-km'));
  });
}

// ── Package-specific fee blocks ───────────────────────────────────────────
function tfPackageOptionsHtml(selectedId) {
  const usedElsewhere = new Set(readOverrideBlocks().map((b) => b.packageId).filter((id) => id && id !== selectedId));
  return '<option value="">Choose a package…</option>' + transportPackages.map((p) =>
    `<option value="${escapeHtmlSc(p.id)}"${p.id === selectedId ? ' selected' : ''}${usedElsewhere.has(p.id) ? ' disabled' : ''}>${escapeHtmlSc(p.label)}</option>`
  ).join('');
}

function tfOverrideBlockHtml(packageId, freeKm, rows) {
  const freeVal = Number.isFinite(freeKm) ? freeKm : '';
  return `
    <div class="tf-override">
      <div class="tf-override-head">
        <select class="pr-input-inline tf-override-pkg" aria-label="Package with its own transport fee">${tfPackageOptionsHtml(packageId)}</select>
        <button type="button" class="action-btn tf-override-remove" title="Remove this package-specific fee">Remove</button>
      </div>
      <div class="tf-override-free">
        <span class="field-note" style="margin:0;">Free distance up to</span>
        <input type="number" class="pr-input-inline tf-override-free-km" min="0" max="${MAX_TRANSPORT_KM}" step="0.5" value="${freeVal}" aria-label="Free distance for this package (km)">
        <span class="field-note" style="margin:0;">km</span>
      </div>
      <div class="tf-ranges tf-override-ranges" role="list">${rows.map((r) => tfRangeRowHtml(r.toKm, r.fee)).join('')}</div>
      <button type="button" class="action-btn tf-override-add-range">+ Add distance range</button>
    </div>`;
}

function renderOverrideBlocks(blocks) {
  const host = document.getElementById('tf-overrides');
  if (!host) return;
  host.innerHTML = blocks.map((b) => tfOverrideBlockHtml(b.packageId, b.freeKm, b.rows)).join('');
  refreshOverrideUi();
}

// Package pickers can't offer a package another block already uses; the empty
// hint and the "Try a distance" package list follow the blocks too.
function refreshOverrideUi() {
  document.querySelectorAll('#tf-overrides .tf-override').forEach((block) => {
    const select = block.querySelector('.tf-override-pkg');
    const chosen = select.value;
    select.innerHTML = tfPackageOptionsHtml(chosen);
    select.value = chosen;
  });
  document.getElementById('tf-overrides-empty')?.classList.toggle('hidden', !!document.querySelector('#tf-overrides .tf-override'));
  const tryPkg = document.getElementById('tf-try-package');
  if (tryPkg) {
    const keep = tryPkg.value;
    const chosen = readOverrideBlocks().filter((b) => b.packageId);
    tryPkg.innerHTML = '<option value="">Packages with the universal fees</option>' + chosen.map((b) =>
      `<option value="${escapeHtmlSc(b.packageId)}">${escapeHtmlSc(transportPackages.find((p) => p.id === b.packageId)?.label || 'Package')}</option>`).join('');
    tryPkg.value = chosen.some((b) => b.packageId === keep) ? keep : '';
    tryPkg.closest('.tf-try-package-row')?.classList.toggle('hidden', !chosen.length);
  }
}

function readOverrideBlocks() {
  return Array.from(document.querySelectorAll('#tf-overrides .tf-override')).map((block) => ({
    packageId: block.querySelector('.tf-override-pkg')?.value || '',
    freeKm: tfNumOrNaN(block.querySelector('.tf-override-free-km')?.value),
    rows: readRangeRowsIn(block.querySelector('.tf-override-ranges'))
  }));
}

function addOverrideBlock() {
  const used = new Set(readOverrideBlocks().map((b) => b.packageId));
  if (!transportPackages.length) { setTfMsg('There are no offsite packages to add a fee for yet.', true); return; }
  if (transportPackages.every((p) => used.has(p.id))) { setTfMsg('Every offsite package already has its own fee.', true); return; }
  setTfMsg('');
  // Start from a copy of the universal fees so the admin only edits what differs.
  const blocks = readOverrideBlocks();
  blocks.push({ packageId: '', freeKm: tfNumOrNaN(tfGlobalFree()?.value), rows: readTransportRangeRows() });
  renderOverrideBlocks(blocks);
  document.querySelector('#tf-overrides .tf-override:last-child .tf-override-pkg')?.focus();
  updateTransportExample();
}

function readTransportFields() {
  return {
    transport_fee_enabled: !!document.getElementById('tf-enabled')?.checked,
    transport_free_km: tfNumOrNaN(document.getElementById('tf-free-km')?.value),
    transport_ranges: readTransportRangeRows().map((r) => ({ to_km: r.toKm, fee: r.fee })),
    transport_beyond: document.getElementById('tf-beyond-last')?.checked ? 'last' : (document.getElementById('tf-beyond-quote')?.checked ? 'quote' : 'contact'),
    transport_road_factor: Number(document.getElementById('tf-road-factor')?.value),
    // Array while editing (so blanks and duplicates can be reported); cleanTransportFields() turns it into the saved object.
    transport_package_overrides: readOverrideBlocks().map((b) => ({ package_id: b.packageId, free_km: b.freeKm, ranges: b.rows.map((r) => ({ to_km: r.toKm, fee: r.fee })) }))
  };
}

// One free distance + list of ranges (universal or a package's). `who` prefixes
// the message for package blocks, e.g. 'Rose Package: '.
function validateRangeSet(freeKm, ranges, who = '') {
  if (!Number.isFinite(freeKm) || freeKm < 0 || freeKm > MAX_TRANSPORT_KM) return `${who}Free distance must be between 0 and ${MAX_TRANSPORT_KM} km.`;
  if (!ranges.length) return `${who}Add at least one distance range.`;
  let prev = freeKm;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const n = i + 1;
    if (!Number.isFinite(r.to_km)) return `${who}Range ${n}: enter the distance where it ends.`;
    if (r.to_km <= prev) return `${who}Range ${n}: the end point must be more than ${tfKm(prev)}, the end of the range above it.`;
    if (r.to_km > MAX_TRANSPORT_KM) return `${who}Range ${n}: the end point can't be more than ${MAX_TRANSPORT_KM} km.`;
    if (!Number.isFinite(r.fee) || r.fee < 0 || r.fee > 10000000) return `${who}Range ${n}: enter a fee (0.00 or more).`;
    prev = r.to_km;
  }
  return '';
}

const tfPackageLabel = (id) => transportPackages.find((p) => p.id === id)?.label || 'Package';

function validateTransportFields(v) {
  const universal = validateRangeSet(v.transport_free_km, v.transport_ranges);
  if (universal) return universal;
  const seen = new Set();
  for (const o of v.transport_package_overrides || []) {
    if (!o.package_id) return 'Package-specific fees: choose a package for each block, or remove the empty one.';
    if (seen.has(o.package_id)) return `${tfPackageLabel(o.package_id)} has more than one package-specific fee. Keep just one.`;
    seen.add(o.package_id);
    const problem = validateRangeSet(o.free_km, o.ranges, `${tfPackageLabel(o.package_id)}: `);
    if (problem) return problem;
  }
  if (!Number.isFinite(v.transport_road_factor) || v.transport_road_factor < 1 || v.transport_road_factor > 3) return 'Road distance factor must be between 1 and 3.';
  return '';
}

// The values exactly as they are saved: end points rounded to 0.1 km, fees to centavos.
function cleanTransportFields(v) {
  return {
    ...v,
    transport_ranges: v.transport_ranges.map((r) => ({ to_km: tfRound1(r.to_km), fee: Math.round(r.fee * 100) / 100 })),
    transport_package_overrides: Object.fromEntries((v.transport_package_overrides || []).map((o) => [
      o.package_id,
      { free_km: tfRound1(o.free_km), ranges: o.ranges.map((r) => ({ to_km: tfRound1(r.to_km), fee: Math.round(r.fee * 100) / 100 })) }
    ]))
  };
}

function describeTransportRangesForAudit(v) {
  let from = v.transport_free_km;
  const parts = v.transport_ranges.map((r) => {
    const text = `${from} to ${r.to_km} km ${formatMoney(r.fee)}`;
    from = r.to_km;
    return text;
  });
  const beyond = v.transport_beyond === 'last' ? `beyond ${from} km the last range's fee applies`
    : v.transport_beyond === 'quote' ? `beyond ${from} km the venue can be booked and Eli quotes the fee`
    : `beyond ${from} km the venue can't be booked online`;
  const overrideIds = Object.keys(v.transport_package_overrides || {});
  const overrides = overrideIds.length
    ? `; own fee for ${overrideIds.map((id) => tfPackageLabel(id)).join(', ')}`
    : '';
  return `free up to ${v.transport_free_km} km; ranges: ${parts.join(', ')}; ${beyond}${overrides}`;
}

// "Try a distance" box: prices any road distance with the ranges as they are
// typed (before saving), using the same helper the booking form uses.
function updateTransportExample() {
  syncTransportRangeLabels();
  const exampleEl = document.getElementById('tf-example-text');
  if (!exampleEl) return;
  const v = readTransportFields();
  if (validateTransportFields(v)) { exampleEl.textContent = 'Fill in every fee above to test a distance.'; return; }
  const km = tfRound1(tfNumOrNaN(document.getElementById('tf-try-km')?.value));
  if (!Number.isFinite(km) || km < 0) { exampleEl.textContent = 'Enter a distance to test.'; return; }

  const tryPackageId = document.getElementById('tf-try-package')?.value || null;
  const rules = readTransportRules(cleanTransportFields({ ...v, transport_fee_enabled: true }), tryPackageId);
  const priced = priceTransportDistance(rules, km);
  let text;
  switch (priced.status) {
    case 'free':
      text = `${tfKm(km)} is within the ${tfKm(rules.freeKm)} free distance: transport fee ${formatMoney(0)}.`; break;
    case 'range':
      text = `${tfKm(km)} falls in the ${priced.rangeFrom} to ${tfKm(priced.rangeTo)} range: transport fee ${formatMoney(priced.fee)}.`; break;
    case 'beyond_charged':
      text = `${tfKm(km)} is beyond the last range (${tfKm(priced.rangeTo)}), so the last range's fee applies: transport fee ${formatMoney(priced.fee)}.`; break;
    case 'quote':
      text = `${tfKm(km)} is beyond the last range (${tfKm(priced.rangeFrom)}): the customer can still book with no transport fee, and a transport-fee quote request is sent to you.`; break;
    default:
      text = `${tfKm(km)} is beyond the last range (${tfKm(priced.rangeFrom)}): venues this far can't be booked online, so no fee is calculated and customers are asked to choose a closer venue.`;
  }
  if (tryPackageId) text = `For ${tfPackageLabel(tryPackageId)}: ${text}`;
  exampleEl.textContent = text + (v.transport_fee_enabled ? '' : ' The fee is currently switched off, so customers are not charged.');
}

async function loadTransportFeeSection() {
  const { data: setting } = await supabase
    .from('system_settings').select('setting_value').eq('setting_key', 'payment_rules').maybeSingle();
  let parsed = {};
  if (setting?.setting_value) { try { parsed = JSON.parse(setting.setting_value); } catch { /* defaults */ } }
  const rules = readTransportRules(parsed);

  const enabledEl = document.getElementById('tf-enabled');
  if (enabledEl) enabledEl.checked = rules.enabled;

  // Ranges never saved yet: pre-fill the suggested rate card. Nothing changes
  // for customers (the old per-km fee keeps applying) until Save is clicked.
  const firstTime = rules.ranges === null;
  const freeKm = firstTime ? TRANSPORT_DEFAULTS.freeKm : rules.freeKm;
  const rows = firstTime ? TRANSPORT_DEFAULT_RANGES.map((r) => ({ toKm: r.toKm, fee: r.fee })) : rules.ranges.map((r) => ({ toKm: r.toKm, fee: r.fee }));
  const freeEl = document.getElementById('tf-free-km');
  if (freeEl) freeEl.value = freeKm;
  const beyond = firstTime ? TRANSPORT_DEFAULTS.beyond : rules.beyond;
  const beyondContact = document.getElementById('tf-beyond-contact');
  const beyondLast = document.getElementById('tf-beyond-last');
  const beyondQuote = document.getElementById('tf-beyond-quote');
  if (beyondContact) beyondContact.checked = beyond !== 'last' && beyond !== 'quote';
  if (beyondLast) beyondLast.checked = beyond === 'last';
  if (beyondQuote) beyondQuote.checked = beyond === 'quote';
  const legacyNote = document.getElementById('tf-legacy-note');
  if (legacyNote) legacyNote.classList.toggle('hidden', !firstTime);
  renderTransportRanges(rows);
  const roadEl = document.getElementById('tf-road-factor');
  if (roadEl) roadEl.value = rules.roadFactor.toFixed(2);

  // Offsite-capable packages for the package-specific fee pickers (archived
  // ones included so an existing override never disappears from the screen).
  const { data: pkgRows } = await supabase
    .from('package')
    .select('package_id, package_name, is_active, location_type, package_category(category_name)')
    .in('location_type', ['offsite', 'both'])
    .order('package_name', { ascending: true });
  transportPackages = (pkgRows || []).map((p) => ({
    id: p.package_id,
    label: p.package_name + (p.package_category?.category_name ? ' — ' + p.package_category.category_name : '') + (p.is_active === false ? ' (archived)' : '')
  }));
  const savedOverrides = Object.keys(parsed.transport_package_overrides && typeof parsed.transport_package_overrides === 'object' && !Array.isArray(parsed.transport_package_overrides) ? parsed.transport_package_overrides : {});
  renderOverrideBlocks(savedOverrides
    .filter((id) => transportPackages.some((p) => p.id === id))
    .map((id) => ({ id, r: readTransportRules(parsed, id) }))
    .filter((x) => x.r.packageOverride)
    .map((x) => ({ packageId: x.id, freeKm: x.r.freeKm, rows: x.r.ranges.map((r) => ({ toKm: r.toKm, fee: r.fee })) })));

  const { data: branches } = await supabase
    .from('business_location').select('name, branch_tag, latitude, longitude, transport_origin, is_active').eq('is_active', true).order('sort_order', { ascending: true });
  transportBranches = branches || [];
  const usable = transportOrigins(transportBranches);
  const note = document.getElementById('tf-origin-note');
  if (note) {
    if (usable.length) {
      note.textContent = (usable.length === 1
        ? 'Distance is measured from: ' + usable[0].name + '.'
        : 'Distance is measured from the nearest of: ' + usable.map((b) => b.name).join(', ') + '.')
        + ' To change this, edit a branch in Business profile and update its “Use as a transport fee starting point” setting.';
      note.style.color = '';
    } else {
      note.textContent = 'No active branch is a transport fee starting point, so no transport fee can be charged. Open Business profile, edit a branch, place its map pin and tick “Use as a transport fee starting point”.';
      note.style.color = '#b3261e';
    }
  }
  updateTransportExample();
}

async function saveTransportFee() {
  const raw = readTransportFields();
  const problem = validateTransportFields(raw);
  if (problem) { setTfMsg(problem, true); return; }
  const values = cleanTransportFields(raw);
  // Switching the fee on with no starting point would silently charge ₱0 to
  // every offsite booking, so stop it here instead.
  if (values.transport_fee_enabled && !transportOrigins(transportBranches).length) {
    setTfMsg('Set a transport fee starting point first: in Business profile, edit a branch, place its map pin and tick “Use as a transport fee starting point”.', true);
    return;
  }

  const { data: current } = await supabase
    .from('system_settings').select('setting_value').eq('setting_key', 'payment_rules').maybeSingle();
  let config = { ...DEFAULT_PAYMENT_RULES };
  if (current?.setting_value) {
    try { config = { ...DEFAULT_PAYMENT_RULES, ...JSON.parse(current.setting_value) }; } catch { /* use default */ }
  }
  Object.assign(config, values);

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'payment_rules', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );
  if (error) { setTfMsg('Failed to save: ' + error.message, true); return; }

  await logAudit({
    action: 'Updated Transport Fee',
    category: 'payment_config',
    details: values.transport_fee_enabled
      ? `Transport fee on: ${describeTransportRangesForAudit(values)}; road factor ${values.transport_road_factor}`
      : 'Transport fee turned off'
  });
  const legacyNote = document.getElementById('tf-legacy-note');
  if (legacyNote) legacyNote.classList.add('hidden');
  setTfMsg('Saved.');
  updateTransportExample();
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
// Native min/max/step never stop someone from typing/pasting an out-of-
// range or absurdly precise value — see js/numeric_input.js.
function wireNumericInputClamps() {
  clampNumberInput(document.getElementById('pt-reservation_fee-flat'), { min: 0, max: 1000000, decimals: 2 });
  clampNumberInput(document.getElementById('pt-down_payment-percent'), { min: 0, max: 100, decimals: 0 });
  clampNumberInput(document.getElementById('pt-partial_payment-percent'), { min: 0, max: 100, decimals: 0 });
  clampNumberInput(document.getElementById('pt-partial_payment-floor'), { min: 0, max: 1000000, decimals: 2 });
  clampNumberInput(document.getElementById('pr-max-installments'), { min: 1, max: 20, decimals: 0 });
  clampNumberInput(document.getElementById('pr-proof-window'), { min: 0, max: 365, decimals: 0 });
  clampNumberInput(document.getElementById('pr-cancellation-fee-onsite'), { min: 0, max: 1000000, decimals: 2 });
  clampNumberInput(document.getElementById('pr-cancellation-fee-offsite'), { min: 0, max: 1000000, decimals: 2 });
  clampNumberInput(document.getElementById('pr-reschedule-fee'), { min: 0, max: 1000000, decimals: 2 });
  clampNumberInput(document.getElementById('sc-global-percent'), { min: 0, max: 100, decimals: 1 });
  clampNumberInput(document.getElementById('tf-free-km'), { min: 0, max: 500, decimals: 1 });
  // Distance range rows are added and removed at runtime, so their inputs are
  // clamped by one delegated handler (blur does not bubble; focusout does).
  const clampRangeInput = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.value === '') return;
    const isFee = el.classList.contains('tf-range-fee');
    const isEnd = el.classList.contains('tf-range-to') || el.classList.contains('tf-override-free-km');
    if (!isFee && !isEnd) return;
    const clamped = clampNumberValue(el.value, isFee ? { min: 0, max: 10000000, decimals: 2 } : { min: 0, max: MAX_TRANSPORT_KM, decimals: 1 });
    el.value = clamped === null ? '' : (isFee ? clamped.toFixed(2) : String(clamped));
    updateTransportExample();
  };
  document.getElementById('tf-ranges')?.addEventListener('focusout', clampRangeInput);
  document.getElementById('tf-overrides')?.addEventListener('focusout', clampRangeInput);
  clampNumberInput(document.getElementById('tf-road-factor'), { min: 1, max: 3, decimals: 2 });
  clampNumberInput(document.getElementById('pm2CashWindowDays'), { min: 0, max: 365, decimals: 0 });
  clampNumberInput(document.getElementById('pr-full-payment-days'), { min: 1, max: 60, decimals: 0 });
  clampNumberInput(document.getElementById('pr-auto-cancel-days'), { min: 0, max: 60, decimals: 0 });
}

// ── Payment Deadline and Grace Period ───────────────────────────────────────
// system_settings.reservation_rules.full_payment_days (balance due this many
// days before the event) and .auto_cancel_days (grace after that due date).
// Both are read by the hourly auto_cancel_overdue_reservations() job (via
// get_full_payment_days()), by the reminder notifications, and by the
// customer pages. Defaults match every one of those readers: 7 and 5.
// Read-merge-write: the same JSON blob holds min/max advance days (edited on
// Availability and Scheduling), deposit_pct, min_pax, etc., so a save here
// only touches these two fields.
const DEFAULT_FULL_PAYMENT_DAYS = 7;
const DEFAULT_AUTO_CANCEL_DAYS = 5;
const DEFAULT_MIN_ADVANCE_FOR_DUE_CHECK = 14;

function setLatePaymentGraceMsg(msg, isError = false) {
  const el = document.getElementById('late-payment-grace-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

// An empty box must not read as 0 (Number('') is 0).
function readWholeNumberField(id) {
  const raw = String(document.getElementById(id)?.value ?? '').trim();
  return raw === '' ? NaN : Number(raw);
}

function storedWholeNumber(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function dayLabel(n) {
  return `${n} day${n === 1 ? '' : 's'}`;
}

async function loadLatePaymentGrace() {
  const dueInput = document.getElementById('pr-full-payment-days');
  const graceInput = document.getElementById('pr-auto-cancel-days');
  if (!dueInput && !graceInput) return;
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_rules')
    .maybeSingle();
  const parsed = data ? JSON.parse(data.setting_value) : {};
  const due = storedWholeNumber(parsed.full_payment_days, DEFAULT_FULL_PAYMENT_DAYS);
  if (dueInput) dueInput.value = due >= 1 ? due : DEFAULT_FULL_PAYMENT_DAYS;
  if (graceInput) graceInput.value = storedWholeNumber(parsed.auto_cancel_days, DEFAULT_AUTO_CANCEL_DAYS);
}

async function saveLatePaymentGrace() {
  const dueDays = readWholeNumberField('pr-full-payment-days');
  const graceDays = readWholeNumberField('pr-auto-cancel-days');

  if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 60) {
    setLatePaymentGraceMsg('Payment due date must be a whole number from 1 to 60 days before the event.', true); return;
  }
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) {
    setLatePaymentGraceMsg('Grace period must be a whole number from 0 to 60 days.', true); return;
  }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_rules')
    .maybeSingle();
  const existing = current ? JSON.parse(current.setting_value) : {};

  // A due date further out than the shortest allowed booking notice would make
  // every new booking late the moment it is made.
  const minAdvance = storedWholeNumber(existing.min_advance_days, DEFAULT_MIN_ADVANCE_FOR_DUE_CHECK);
  if (dueDays >= minAdvance) {
    setLatePaymentGraceMsg(`Payment due date must be shorter than the site-wide minimum booking notice (${dayLabel(minAdvance)}), otherwise new bookings would already be late.`, true); return;
  }

  const previousDue = storedWholeNumber(existing.full_payment_days, DEFAULT_FULL_PAYMENT_DAYS);
  const previousGrace = storedWholeNumber(existing.auto_cancel_days, DEFAULT_AUTO_CANCEL_DAYS);
  if (previousDue === dueDays && previousGrace === graceDays
      && Number(existing.full_payment_days) === dueDays && Number(existing.auto_cancel_days) === graceDays) {
    setLatePaymentGraceMsg('No changes to save.'); return;
  }
  const merged = { ...existing, full_payment_days: dueDays, auto_cancel_days: graceDays };

  const raisedDue = dueDays > previousDue;
  showSettingsConfirm(
    'Change Payment Deadline Settings',
    `due ${dayLabel(previousDue)} before the event, ${dayLabel(previousGrace)} grace`,
    `due ${dayLabel(dueDays)} before the event, ${dayLabel(graceDays)} grace${raisedDue ? ' (existing unpaid reservations move to the earlier due date and some may become overdue right away)' : ''}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'reservation_rules', setting_value: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setLatePaymentGraceMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Late Payment Grace Period', category: 'payment_config', details: `full_payment_days=${dueDays}, auto_cancel_days=${graceDays}` });
      setLatePaymentGraceMsg('Saved. It applies the next time overdue reservations are checked.');
    }
  );
}

// ── Receipt validation mode ──────────────────────────────────────────────────
// system_settings.receipt_validation_mode holds a plain 'off' | 'warn' |
// 'enforce' string. Read by the validate-receipt function and by the
// trg_zz_payment_receipt_check trigger on every customer payment.
const RV_MODES = {
  off: { label: 'Off', desc: 'Receipts are not read or compared. Payments go straight to manual review, as before.' },
  warn: { label: 'Warn', desc: 'Receipts are checked and the result is shown to managers, but customers are never blocked. Use this to watch how accurate the checks are.' },
  enforce: { label: 'Enforce', desc: 'A receipt that clearly does not match is blocked, and the customer sees what to fix. Unreadable receipts still go to manual review.' }
};
let rvSavedMode = 'warn';

function setRvMsg(msg, isError = false) {
  const el = document.getElementById('rv-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function normalizeRvMode(value) {
  const mode = String(value ?? '').replace(/"/g, '').trim().toLowerCase();
  return RV_MODES[mode] ? mode : 'warn';
}

function updateRvDescription() {
  const select = document.getElementById('rv-mode');
  const desc = document.getElementById('rv-mode-desc');
  if (select && desc) desc.textContent = RV_MODES[normalizeRvMode(select.value)].desc;
}

async function loadReceiptValidationSection() {
  const select = document.getElementById('rv-mode');
  if (!select) return;
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'receipt_validation_mode')
    .maybeSingle();
  rvSavedMode = normalizeRvMode(data?.setting_value);
  select.value = rvSavedMode;
  updateRvDescription();
}

async function saveReceiptValidation() {
  const select = document.getElementById('rv-mode');
  if (!select) return;
  const next = normalizeRvMode(select.value);
  if (next === rvSavedMode) { setRvMsg('No changes to save.'); return; }

  showSettingsConfirm(
    'Change Receipt Validation',
    RV_MODES[rvSavedMode].label,
    next === 'enforce'
      ? `${RV_MODES[next].label} (customers with a mismatched receipt will be blocked)`
      : RV_MODES[next].label,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'receipt_validation_mode', setting_value: next, updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );
      if (error) { setRvMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({
        action: 'Updated Receipt Validation',
        category: 'payment_config',
        details: `Receipt validation mode changed from ${RV_MODES[rvSavedMode].label} to ${RV_MODES[next].label}`
      });
      rvSavedMode = next;
      setRvMsg('Receipt validation mode saved.');
    }
  );
}

async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Admin' });
  if (!result) return;

  if (result.profile.role !== 'admin') {
    window.location.replace('/admin/dashboard');
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
  setupInactivityLogout(result.profile.role);
  initAdminSidebarBadges(supabase);
  initManagerNotificationBell(supabase, result.session.user.id);
  initAdminNav({ role: result.profile.role });
  wireNumericInputClamps();

  await loadPaymentMethods();
  await loadPaymentTypes();
  await loadPaymentRules();
  await loadServiceChargeSection();
  await loadTransportFeeSection();
  await loadLatePaymentGrace();
  await loadReceiptValidationSection();

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
    unlockBodyScroll();
  });
  document.getElementById('pm2ConfirmOk')?.addEventListener('click', pm2ConfirmAction);

  document.getElementById('pr-save-btn')?.addEventListener('click', savePaymentRules);

  document.getElementById('sc-save-global-btn')?.addEventListener('click', saveGlobalServiceCharge);
  document.getElementById('sc-global-percent')?.addEventListener('input', () => updateWorkedExample());
  document.getElementById('sc-save-offsite-btn')?.addEventListener('click', saveOffsiteToggle);
  document.getElementById('tf-save-btn')?.addEventListener('click', saveTransportFee);
  document.getElementById('saveLatePaymentGraceBtn')?.addEventListener('click', saveLatePaymentGrace);
  document.getElementById('rv-save-btn')?.addEventListener('click', saveReceiptValidation);
  document.getElementById('rv-mode')?.addEventListener('change', updateRvDescription);
  ['tf-free-km', 'tf-try-km', 'tf-road-factor'].forEach((id) => document.getElementById(id)?.addEventListener('input', updateTransportExample));
  document.getElementById('tf-ranges')?.addEventListener('input', updateTransportExample);
  document.getElementById('tf-ranges')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.tf-range-remove');
    if (btn) removeRangeIn(tfGlobalHost(), tfGlobalFree(), btn);
  });
  document.getElementById('tf-add-range')?.addEventListener('click', () => addRangeIn(tfGlobalHost(), tfGlobalFree()));
  // Package-specific fee blocks are added and removed at runtime: one delegated set of handlers.
  const overridesHost = document.getElementById('tf-overrides');
  overridesHost?.addEventListener('input', updateTransportExample);
  overridesHost?.addEventListener('change', (e) => {
    if (e.target.closest?.('.tf-override-pkg')) refreshOverrideUi();
    updateTransportExample();
  });
  overridesHost?.addEventListener('click', (e) => {
    const block = e.target.closest?.('.tf-override');
    if (!block) return;
    const host = block.querySelector('.tf-override-ranges');
    const free = block.querySelector('.tf-override-free-km');
    if (e.target.closest('.tf-range-remove')) { removeRangeIn(host, free, e.target.closest('.tf-range-remove')); return; }
    if (e.target.closest('.tf-override-add-range')) { addRangeIn(host, free); return; }
    if (e.target.closest('.tf-override-remove')) {
      block.remove();
      refreshOverrideUi();
      updateTransportExample();
    }
  });
  document.getElementById('tf-add-override')?.addEventListener('click', addOverrideBlock);
  document.getElementById('tf-try-package')?.addEventListener('change', updateTransportExample);
  ['tf-beyond-contact', 'tf-beyond-quote', 'tf-beyond-last'].forEach((id) => document.getElementById(id)?.addEventListener('change', updateTransportExample));
  document.getElementById('tf-enabled')?.addEventListener('change', updateTransportExample);
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
