// admin_reservation_form_config.js
// Powers admin/config/form.html — three independent tabs (Required Fields,
// Terms & Legal, Event Types), each reading/writing its own system_settings
// key or table. Nothing here touches the hardcoded POLICY_CONTENT fallback
// in reservations.html — that stays in place and is only overridden at
// runtime when a non-empty body exists in system_settings (see
// js/reservation_form_config.js).
import { portalSupabase as supabase } from './supabase.js';
import { logAudit } from './audit_logger.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setMessage(elId, msg, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

// ── Tab switching (top-level settings tabs) ──────────────────────────────
// Mirrors the hash-deep-linking pattern already used on
// super_admin_settings.html, so sidebar links (admin_nav_data.js) can jump
// straight to a specific tab, e.g. /admin/config/form.html#event-types.
function activateMainTab(tabName) {
  const tabs = document.querySelectorAll('.settings-tab-btn');
  const tab = Array.from(tabs).find((t) => t.dataset.tab === tabName);
  if (!tab) return;
  tabs.forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.settings-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById(`panel-${tabName}`)?.classList.add('active');
}

function wireMainTabs() {
  const tabs = document.querySelectorAll('.settings-tab-btn');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => activateMainTab(btn.dataset.tab));
  });

  const validTabs = Array.from(tabs).map((t) => t.dataset.tab);
  function activateTabFromHash() {
    const requested = location.hash.slice(1);
    if (requested && validTabs.includes(requested)) activateMainTab(requested);
  }
  activateTabFromHash();
  window.addEventListener('hashchange', activateTabFromHash);
}

// ── Required Fields tab ───────────────────────────────────────────────────
const DEFAULT_FIELD_RULES = { contact_phone_required: true, special_requests_required: false };

async function loadRequiredFields() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_form_fields')
    .maybeSingle();

  const rules = (!error && data) ? { ...DEFAULT_FIELD_RULES, ...JSON.parse(data.setting_value) } : DEFAULT_FIELD_RULES;

  document.getElementById('rf-contact-phone-required').checked = !!rules.contact_phone_required;
  document.getElementById('rf-special-requests-required').checked = !!rules.special_requests_required;
}

async function saveRequiredFields() {
  const rules = {
    contact_phone_required: document.getElementById('rf-contact-phone-required').checked,
    special_requests_required: document.getElementById('rf-special-requests-required').checked
  };

  setMessage('rf-fields-message', 'Saving…');
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'reservation_form_fields', setting_value: JSON.stringify(rules), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) { setMessage('rf-fields-message', 'Failed to save: ' + error.message, true); return; }
  await logAudit({ action: 'Updated Reservation Form Fields', category: 'reservation_form_config', details: JSON.stringify(rules) });
  setMessage('rf-fields-message', 'Saved.');
}

// ── Terms & Legal tab ─────────────────────────────────────────────────────
async function loadLegalBody(settingKey, textareaId) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', settingKey)
    .maybeSingle();

  const textarea = document.getElementById(textareaId);
  if (error || !data) {
    textarea.value = '';
    textarea.placeholder = 'No override saved yet — the built-in copy on the booking page is currently shown to customers.';
    return;
  }

  try {
    const parsed = JSON.parse(data.setting_value);
    textarea.value = parsed.body || '';
  } catch {
    textarea.value = '';
  }
}

async function saveLegalBody(settingKey, textareaId) {
  const body = document.getElementById(textareaId).value.trim();
  setMessage('rf-legal-message', 'Saving…');

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: settingKey, setting_value: JSON.stringify({ body }), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) { setMessage('rf-legal-message', 'Failed to save: ' + error.message, true); return; }
  await logAudit({ action: 'Updated Reservation Form Legal Text', category: 'reservation_form_config', details: `Updated ${settingKey}` });
  setMessage(
    'rf-legal-message',
    body
      ? 'Saved. Customers now see this version instead of the built-in copy.'
      : 'Saved as empty — customers will see the built-in fallback copy again.'
  );
}

function wireLegalSubTabs() {
  document.querySelectorAll('.rf-legal-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rf-legal-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.rf-legal-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`rf-legal-panel-${btn.dataset.legalTab}`)?.classList.add('active');
    });
  });
}

function activeLegalTabKey() {
  return document.querySelector('.rf-legal-tab-btn.active')?.dataset.legalTab || 'terms';
}

function openPreview() {
  const key = activeLegalTabKey();
  const textareaId = key === 'terms' ? 'rf-terms-body' : 'rf-privacy-body';
  const body = document.getElementById(textareaId).value.trim();

  document.getElementById('rf-preview-title').textContent = key === 'terms' ? 'Terms & Conditions' : 'Data Privacy Policy';
  document.getElementById('rf-preview-body').innerHTML = body
    ? renderPolicyBlocks(parsePolicyBody(body))
    : '<p><em>Nothing saved yet — customers currently see the built-in fallback copy.</em></p>';

  document.getElementById('rf-preview-backdrop').classList.remove('hidden');
}

// ── Event Types tab ────────────────────────────────────────────────────────
let etCache = [];
let etEditingId = null;

