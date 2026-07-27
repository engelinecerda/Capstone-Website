// admin_contract_template.js
// Powers the "Contract Template" tab on admin/config/form.html.
//
// Extends the existing per-package contract_templates system (unchanged,
// still edited/versioned via admin/contracts.html) with structure:
//   - contract_field   — Layer 1 (Reservation Summary row visibility/label/order), global
//   - contract_template_clause — Layer 2 (editable clauses), scoped to one package's template
//   - contract_locked_clause   — Layer 3 (legal boilerplate), global, locked by default
//
// The merge-token engine (regex, vocabulary) lives in js/merge_tokens.js,
// shared with the Notifications Configuration message editor and mirroring
// supabase/functions/generate-signed-contract/index.ts's mergeTemplate() —
// keep all in sync if the token vocabulary changes.
import { portalSupabase as supabase } from './supabase.js';
import { logAudit } from './audit_logger.js';
import { TOKEN_INFO, SAMPLE_RESERVATION, mergeTokens, findUnknownTokens } from './merge_tokens.js';

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setMsg(msg, isError = false) {
  const el = document.getElementById('ct-message');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

// ── State ──────────────────────────────────────────────────────────────────
let packagesCache = [];
let selectedPackageId = null;
let currentTemplate = null;       // { template_id, version_no, contract_type } | null
let templateClauses = [];         // [{ clause_id?, heading, body, sort_order }]
let summaryFields = [];           // [{ field_id, token, label, is_visible, sort_order }]
let lockedClauses = {};           // { acknowledgement: {clause_id,heading,body}, electronic_signature: {...} }
let unlockedKeys = new Set();
let tokenValues = { ...SAMPLE_RESERVATION };
let nextLocalClauseId = 1;

// ── Load: packages, global fields/locked-clauses/fee-terms sources ─────────
async function loadPackages() {
  const { data, error } = await supabase
    .from('package')
    .select('package_id, package_name, package_type')
    .eq('is_active', true)
    .order('package_name', { ascending: true });
  if (error) { setMsg('Failed to load packages: ' + error.message, true); return; }
  packagesCache = data || [];

  const select = document.getElementById('ct-package-select');
  select.innerHTML = packagesCache.length
    ? packagesCache.map((p) => `<option value="${escHtml(p.package_id)}">${escHtml(p.package_name)}${p.package_type === 'add on' ? ' (Add-on)' : ''}</option>`).join('')
    : '<option value="">No active packages yet</option>';

  if (packagesCache.length) {
    selectedPackageId = packagesCache[0].package_id;
    select.value = selectedPackageId;
  }
}

async function loadGlobalData() {
  const [
    { data: fieldRows },
    { data: lockedRows },
    { data: paymentRulesRow },
    { data: downPaymentRow },
    { data: termsRow },
    { data: privacyRow },
  ] = await Promise.all([
    supabase.from('contract_field').select('field_id, token, label, is_visible, sort_order').eq('section', 'summary').order('sort_order', { ascending: true }),
    supabase.from('contract_locked_clause').select('clause_id, key, heading, body'),
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'payment_rules').maybeSingle(),
    supabase.from('payment_type').select('percent_of_total').eq('code', 'down_payment').maybeSingle(),
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'terms_and_conditions').maybeSingle(),
    supabase.from('system_settings').select('setting_value').eq('setting_key', 'data_privacy_policy').maybeSingle(),
  ]);

  summaryFields = fieldRows || [];

  lockedClauses = {};
  (lockedRows || []).forEach((c) => { lockedClauses[c.key] = c; });

  let paymentRules = {};
  try { paymentRules = paymentRulesRow?.setting_value ? JSON.parse(paymentRulesRow.setting_value) : {}; } catch { /* defaults below */ }
  let termsBody = '';
  try { termsBody = termsRow?.setting_value ? (JSON.parse(termsRow.setting_value).body || '') : ''; } catch { /* leave blank */ }
  let privacyBody = '';
  try { privacyBody = privacyRow?.setting_value ? (JSON.parse(privacyRow.setting_value).body || '') : ''; } catch { /* leave blank */ }

  tokenValues = {
    ...SAMPLE_RESERVATION,
    reschedule_fee: '₱' + Number(paymentRules.reschedule_fee ?? 3000).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
    cancellation_fee: '₱' + Number(paymentRules.cancellation_fee_onsite ?? 500).toLocaleString('en-PH', { minimumFractionDigits: 2 }),
    deposit_percent: String(downPaymentRow?.percent_of_total ?? 50),
    terms_and_conditions: termsBody || '(No override saved yet on the Terms & Legal tab — customers currently see the built-in fallback copy.)',
    data_privacy_policy: privacyBody || '(No override saved yet on the Terms & Legal tab — customers currently see the built-in fallback copy.)',
  };
}

