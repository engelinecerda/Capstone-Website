// js/admin_contracts_template.js
// ─────────────────────────────────────────────────────────────────────────────
// Add Contract Template modal — handles the entire lifecycle of creating a new
// contract_templates row:
//   1. Load packages from Supabase into the <select>
//   2. Accept a file upload (drag-drop or click) OR a pasted URL
//   3. If a file was chosen, upload it to Cloudinary via cloudinary.js
//      and get back a secure_url
//   4. Insert a row into contract_templates in Supabase
//
// Imported by: admin/contracts.html  (as a separate <script type="module">)
// Depends on:  js/supabase.js, js/cloudinary.js
// ─────────────────────────────────────────────────────────────────────────────

import { portalSupabase as supabase } from './supabase.js';
import { uploadToCloudinary }         from './cloudinary_contract_templates.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const addTemplateBtn    = document.getElementById('addTemplateBtn');
const addTemplateModal  = document.getElementById('addTemplateModal');
const addTemplateClose  = document.getElementById('addTemplateClose');
const addTemplateCancel = document.getElementById('addTemplateCancel');
const addTemplateSave   = document.getElementById('addTemplateSave');
const addTemplateMsg    = document.getElementById('addTemplateMsg');

const tmplPackage      = document.getElementById('tmplPackage');
const tmplContractType = document.getElementById('tmplContractType');
const tmplVersionNo    = document.getElementById('tmplVersionNo');
const tmplIsActive     = document.getElementById('tmplIsActive');
const tmplDescription  = document.getElementById('tmplDescription');
const tmplTemplateUrl  = document.getElementById('tmplTemplateUrl');
const tmplFileInput    = document.getElementById('tmplFileInput');
const tmplFileZone     = document.getElementById('tmplFileZone');
const tmplFileChosen   = document.getElementById('tmplFileChosen');
const tmplFileName     = document.getElementById('tmplFileName');
const tmplFileClear    = document.getElementById('tmplFileClear');

const sourceTabs    = document.querySelectorAll('.tmpl-source-tab');
const uploadPanel   = document.getElementById('tmplUploadPanel');
const urlPanel      = document.getElementById('tmplUrlPanel');

const progressWrap  = document.getElementById('tmplProgressWrap');
const progressLabel = document.getElementById('tmplProgressLabel');
const progressPct   = document.getElementById('tmplProgressPct');
const progressBar   = document.getElementById('tmplProgressBar');

// ── State ─────────────────────────────────────────────────────────────────────
let activeSource = 'upload'; // 'upload' | 'url'

// ── Message helpers ───────────────────────────────────────────────────────────
function showMsg(text, type = 'error') {
  addTemplateMsg.textContent = text;
  addTemplateMsg.className   = `tmpl-msg ${type}`;
}

function hideMsg() {
  addTemplateMsg.className = 'tmpl-msg hidden';
  addTemplateMsg.textContent = '';
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(pct, label = '') {
  progressWrap.classList.remove('hidden');
  progressBar.style.width    = `${pct}%`;
  progressPct.textContent    = `${pct}%`;
  progressLabel.textContent  = label || 'Uploading…';
}

function hideProgress() {
  progressWrap.classList.add('hidden');
  progressBar.style.width   = '0%';
  progressPct.textContent   = '0%';
  progressLabel.textContent = 'Uploading…';
}

// ── Modal open / close ────────────────────────────────────────────────────────
function openModal() {
  resetModal();
  loadPackages();
  addTemplateModal.classList.remove('hidden');
  addTemplateModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  addTemplateModal.classList.add('hidden');
  addTemplateModal.setAttribute('aria-hidden', 'true');
}

function resetModal() {
  tmplPackage.value        = '';
  tmplContractType.value   = '';
  tmplVersionNo.value      = '';
  tmplIsActive.value       = 'true';
  tmplDescription.value    = '';
  tmplTemplateUrl.value    = '';
  tmplFileInput.value      = '';
  tmplFileName.textContent = 'No file chosen';
  tmplFileChosen.classList.add('hidden');
  switchSource('upload');
  hideProgress();
  hideMsg();
  addTemplateSave.disabled = false;
}

// ── Source tab switching ──────────────────────────────────────────────────────
function switchSource(name) {
  activeSource = name;
  sourceTabs.forEach(t => t.classList.toggle('active', t.dataset.source === name));
  uploadPanel.classList.toggle('active', name === 'upload');
  urlPanel.classList.toggle('active',    name === 'url');
}

sourceTabs.forEach(tab => {
  tab.addEventListener('click', () => switchSource(tab.dataset.source));
});

// ── File zone — click, drag-drop ──────────────────────────────────────────────
tmplFileZone.addEventListener('click', () => tmplFileInput.click());

tmplFileZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  tmplFileZone.classList.add('drag-over');
});

