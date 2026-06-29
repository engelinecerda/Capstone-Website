// js/admin_contracts_template.js
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

const toggleTemplatesBtn   = document.getElementById('toggleTemplatesBtn');
const toggleTemplatesLabel = document.getElementById('toggleTemplatesLabel');
const templatesSection     = document.getElementById('templatesSection');
const templatesBody        = document.getElementById('templatesBody');
const templatesMessage     = document.getElementById('templatesMessage');

// ── Elements to hide when viewing templates ───────────────────────────────────
const submittedContractsCard = document.querySelector('.table-card:not(.templates-section)');
const chipsRowEl             = document.getElementById('chipsRow');
const toolbarGridEl          = document.querySelector('.toolbar-grid');
const statRowEl              = document.querySelector('.stat-row');

// ── State ─────────────────────────────────────────────────────────────────────
let activeSource     = 'upload'; // 'upload' | 'url'
let templatesVisible = false;
let templatesLoaded  = false;
let templatesCache   = [];       // stores all fetched templates for client-side search

// ── Message helpers ───────────────────────────────────────────────────────────
function showMsg(text, type = 'error') {
  addTemplateMsg.textContent = text;
  addTemplateMsg.className   = `tmpl-msg ${type}`;
}

function hideMsg() {
  addTemplateMsg.className   = 'tmpl-msg hidden';
  addTemplateMsg.textContent = '';
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(pct, label = '') {
  progressWrap.classList.remove('hidden');
  progressBar.style.width   = `${pct}%`;
  progressPct.textContent   = `${pct}%`;
  progressLabel.textContent = label || 'Uploading…';
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

   const nameWithoutExt = file.name
    .replace(/\.[^.]+$/, '')          
    .replace(/[_-]/g, ' ')            
    .replace(/\b\w/g, c => c.toUpperCase()); 
    
    tmplContractType.value = nameWithoutExt;
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

  const packageId    = tmplPackage.value.trim();
  const contractType = tmplContractType.value.trim();
  const versionNo    = parseInt(tmplVersionNo.value, 10);
  const isActive     = tmplIsActive.value === 'true';
  const description  = tmplDescription.value.trim() || null;
  const file         = tmplFileInput.files[0] ?? null;
  const pastedUrl    = tmplTemplateUrl.value.trim();

  // Validation
  if (!packageId)                           { showMsg('Please select a package.');            return; }
  if (!contractType)                        { showMsg('Contract type is required.');          return; }
  if (!versionNo || versionNo < 1)          { showMsg('Version number must be at least 1.'); return; }
  if (activeSource === 'upload' && !file)   { showMsg('Please choose a file to upload.');    return; }
  if (activeSource === 'url' && !pastedUrl) { showMsg('Please paste a template URL.');       return; }

  showMsg('Saving template…', 'info');
  addTemplateSave.disabled = true;

  try {
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) throw new Error('No active session found. Please log in again.');

    let templateUrl = pastedUrl;

    if (activeSource === 'upload') {
      showMsg('Uploading file to Cloudinary…', 'info');
      templateUrl = await doCloudinaryUpload(file, packageId);
      showMsg('File uploaded. Saving template record…', 'info');
    }

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
    refreshTemplatesIfVisible();

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

// ══════════════════════════════════════════════════════════════
// VIEW TEMPLATES TOGGLE
// ══════════════════════════════════════════════════════════════

// ── Templates message helper ──────────────────────────────────
function setTemplatesMessage(msg, isError = false) {
  if (!templatesMessage) return;
  templatesMessage.textContent = msg;
  templatesMessage.classList.toggle('error', isError);
}

// ── Search helper — matches any field ────────────────────────
function templateMatchesSearch(tmpl, term) {
  if (!term) return true;
  const haystack = [
    tmpl.contract_type,
    tmpl.package?.package_name,
    tmpl.description,
    String(tmpl.version_no || ''),
    `v${tmpl.version_no || ''}`,
    tmpl.is_active ? 'active' : 'inactive',
  ]
    .filter(Boolean)
    .map(val => String(val).toLowerCase());

  return haystack.some(val => val.includes(term));
}

// ── Render templates rows from a list ────────────────────────
function renderTemplateRows(list) {
  if (!templatesBody) return;

  if (!list.length) {
    templatesBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">No templates matched your search.</td>
      </tr>
    `;
    return;
  }

  templatesBody.innerHTML = list.map((tmpl) => {
    const statusKey   = tmpl.is_active ? 'active'   : 'inactive';
    const statusLabel = tmpl.is_active ? 'Active'   : 'Inactive';
    const pkgName     = tmpl.package?.package_name  || '—';
    const added       = tmpl.created_at
      ? new Date(tmpl.created_at).toLocaleDateString('en-PH', {
          year: 'numeric', month: 'short', day: 'numeric'
        })
      : '—';

    return `
      <tr class="reservation-row">
        <td data-label="Template Name">
          <div class="table-main">${escHtml(tmpl.contract_type || 'Untitled')}</div>
       
        </td>
        <td data-label="Package">
          <span class="table-main">${escHtml(pkgName)}</span>
        </td>
        <td data-label="Version">
          <span class="table-main">v${escHtml(String(tmpl.version_no || '1'))}</span>
        </td>
        <td data-label="Status">
          <span class="tmpl-status-pill ${statusKey}">${statusLabel}</span>
        </td>
        <td data-label="Description">
          <span class="table-sub">${escHtml(tmpl.description || '—')}</span>
        </td>
        <td data-label="Added">
          <span class="table-sub">${escHtml(added)}</span>
        </td>
          <td data-label="Actions">
            <div class="action-cell" style="justify-content: center;">
              ${tmpl.template_url
                ? `<a
                    class="action-btn"
                    href="${escHtml(tmpl.template_url)}"
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    Download
                  </a>`
                : `<span class="table-sub" style="font-size:12px;">No file</span>`
              }
              <button
                class="action-btn delete-tmpl-btn"
                data-id="${escHtml(tmpl.template_id)}"
                data-name="${escHtml(tmpl.contract_type || 'this template')}"
              >
                <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6"/>
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
                Delete
              </button>
            </div>
          </td>
      </tr>
    `;
  }).join('');
}

// ── Filter templates by search term ──────────────────────────
function filterTemplates() {
  const searchInput = document.getElementById('tmplSearchInput');
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const filtered = templatesCache.filter(tmpl => templateMatchesSearch(tmpl, term));

  renderTemplateRows(filtered);

  setTemplatesMessage(
    filtered.length === templatesCache.length
      ? `Showing ${templatesCache.length} template${templatesCache.length === 1 ? '' : 's'}.`
      : `Showing ${filtered.length} of ${templatesCache.length} template${templatesCache.length === 1 ? '' : 's'}.`
  );
}

function renderTemplatesToolbar() {
  if (document.getElementById('tmplSearchInput')) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'tmpl-toolbar';
  toolbar.innerHTML = `
    <label class="tmpl-search-wrap">
      <span class="tmpl-search-icon">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </span>
      <input
        id="tmplSearchInput"
        type="text"
        placeholder="Search by name, package, version, or description…"
        class="tmpl-search-input"
      />
    </label>
    <button type="button" class="tmpl-refresh-btn" id="tmplRefreshBtn" title="Refresh templates">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"/>
        <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"/>
      </svg>
    </button>
  `;

  const tableWrap = templatesSection?.querySelector('.table-wrap');
  if (tableWrap) {
    templatesSection.insertBefore(toolbar, tableWrap);
  }

  document.getElementById('tmplSearchInput')
    ?.addEventListener('input', filterTemplates);

  document.getElementById('tmplRefreshBtn')
    ?.addEventListener('click', async () => {
      templatesLoaded = false;
      templatesCache  = [];
      const searchInput = document.getElementById('tmplSearchInput');
      if (searchInput) searchInput.value = '';
      await loadTemplates();
    });
}

// ── Fetch + render templates ──────────────────────────────────
async function loadTemplates() {
  setTemplatesMessage('Loading templates...');

  if (templatesBody) {
    templatesBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">Loading…</td>
      </tr>
    `;
  }

  try {
    const { data, error } = await supabase
      .from('contract_templates')
      .select(`
        template_id,
        contract_type,
        version_no,
        description,
        template_url,
        is_active,
        created_at,
        package:package_id ( package_name )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    templatesCache = data || [];

    // Inject search bar now that we have data
    renderTemplatesToolbar();

    if (!templatesCache.length) {
      templatesBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">No contract templates have been added yet.</td>
        </tr>
      `;
      setTemplatesMessage('');
      return;
    }

    // Render all rows initially
    renderTemplateRows(templatesCache);

    setTemplatesMessage(
      `Showing ${templatesCache.length} template${templatesCache.length === 1 ? '' : 's'}.`
    );

    templatesLoaded = true;

  } catch (err) {
    templatesBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7">Failed to load templates.</td>
      </tr>
    `;
    setTemplatesMessage(`Failed to load templates: ${err.message}`, true);
  }
}

// ── Show contracts view (default state) ───────────────────────
function showContractsView() {
  submittedContractsCard?.classList.remove('section-hidden');
  chipsRowEl?.classList.remove('section-hidden');
  toolbarGridEl?.classList.remove('section-hidden');
  statRowEl?.classList.remove('section-hidden');

  templatesSection?.classList.add('hidden');

  toggleTemplatesBtn.classList.remove('showing-templates');
  if (toggleTemplatesLabel) {
    toggleTemplatesLabel.textContent = 'View Templates';
  }

  templatesVisible = false;
}

// ── Show templates view ───────────────────────────────────────
async function showTemplatesView() {
  submittedContractsCard?.classList.add('section-hidden');
  chipsRowEl?.classList.add('section-hidden');
  toolbarGridEl?.classList.add('section-hidden');
  statRowEl?.classList.add('section-hidden');

  templatesSection?.classList.remove('hidden');

  toggleTemplatesBtn.classList.add('showing-templates');
  if (toggleTemplatesLabel) {
    toggleTemplatesLabel.textContent = 'Show Submitted Contracts';
  }

  templatesVisible = true;

  if (!templatesLoaded) {
    await loadTemplates();
  }
}

// ── Delete template handler ───────────────────────────────────
templatesBody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.delete-tmpl-btn');
  if (!btn) return;

  const templateId = btn.dataset.id;
  const templateName = btn.dataset.name;

  if (!confirm(`Delete "${templateName}"?\n\nThis cannot be undone.`)) return;

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    const { error } = await supabase
      .from('contract_templates')
      .delete()
      .eq('template_id', templateId);

    if (error) throw error;

    // Remove row from cache and re-render
    templatesCache = templatesCache.filter(t => t.template_id !== templateId);
    renderTemplateRows(templatesCache);
    setTemplatesMessage(
      `Showing ${templatesCache.length} template${templatesCache.length === 1 ? '' : 's'}.`
    );

  } catch (err) {
    alert('Failed to delete template: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
});

// ── Toggle handler ────────────────────────────────────────────
toggleTemplatesBtn?.addEventListener('click', async () => {
  if (templatesVisible) {
    showContractsView();
  } else {
    await showTemplatesView();
  }
});

// ── Re-load after a new template is saved ────────────────────
export function refreshTemplatesIfVisible() {
  if (templatesVisible) {
    templatesLoaded = false;
    templatesCache  = [];

    // Clear search input so results aren't filtered on reload
    const searchInput = document.getElementById('tmplSearchInput');
    if (searchInput) searchInput.value = '';

    loadTemplates();
  }
}