async function loadTemplateForPackage(packageId) {
  const { data: template } = await supabase
    .from('contract_templates')
    .select('template_id, version_no, contract_type')
    .eq('package_id', packageId)
    .eq('is_active', true)
    .order('version_no', { ascending: false })
    .limit(1)
    .maybeSingle();

  currentTemplate = template || null;

  if (currentTemplate) {
    const { data: clauseRows } = await supabase
      .from('contract_template_clause')
      .select('clause_id, heading, body, sort_order')
      .eq('template_id', currentTemplate.template_id)
      .order('sort_order', { ascending: true });
    templateClauses = (clauseRows || []).map((c) => ({ ...c }));
  } else {
    templateClauses = [];
  }
}

// ── Rendering: Layer 1 fields ────────────────────────────────────────────
function renderFieldsList() {
  const list = document.getElementById('ct-fields-list');
  list.innerHTML = summaryFields.map((f, index) => `
    <div class="ct-field-row" data-field-index="${index}">
      <label class="pm2-toggle">
        <input type="checkbox" data-field-visible ${f.is_visible !== false ? 'checked' : ''}>
        <span class="pm2-toggle-track"></span>
      </label>
      <input type="text" class="ct-field-label-input" data-field-label value="${escHtml(f.label)}">
      <span class="ct-field-token">{{${escHtml(f.token)}}}</span>
      <span class="ct-field-sample">${escHtml(tokenValues[f.token] ?? '')}</span>
      <div class="ct-field-actions">
        <button type="button" data-field-action="up" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button type="button" data-field-action="down" ${index === summaryFields.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
      </div>
    </div>
  `).join('');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-field-action]');
  if (!btn) return;
  const row = btn.closest('[data-field-index]');
  const index = Number(row.dataset.fieldIndex);
  const action = btn.dataset.fieldAction;
  if (action === 'up' && index > 0) [summaryFields[index - 1], summaryFields[index]] = [summaryFields[index], summaryFields[index - 1]];
  if (action === 'down' && index < summaryFields.length - 1) [summaryFields[index + 1], summaryFields[index]] = [summaryFields[index], summaryFields[index + 1]];
  summaryFields.forEach((f, i) => { f.sort_order = i; });
  renderFieldsList();
});

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-field-label]')) {
    const index = Number(e.target.closest('[data-field-index]').dataset.fieldIndex);
    summaryFields[index].label = e.target.value;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-field-visible]')) {
    const index = Number(e.target.closest('[data-field-index]').dataset.fieldIndex);
    summaryFields[index].is_visible = e.target.checked;
  }
});