tmplFileZone.addEventListener('dragleave', () => {
  tmplFileZone.classList.remove('drag-over');
});

tmplFileZone.addEventListener('drop', (e) => {
  e.preventDefault();
  tmplFileZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) applyFile(file);
});

tmplFileInput.addEventListener('change', () => {
  const file = tmplFileInput.files[0];
  if (file) applyFile(file);
});

function applyFile(file) {
  tmplFileName.textContent = file.name;
  tmplFileChosen.classList.remove('hidden');
}

tmplFileClear.addEventListener('click', () => {
  tmplFileInput.value      = '';
  tmplFileName.textContent = 'No file chosen';
  tmplFileChosen.classList.add('hidden');
});

// ── Load packages from Supabase ───────────────────────────────────────────────
async function loadPackages() {
  tmplPackage.innerHTML = '<option value="">Loading packages…</option>';

  const { data, error } = await supabase
    .from('package')
    .select('package_id, package_name')
    .order('package_name', { ascending: true });

  if (error || !data?.length) {
    tmplPackage.innerHTML = '<option value="">No packages found</option>';
    return;
  }

  tmplPackage.innerHTML =
    '<option value="">Select a package…</option>' +
    data
      .map(p => `<option value="${escHtml(p.package_id)}">${escHtml(p.package_name)}</option>`)
      .join('');
}

// ── Upload to Cloudinary ──────────────────────────────────────────────────────
// Builds a structured public_id: <packageId>/<timestamp>_<safeName>
// so files are organized per-package inside the Cloudinary Media Library.
async function doCloudinaryUpload(file, packageId) {
  const safeName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const publicId = `${packageId}/${Date.now()}_${safeName}`;

  setProgress(0, 'Uploading to Cloudinary…');

  const { secureUrl } = await uploadToCloudinary(file, {
    publicId,
    onProgress: (pct) => setProgress(pct, `Uploading to Cloudinary… ${pct}%`),
  });

  setProgress(100, 'Upload complete');
  return secureUrl;
}

// ── Save handler ──────────────────────────────────────────────────────────────
addTemplateSave.addEventListener('click', async () => {
  hideMsg();
  hideProgress();

  // Collect values
  const packageId    = tmplPackage.value.trim();
  const contractType = tmplContractType.value.trim();
  const versionNo    = parseInt(tmplVersionNo.value, 10);
  const isActive     = tmplIsActive.value === 'true';
  const description  = tmplDescription.value.trim() || null;
  const file         = tmplFileInput.files[0] ?? null;
  const pastedUrl    = tmplTemplateUrl.value.trim();

  // Validation
  if (!packageId)    { showMsg('Please select a package.');             return; }
  if (!contractType) { showMsg('Contract type is required.');           return; }
  if (!versionNo || versionNo < 1) { showMsg('Version number must be at least 1.'); return; }
  if (activeSource === 'upload' && !file)     { showMsg('Please choose a file to upload.'); return; }
  if (activeSource === 'url'    && !pastedUrl){ showMsg('Please paste a template URL.');    return; }

  showMsg('Saving template…', 'info');
  addTemplateSave.disabled = true;

  try {
    // Resolve who is creating this template
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('No active session found. Please log in again.');

    // Resolve the template URL — either Cloudinary upload or direct paste
    let templateUrl = pastedUrl;

    if (activeSource === 'upload') {
      showMsg('Uploading file to Cloudinary…', 'info');
      templateUrl = await doCloudinaryUpload(file, packageId);
      showMsg('File uploaded. Saving template record…', 'info');
    }

    // Insert into contract_templates
    const { error: insertErr } = await supabase
      .from('contract_templates')
      .insert({
        package_id:    packageId,
        version_no:    versionNo,
        contract_type: contractType,
        description,
        template_url:  templateUrl,
        is_active:     isActive,
        created_by:    user.id,
      });

    if (insertErr) throw insertErr;

    hideProgress();
    showMsg('Contract template saved successfully!', 'success');

    // Auto-close after a short delay so the user sees the success state
    setTimeout(closeModal, 1400);

  } catch (err) {
    hideProgress();
    showMsg(err.message || 'Failed to save template. Please try again.');
  } finally {
    addTemplateSave.disabled = false;
  }
});

// ── Wire open / close / keyboard ──────────────────────────────────────────────
addTemplateBtn?.addEventListener('click', openModal);
addTemplateClose?.addEventListener('click', closeModal);
addTemplateCancel?.addEventListener('click', closeModal);

addTemplateModal?.addEventListener('click', (e) => {
  if (e.target === addTemplateModal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !addTemplateModal.classList.contains('hidden')) {
    closeModal();
  }
});

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}