function renderEventTypesTable() {
  const body = document.getElementById('et-body');
  if (!etCache.length) {
    body.innerHTML = `<tr><td colspan="4">No event types yet — add one so customers can select it when booking.</td></tr>`;
    return;
  }

  body.innerHTML = etCache.map((et) => `
    <tr>
      <td style="font-weight:600;">${escHtml(et.name)}</td>
      <td style="color:var(--muted);">${escHtml(et.description || '—')}</td>
      <td><span class="status-pill ${et.status === 'Active' ? 'active' : 'inactive'}">${escHtml(et.status)}</span></td>
      <td style="display:flex;gap:8px;">
        <button type="button" class="et-action-btn" data-et-edit="${escHtml(et.id)}">Edit</button>
        <button type="button" class="et-action-btn ${et.status === 'Active' ? 'archive' : ''}" data-et-toggle="${escHtml(et.id)}">
          ${et.status === 'Active' ? 'Archive' : 'Activate'}
        </button>
      </td>
    </tr>
  `).join('');
}

async function loadEventTypes() {
  setMessage('et-message', 'Loading…');
  const { data, error } = await supabase.from('event_types').select('*').order('name', { ascending: true });

  if (error) {
    document.getElementById('et-body').innerHTML = `<tr><td colspan="4">Failed to load event types.</td></tr>`;
    setMessage('et-message', 'Failed to load: ' + error.message, true);
    return;
  }

  etCache = data || [];
  renderEventTypesTable();
  setMessage('et-message', `Showing ${etCache.length} event type${etCache.length === 1 ? '' : 's'}.`);
}

function openEventTypeModal(id = null) {
  etEditingId = id;
  const et = id ? etCache.find((row) => row.id === id) : null;

  document.getElementById('et-modal-title').textContent = et ? 'Edit event type' : 'Add event type';
  document.getElementById('et-name-input').value = et?.name || '';
  document.getElementById('et-desc-input').value = et?.description || '';
  document.getElementById('et-active-input').checked = et ? et.status === 'Active' : true;
  document.getElementById('et-modal-message').textContent = '';
  document.getElementById('et-modal-backdrop').classList.remove('hidden');
}

function closeEventTypeModal() {
  document.getElementById('et-modal-backdrop').classList.add('hidden');
}

async function saveEventType() {
  const name = document.getElementById('et-name-input').value.trim();
  const description = document.getElementById('et-desc-input').value.trim() || null;
  const status = document.getElementById('et-active-input').checked ? 'Active' : 'Archived';

  if (!name) { document.getElementById('et-modal-message').textContent = 'Name is required.'; return; }

  const saveBtn = document.getElementById('et-modal-save');
  saveBtn.disabled = true;
  document.getElementById('et-modal-message').textContent = 'Saving…';

  try {
    if (etEditingId) {
      const { error } = await supabase.from('event_types').update({ name, description, status }).eq('id', etEditingId);
      if (error) throw error;
      await logAudit({ action: 'Updated Event Type', category: 'reservation_form_config', details: `Updated: ${name}`, entityId: etEditingId });
    } else {
      const { data, error } = await supabase.from('event_types').insert({ name, description, status }).select('id').maybeSingle();
      if (error) throw error;
      await logAudit({ action: 'Added Event Type', category: 'reservation_form_config', details: `Added: ${name}`, entityId: data?.id });
    }

    closeEventTypeModal();
    await loadEventTypes();
  } catch (err) {
    document.getElementById('et-modal-message').textContent = 'Failed to save: ' + err.message;
  } finally {
    saveBtn.disabled = false;
  }
}

async function toggleEventTypeStatus(id) {
  const et = etCache.find((row) => row.id === id);
  if (!et) return;
  const nextStatus = et.status === 'Active' ? 'Archived' : 'Active';

  setMessage('et-message', `${nextStatus === 'Archived' ? 'Archiving' : 'Activating'}…`);
  const { error } = await supabase.from('event_types').update({ status: nextStatus }).eq('id', id);
  if (error) { setMessage('et-message', 'Failed: ' + error.message, true); return; }

  await logAudit({
    action: nextStatus === 'Archived' ? 'Archived Event Type' : 'Activated Event Type',
    category: 'reservation_form_config',
    details: `${et.name} → ${nextStatus}`,
    entityId: id
  });
  await loadEventTypes();
}

// ── Init ───────────────────────────────────────────────────────────────────
export function initReservationFormConfig() {
  wireMainTabs();
  wireLegalSubTabs();

  loadRequiredFields();
  loadLegalBody('terms_and_conditions', 'rf-terms-body');
  loadLegalBody('data_privacy_policy', 'rf-privacy-body');
  loadEventTypes();

  document.getElementById('rf-fields-save')?.addEventListener('click', saveRequiredFields);

  document.getElementById('rf-legal-save')?.addEventListener('click', () => {
    const key = activeLegalTabKey();
    saveLegalBody(key === 'terms' ? 'terms_and_conditions' : 'data_privacy_policy', key === 'terms' ? 'rf-terms-body' : 'rf-privacy-body');
  });
  document.getElementById('rf-legal-preview')?.addEventListener('click', openPreview);
  document.getElementById('rf-preview-close')?.addEventListener('click', () => {
    document.getElementById('rf-preview-backdrop').classList.add('hidden');
  });
  document.getElementById('rf-preview-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'rf-preview-backdrop') e.currentTarget.classList.add('hidden');
  });

  document.getElementById('et-add-btn')?.addEventListener('click', () => openEventTypeModal(null));
  document.getElementById('et-modal-cancel')?.addEventListener('click', closeEventTypeModal);
  document.getElementById('et-modal-save')?.addEventListener('click', saveEventType);
  document.getElementById('et-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'et-modal-backdrop') closeEventTypeModal();
  });
  document.getElementById('et-body')?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-et-edit]');
    if (editBtn) { openEventTypeModal(editBtn.dataset.etEdit); return; }
    const toggleBtn = e.target.closest('[data-et-toggle]');
    if (toggleBtn) toggleEventTypeStatus(toggleBtn.dataset.etToggle);
  });
}