async function saveFields() {
  if (!selectedPackageId) return;
  const btn = document.getElementById('ct-fields-save');
  btn.disabled = true;
  setMsg('Saving fields…');
  try {
    for (const f of summaryFields) {
      const { error } = await supabase
        .from('contract_field')
        .update({ label: f.label, is_visible: f.is_visible !== false, sort_order: f.sort_order })
        .eq('field_id', f.field_id);
      if (error) throw error;
    }
    await logAudit({ action: 'Updated Contract Fields', category: 'reservation_form_config', details: 'Updated document field visibility/labels/order' });
    setMsg('Fields saved.');
  } catch (err) {
    setMsg('Failed to save fields: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Rendering: Layer 2/3 clauses ─────────────────────────────────────────
function renderTokenRefPanel() {
  const list = document.getElementById('ct-token-ref-list');
  list.innerHTML = Object.entries(TOKEN_INFO).map(([token, desc]) => `
    <span class="ct-token-ref-item"><code>{{${escHtml(token)}}}</code> ${escHtml(desc)}</span>
  `).join('');
}

function clauseRowHtml(clause, index) {
  return `
    <div class="ct-clause-row" data-clause-index="${index}">
      <div class="ct-clause-head">
        <input type="text" class="ct-clause-heading" data-clause-heading value="${escHtml(clause.heading)}" placeholder="Clause heading, e.g. Payment Terms">
        <div class="ct-clause-actions">
          <button type="button" data-clause-action="up" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" data-clause-action="down" ${index === templateClauses.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button type="button" data-clause-action="remove" title="Remove">✕</button>
        </div>
      </div>
      <textarea class="ct-clause-body" data-clause-body rows="4" placeholder="Clause text. Use {{tokens}} for figures that come from elsewhere.">${escHtml(clause.body)}</textarea>
      <p class="ct-clause-error hidden" data-clause-error></p>
    </div>
  `;
}

function lockedClauseRowHtml(key) {
  const clause = lockedClauses[key] || { heading: key, body: '' };
  const isUnlocked = unlockedKeys.has(key);
  if (!isUnlocked) {
    return `
      <div class="ct-clause-row ct-clause-locked" data-locked-key="${escHtml(key)}">
        <div class="ct-clause-head">
          <span class="ct-lock-icon">🔒</span>
          <span class="ct-clause-heading-text">${escHtml(clause.heading)}</span>
          <button type="button" class="et-action-btn" data-unlock-clause="${escHtml(key)}">Unlock to edit</button>
        </div>
        <p class="ct-clause-body-readonly">${escHtml(clause.body)}</p>
      </div>
    `;
  }
  return `
    <div class="ct-clause-row" data-locked-key="${escHtml(key)}">
      <div class="ct-clause-head">
        <span class="ct-lock-icon" title="Unlocked for editing">🔓</span>
        <input type="text" class="ct-clause-heading" data-locked-heading value="${escHtml(clause.heading)}">
        <div class="ct-clause-actions">
          <button type="button" class="et-action-btn" data-relock-clause="${escHtml(key)}" style="width:auto;padding:5px 10px;">Lock</button>
        </div>
      </div>
      <textarea class="ct-clause-body" data-locked-body rows="4">${escHtml(clause.body)}</textarea>
      <p class="ct-clause-error hidden" data-clause-error></p>
      <div style="display:flex;justify-content:flex-end;margin-top:8px;">
        <button type="button" class="btn-primary" data-save-locked="${escHtml(key)}" style="height:32px;padding:0 14px;font-size:12px;">Save this clause</button>
      </div>
    </div>
  `;
}

function renderClausesList() {
  const list = document.getElementById('ct-clauses-list');
  const editable = templateClauses.map((c, i) => clauseRowHtml(c, i)).join('');
  const locked = ['acknowledgement', 'electronic_signature'].map((key) => lockedClauseRowHtml(key)).join('');
  list.innerHTML = editable + locked;
}

document.addEventListener('input', (e) => {
  const row = e.target.closest('[data-clause-index]');
  if (row && (e.target.matches('[data-clause-heading]') || e.target.matches('[data-clause-body]'))) {
    const index = Number(row.dataset.clauseIndex);
    if (e.target.matches('[data-clause-heading]')) templateClauses[index].heading = e.target.value;
    if (e.target.matches('[data-clause-body]')) templateClauses[index].body = e.target.value;
    validateClauseRow(row, templateClauses[index].body);
  }
  const lockedRow = e.target.closest('[data-locked-key]');
  if (lockedRow && e.target.matches('[data-locked-body]')) {
    validateClauseRow(lockedRow, e.target.value);
  }
});

function validateClauseRow(row, body) {
  const unknown = findUnknownTokens(body);
  const errorEl = row.querySelector('[data-clause-error]');
  if (!errorEl) return unknown.length === 0;
  if (unknown.length) {
    errorEl.textContent = `Unknown token${unknown.length === 1 ? '' : 's'}: ${unknown.map((t) => `{{${t}}}`).join(', ')} — fix or remove before saving.`;
    errorEl.classList.remove('hidden');
  } else {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }
  return unknown.length === 0;
}

document.addEventListener('click', async (e) => {
  const clauseBtn = e.target.closest('[data-clause-action]');
  if (clauseBtn) {
    const row = clauseBtn.closest('[data-clause-index]');
    const index = Number(row.dataset.clauseIndex);
    const action = clauseBtn.dataset.clauseAction;
    if (action === 'up' && index > 0) [templateClauses[index - 1], templateClauses[index]] = [templateClauses[index], templateClauses[index - 1]];
    if (action === 'down' && index < templateClauses.length - 1) [templateClauses[index + 1], templateClauses[index]] = [templateClauses[index], templateClauses[index + 1]];
    if (action === 'remove') templateClauses.splice(index, 1);
    templateClauses.forEach((c, i) => { c.sort_order = i; });
    renderClausesList();
    return;
  }

  const unlockBtn = e.target.closest('[data-unlock-clause]');
  if (unlockBtn) {
    const key = unlockBtn.dataset.unlockClause;
    const clause = lockedClauses[key] || { heading: key };
    const proceed = window.confirm(
      `Unlock "${clause.heading}" to edit?\n\nThis is shared legal boilerplate used by every contract, not just this package's. Changes may affect the agreement's legal enforceability and will apply to every future contract as soon as you save. Continue?`
    );
    if (proceed) { unlockedKeys.add(key); renderClausesList(); }
    return;
  }

  const relockBtn = e.target.closest('[data-relock-clause]');
  if (relockBtn) {
    unlockedKeys.delete(relockBtn.dataset.relockClause);
    renderClausesList();
    return;
  }

  const saveLockedBtn = e.target.closest('[data-save-locked]');
  if (saveLockedBtn) {
    await saveLockedClause(saveLockedBtn.dataset.saveLocked);
    return;
  }
});

document.getElementById('ct-add-clause-btn')?.addEventListener('click', () => {
  templateClauses.push({ _localId: nextLocalClauseId++, heading: '', body: '', sort_order: templateClauses.length });
  renderClausesList();
});

async function saveLockedClause(key) {
  const row = document.querySelector(`[data-locked-key="${key}"]`);
  const heading = row.querySelector('[data-locked-heading]').value.trim();
  const body = row.querySelector('[data-locked-body]').value.trim();

  if (!validateClauseRow(row, body)) { setMsg('Fix the unknown token before saving.', true); return; }
  if (!heading || !body) { setMsg('Locked clause heading and body cannot be empty.', true); return; }

  setMsg('Saving locked clause…');
  try {
    const { error } = await supabase.from('contract_locked_clause').update({ heading, body, updated_at: new Date().toISOString() }).eq('key', key);
    if (error) throw error;
    lockedClauses[key] = { ...lockedClauses[key], heading, body };
    unlockedKeys.delete(key);
    await logAudit({ action: 'Updated Locked Contract Clause', category: 'reservation_form_config', details: `Updated "${heading}" (${key}) — applies to every package's contract` });
    renderClausesList();
    setMsg('Locked clause saved — this now applies to every package.');
  } catch (err) {
    setMsg('Failed to save: ' + err.message, true);
  }
}

async function saveClauses() {
  if (!selectedPackageId) return;
  const btn = document.getElementById('ct-clauses-save');

  // Validate every editable clause before touching the database.
  const rows = document.querySelectorAll('#ct-clauses-list [data-clause-index]');
  let hasError = false;
  templateClauses.forEach((c, i) => {
    const row = rows[i];
    if (row && !validateClauseRow(row, c.body)) hasError = true;
    if (!c.heading.trim() || !c.body.trim()) hasError = true;
  });
  if (hasError) { setMsg('Fix the highlighted clause(s) before saving — empty headings/bodies or unknown tokens block save.', true); return; }

  btn.disabled = true;
  setMsg('Saving clauses…');
  try {
    let templateId = currentTemplate?.template_id;

    if (!templateId) {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: newTemplate, error: createError } = await supabase
        .from('contract_templates')
        .insert({
          package_id: selectedPackageId,
          version_no: 1,
          contract_type: 'package_contract',
          description: 'Created from the Contract Template tab',
          is_active: true,
          created_by: user?.id ?? null,
        })
        .select('template_id, version_no, contract_type')
        .single();
      if (createError) throw createError;
      currentTemplate = newTemplate;
      templateId = newTemplate.template_id;
    }

    const { error: deleteError } = await supabase.from('contract_template_clause').delete().eq('template_id', templateId);
    if (deleteError) throw deleteError;

    if (templateClauses.length) {
      const rowsToInsert = templateClauses.map((c, i) => ({
        template_id: templateId,
        heading: c.heading.trim(),
        body: c.body.trim(),
        sort_order: i,
      }));
      const { error: insertError } = await supabase.from('contract_template_clause').insert(rowsToInsert);
      if (insertError) throw insertError;
    }

    await logAudit({
      action: 'Updated Contract Template Clauses',
      category: 'reservation_form_config',
      details: `${templateClauses.length} clause(s) for package ${selectedPackageId}`,
      entityId: templateId,
    });

    await loadTemplateForPackage(selectedPackageId);
    renderClausesList();
    setMsg('Clauses saved. Future contracts for this package will use them.');
  } catch (err) {
    setMsg('Failed to save clauses: ' + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Live preview (reuses the shared preview modal from the Terms & Legal tab) ──
function openContractPreview() {
  const values = { ...tokenValues };

  const fieldsHtml = summaryFields
    .filter((f) => f.is_visible !== false)
    .map((f) => `<p><strong>${escHtml(f.label)}:</strong> ${escHtml(values[f.token] ?? '')}</p>`)
    .join('');

  const clauseNumberStart = 1;
  const clausesHtml = templateClauses.map((c, i) => `
    <h4>${clauseNumberStart + i}. ${escHtml(mergeTokens(c.heading, values))}</h4>
    <p>${escHtml(mergeTokens(c.body, values))}</p>
  `).join('');

  const esClause = lockedClauses.electronic_signature;
  const esHtml = esClause
    ? `<h4>${clauseNumberStart + templateClauses.length}. ${escHtml(esClause.heading)}</h4><p>${escHtml(mergeTokens(esClause.body, values))}</p>`
    : '';

  const ackClause = lockedClauses.acknowledgement;
  const ackHtml = ackClause
    ? `<h4>${escHtml(ackClause.heading)}</h4><p>${escHtml(mergeTokens(ackClause.body, values))}</p>`
    : '';

  document.getElementById('rf-preview-title').textContent = 'Contract Preview';
  document.getElementById('rf-preview-body').innerHTML = `
    <p style="font-size:11.5px;color:var(--muted);margin-bottom:14px;"><em>Preview uses sample booking data. Real contracts fill from the customer's reservation.</em></p>
    <h4>Reservation Summary</h4>
    ${fieldsHtml || '<p><em>No visible fields.</em></p>'}
    ${clausesHtml}
    ${esHtml}
    ${ackHtml}
  `;
  document.getElementById('rf-preview-backdrop').classList.remove('hidden');
}

// ── Package switch + init ────────────────────────────────────────────────
async function refreshForSelectedPackage() {
  const editor = document.getElementById('ct-editor');
  if (!selectedPackageId) { editor.classList.add('hidden'); return; }

  setMsg('Loading template…');
  await loadTemplateForPackage(selectedPackageId);
  editor.classList.remove('hidden');
  renderFieldsList();
  renderClausesList();
  setMsg(currentTemplate ? '' : 'No template saved yet for this package — add clauses below and Save to create one.');
}

export async function initContractTemplateTab() {
  renderTokenRefPanel();
  await loadGlobalData();
  await loadPackages();
  await refreshForSelectedPackage();

  document.getElementById('ct-package-select')?.addEventListener('change', async (e) => {
    selectedPackageId = e.target.value || null;
    unlockedKeys.clear();
    await refreshForSelectedPackage();
  });

  document.getElementById('ct-fields-save')?.addEventListener('click', saveFields);
  document.getElementById('ct-clauses-save')?.addEventListener('click', saveClauses);
  document.getElementById('ct-preview-btn')?.addEventListener('click', openContractPreview);
}
