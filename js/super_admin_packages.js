// super_admin_packages.js
// Two-level view: Categories → Packages
// Tables: public."(TEST) package_category" + public.package
// Image host: Cloudinary

import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { logAudit } from './audit_logger.js';

// ─── Cloudinary config ────────────────────────────────────────────────────────
const CLOUDINARY_UPLOAD_URL    = 'https://api.cloudinary.com/v1_1/dgneg418t/image/upload';
const CLOUDINARY_UPLOAD_PRESET = 'eli_coffee_packages';

// ─── Supabase tables ────────────────────────────────────────────────────────
const CATEGORY_TABLE = 'package_category';
const TIER_TABLE = 'package_tier';

// ─── State ────────────────────────────────────────────────────────────────────
let allCategories         = [];
let allPackages           = [];
let catShowingArchived    = false;
let pkgShowingArchived    = false;
let editingCategoryId     = null;
let editingPackageId      = null;
let activeCategoryId      = null;   
let activeCategoryName    = '';
let pendingAction         = null;   
let catPendingImageFile   = null;
let pkgPendingImageFile   = null;
let allTiers             = [];
let editingTierId        = null;
let tierForPackageId     = null;
let tierForPackageName   = '';
let tierPanelEl          = null;

// ─── DOM: Views ───────────────────────────────────────────────────────────────
const categoryView = document.getElementById('categoryView');
const packageView  = document.getElementById('packageView');

// ─── DOM: Category View ───────────────────────────────────────────────────────
const catSearchInput        = document.getElementById('catSearchInput');
const catToggleArchiveBtn   = document.getElementById('catToggleArchiveBtn');
const catToggleArchiveLabel = document.getElementById('catToggleArchiveLabel');
const activeCatSection      = document.getElementById('activeCatSection');
const archivedCatSection    = document.getElementById('archivedCatSection');
const activeCatBody         = document.getElementById('activeCatBody');
const archivedCatBody       = document.getElementById('archivedCatBody');
const catStatActive         = document.getElementById('catStatActive');
const catStatArchived       = document.getElementById('catStatArchived');
const catStatTotal          = document.getElementById('catStatTotal');
const catPageMessage        = document.getElementById('catPageMessage');
const addCategoryBtn        = document.getElementById('addCategoryBtn');

// ─── DOM: Package View ────────────────────────────────────────────────────────
const pkgSearchInput        = document.getElementById('pkgSearchInput');
const pkgTypeFilter         = document.getElementById('pkgTypeFilter');
const pkgToggleArchiveBtn   = document.getElementById('pkgToggleArchiveBtn');
const pkgToggleArchiveLabel = document.getElementById('pkgToggleArchiveLabel');
const activePkgSection      = document.getElementById('activePkgSection');
const archivedPkgSection    = document.getElementById('archivedPkgSection');
const activePkgBody         = document.getElementById('activePkgBody');
const archivedPkgBody       = document.getElementById('archivedPkgBody');
const pkgStatActive         = document.getElementById('pkgStatActive');
const pkgStatArchived       = document.getElementById('pkgStatArchived');
const pkgStatTotal          = document.getElementById('pkgStatTotal');
const pkgPageMessage        = document.getElementById('pkgPageMessage');
const addPackageBtn         = document.getElementById('addPackageBtn');
const backToCategoriesBtn   = document.getElementById('backToCategoriesBtn');
const breadcrumbLink        = document.getElementById('breadcrumbLink');
const breadcrumbCatName     = document.getElementById('breadcrumbCatName');
const pkgViewTitle          = document.getElementById('pkgViewTitle');
const pkgViewSub            = document.getElementById('pkgViewSub');

// ─── DOM: Category Modal ──────────────────────────────────────────────────────
const categoryModal      = document.getElementById('categoryModal');
const catModalTitle      = document.getElementById('catModalTitle');
const catModalSub        = document.getElementById('catModalSub');
const catModalClose      = document.getElementById('catModalClose');
const catModalCancel     = document.getElementById('catModalCancel');
const catModalSave       = document.getElementById('catModalSave');
const catModalSaveLabel  = document.getElementById('catModalSaveLabel');
const catModalMessage    = document.getElementById('catModalMessage');
const catNameInput       = document.getElementById('catNameInput');
const catDescriptionInput = document.getElementById('catDescriptionInput');  
const catInclusionsInput  = document.getElementById('catInclusionsInput'); 
const catImageInput      = document.getElementById('catImageInput');
const catImagePreview    = document.getElementById('catImagePreview');
const catImagePlaceholder= document.getElementById('catImagePlaceholder');
const catFileName        = document.getElementById('catFileName');
const catRemoveImageBtn  = document.getElementById('catRemoveImageBtn');

// ─── DOM: Package Modal ───────────────────────────────────────────────────────
const packageModal       = document.getElementById('packageModal');
const pkgModalTitle      = document.getElementById('pkgModalTitle');
const pkgModalSub        = document.getElementById('pkgModalSub');
const pkgModalClose      = document.getElementById('pkgModalClose');
const pkgModalCancel     = document.getElementById('pkgModalCancel');
const pkgModalSave       = document.getElementById('pkgModalSave');
const pkgModalSaveLabel  = document.getElementById('pkgModalSaveLabel');
const pkgModalMessage    = document.getElementById('pkgModalMessage');
const pkgImageInput      = document.getElementById('pkgImageInput');
const pkgImagePreview    = document.getElementById('pkgImagePreview');
const pkgImagePlaceholder= document.getElementById('pkgImagePlaceholder');
const pkgFileName        = document.getElementById('pkgFileName');
const pkgRemoveImageBtn  = document.getElementById('pkgRemoveImageBtn');
const pkgName            = document.getElementById('pkgName');
const pkgType            = document.getElementById('pkgType');
const pkgDescription     = document.getElementById('pkgDescription');
const pkgPrice           = document.getElementById('pkgPrice');
const pkgCapacity        = document.getElementById('pkgCapacity');
const pkgDuration        = document.getElementById('pkgDuration');
const pkgExtensionPrice  = document.getElementById('pkgExtensionPrice');
const pkgLocationType    = document.getElementById('pkgLocationType');

// ─── DOM: Confirm Modal ───────────────────────────────────────────────────────
const confirmModal   = document.getElementById('confirmModal');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmCopy    = document.getElementById('confirmCopy');
const confirmClose   = document.getElementById('confirmClose');
const confirmCancel  = document.getElementById('confirmCancel');
const confirmOk      = document.getElementById('confirmOk');
const confirmMessage = document.getElementById('confirmMessage');

// ─── DOM: Package tier ───────────────────────────────────────────────────────
const tierModal          = document.getElementById('tierModal');
const tierModalTitle     = document.getElementById('tierModalTitle');
const tierModalSub       = document.getElementById('tierModalSub');
const tierModalClose     = document.getElementById('tierModalClose');
const tierModalCancel    = document.getElementById('tierModalCancel');
const tierModalSave      = document.getElementById('tierModalSave');
const tierModalSaveLabel = document.getElementById('tierModalSaveLabel');
const tierModalMessage   = document.getElementById('tierModalMessage');
const tierNameInput      = document.getElementById('tierName');
const tierSubtitle       = document.getElementById('tierSubtitle');
const tierFullInclusions = document.getElementById('tierFullInclusions');
const tierSortOrder      = document.getElementById('tierSortOrder');

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function formatCurrency(v)  { return `₱${Number(v || 0).toLocaleString()}`; }
function formatCapacity(v)  { return v ? `${v} pax` : '—'; }
function formatDuration(v)  { return v ? `${v} hr${v !== 1 ? 's' : ''}` : '—'; }

function setMessage(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => { el.textContent = ''; el.className = 'page-message'; }, 4000);
}

function setModalMsg(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `modal-message ${type}`;
}

function openModal(modal) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
// one-per-line or comma-separated → stored as newline-separated ──
function normalizeTierInclusions(raw) {
  if (!raw || !raw.trim()) return null;
  return raw
    .split(/[\n,]+/)          // split by newline or comma
    .map(item => item.trim()) // trim each item
    .filter(Boolean)          // remove empty strings
    .join('\n');               // store as newline-separated
}

// ─── Cloudinary upload ────────────────────────────────────────────────────────
async function uploadToCloudinary(file, folder = 'eli_coffee_packages') {
  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  form.append('folder', folder);

  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Image upload failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return data.secure_url;
}

function validateImageFile(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return 'Only JPG, PNG, or WEBP images are allowed.';
  }
  if (file.size > 5 * 1024 * 1024) {
    return 'Image must be under 5 MB.';
  }
  return null;
}

function previewImageFile(file, previewEl, placeholderEl, fileNameEl) {
  fileNameEl.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    previewEl.src = e.target.result;
    previewEl.classList.remove('hidden');
    placeholderEl.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function clearImageUI(previewEl, placeholderEl, fileNameEl, inputEl) {
  previewEl.src = '';
  previewEl.classList.add('hidden');
  placeholderEl.style.display = '';
  fileNameEl.textContent = 'No file chosen';
  if (inputEl) inputEl.value = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════════════════════════════════
function showCategoryView() {
  activeCategoryId   = null;
  activeCategoryName = '';
  categoryView.style.display = '';
  packageView.style.display  = 'none';
  pkgShowingArchived = false;
  applyPkgArchiveToggle();
}

function showPackageView(categoryId, categoryName) {
  activeCategoryId   = categoryId;
  activeCategoryName = categoryName;

  breadcrumbCatName.textContent = categoryName;
  pkgViewTitle.textContent      = categoryName;
  pkgViewSub.textContent        = `Manage packages in "${categoryName}"`;

  categoryView.style.display = 'none';
  packageView.style.display  = '';

  pkgShowingArchived = false;
  applyPkgArchiveToggle();
  pkgSearchInput.value = '';
  pkgTypeFilter.value  = '';

  loadPackagesForCategory(categoryId);
}

backToCategoriesBtn.addEventListener('click', showCategoryView);
breadcrumbLink.addEventListener('click', showCategoryView);
breadcrumbLink.style.cursor = 'pointer';

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: SUPABASE
// ═══════════════════════════════════════════════════════════════════════════════


async function loadCategories() {
  setMessage(catPageMessage, 'Loading categories…');
  try {
    // Load categories
    const { data: cats, error: catErr } = await supabase
      .from(CATEGORY_TABLE)
      .select('*')
      .order('created_at', { ascending: false });
    if (catErr) throw catErr;
    allCategories = cats || [];

    // Load all packages to count per category
    const { data: pkgs, error: pkgErr } = await supabase
      .from('package')
      .select('package_id, package_category_id, is_active');
    if (pkgErr) throw pkgErr;
    allPackages = pkgs || [];

    renderCategoryTables();
    setMessage(catPageMessage, '');
  } catch (err) {
    setMessage(catPageMessage, `Failed to load categories: ${err.message}`, 'error');
    renderCategoryTables();
  }
}

async function loadPackagesForCategory(categoryId) {
  setMessage(pkgPageMessage, 'Loading packages…');
  try {
    const { data, error } = await supabase
      .from('package')
      .select('*')
      .eq('package_category_id', categoryId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    allPackages = data || [];
    renderPackageTables();
    setMessage(pkgPageMessage, '');
  } catch (err) {
    setMessage(pkgPageMessage, `Failed to load packages: ${err.message}`, 'error');
    renderPackageTables();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function getCategoryPackageCount(catId) {
  // Count from preloaded package list (loaded in loadCategories)
  return allPackages.filter(p => p.package_category_id === catId && p.is_active).length;
}

function buildCatThumb(cat) {
  if (cat.category_image) {
    return `<div class="pkg-thumb"><img src="${escapeHtml(cat.category_image)}" alt="${escapeHtml(cat.category_name)}" loading="lazy"></div>`;
  }
  return `<div class="pkg-thumb">
    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  </div>`;
}

function buildCatRow(cat) {
  const isArchived = !cat.is_active;
  const pkgCount = getCategoryPackageCount(cat.package_category_id);

  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-cat-action="edit" data-id="${cat.package_category_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn restore" data-cat-action="restore" data-id="${cat.package_category_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Restore
        </button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn view" data-cat-action="view" data-id="${cat.package_category_id}" data-name="${escapeHtml(cat.category_name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          View
        </button>
        <button class="action-btn edit" data-cat-action="edit" data-id="${cat.package_category_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn archive" data-cat-action="archive" data-id="${cat.package_category_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
          Archive
        </button>
      </div>`;

  return `<tr>
    <td>
      <div class="pkg-cell clickable-cat" data-cat-action="view" data-id="${cat.package_category_id}" data-name="${escapeHtml(cat.category_name)}">
        ${buildCatThumb(cat)}
        <div>
          <div class="pkg-name">${escapeHtml(cat.category_name)}</div>
          <div class="pkg-id">${escapeHtml(cat.package_category_id.slice(0, 8))}…</div>
        </div>
      </div>
    </td>
    <td><span class="count-pill">${pkgCount} active package${pkgCount !== 1 ? 's' : ''}</span></td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function getFilteredCategories(isActive) {
  const term = (catSearchInput.value || '').trim().toLowerCase();
  return allCategories.filter(cat => {
    if (Boolean(cat.is_active) !== isActive) return false;
    if (term && !(cat.category_name || '').toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderCategoryTables() {
  const active   = getFilteredCategories(true);
  const archived = getFilteredCategories(false);

  activeCatBody.innerHTML = active.length
    ? active.map(buildCatRow).join('')
    : '<tr class="empty-row"><td colspan="4">No active categories found.</td></tr>';

  archivedCatBody.innerHTML = archived.length
    ? archived.map(buildCatRow).join('')
    : '<tr class="empty-row"><td colspan="4">No archived categories.</td></tr>';

  updateCategoryStats();
}

function updateCategoryStats() {
  const active   = allCategories.filter(c => c.is_active).length;
  const archived = allCategories.filter(c => !c.is_active).length;
  catStatActive.textContent   = active;
  catStatArchived.textContent = archived;
  catStatTotal.textContent    = allCategories.length;
}

// ─── Category archive toggle ─────────────────────────────────────────────────
function applyCatArchiveToggle() {
  if (catShowingArchived) {
    archivedCatSection.style.display = '';
    activeCatSection.style.display   = 'none';
    catToggleArchiveLabel.textContent = 'Show Active';
    catToggleArchiveBtn.classList.add('showing-active');
  } else {
    activeCatSection.style.display   = '';
    archivedCatSection.style.display = 'none';
    catToggleArchiveLabel.textContent = 'Show Archived';
    catToggleArchiveBtn.classList.remove('showing-active');
  }
}

catToggleArchiveBtn.addEventListener('click', () => { catShowingArchived = !catShowingArchived; applyCatArchiveToggle(); });
catSearchInput.addEventListener('input', renderCategoryTables);

// ─── Category table action delegation ─────────────────────────────────────────
function handleCatTableAction(e) {
  const btn = e.target.closest('[data-cat-action]');
  if (!btn) return;
  const { catAction, id, name } = btn.dataset;
  if (catAction === 'view')    showPackageView(id, name);
  if (catAction === 'edit')    openEditCategoryModal(id);
  if (catAction === 'archive') openConfirmArchiveCategory(id);
  if (catAction === 'restore') openConfirmRestoreCategory(id);
}

activeCatBody.addEventListener('click', handleCatTableAction);
archivedCatBody.addEventListener('click', handleCatTableAction);

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: MODAL (Add / Edit)
// ═══════════════════════════════════════════════════════════════════════════════
function openAddCategoryModal() {
  editingCategoryId   = null;
  catPendingImageFile = null;
  catModalTitle.textContent     = 'Add New Category';
  catModalSub.textContent       = 'Create a new package category';
  catModalSaveLabel.textContent = 'Add Category';
  catNameInput.value = '';
  catDescriptionInput.value = '';   
  catInclusionsInput.value  = '';
  catImageInput.value = '';
  clearImageUI(catImagePreview, catImagePlaceholder, catFileName, catImageInput);
  catRemoveImageBtn.classList.add('hidden');
  setModalMsg(catModalMessage, '');
  openModal(categoryModal);
}

function openEditCategoryModal(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;

  editingCategoryId   = catId;
  catPendingImageFile = null;
  catModalTitle.textContent     = 'Edit Category';
  catModalSub.textContent       = 'Update category details';
  catModalSaveLabel.textContent = 'Save Changes';
  catNameInput.value = cat.category_name || '';
  catDescriptionInput.value = cat.description || '';                      
  catInclusionsInput.value  = cat.package_category_inclusions || ''; 

  if (cat.category_image) {
    catImagePreview.src = cat.category_image;
    catImagePreview.classList.remove('hidden');
    catImagePlaceholder.style.display = 'none';
    catFileName.textContent = 'Current image loaded';
    catRemoveImageBtn.classList.remove('hidden');
  } else {
    clearImageUI(catImagePreview, catImagePlaceholder, catFileName, catImageInput);
    catRemoveImageBtn.classList.add('hidden');
  }

  setModalMsg(catModalMessage, '');
  openModal(categoryModal);
}

// Category image input
catImageInput.addEventListener('change', () => {
  const file = catImageInput.files[0];
  if (!file) return;
  const err = validateImageFile(file);
  if (err) { setModalMsg(catModalMessage, err); catImageInput.value = ''; return; }
  catPendingImageFile = file;
  setModalMsg(catModalMessage, '');
  previewImageFile(file, catImagePreview, catImagePlaceholder, catFileName);
  catRemoveImageBtn.classList.remove('hidden');
});

catRemoveImageBtn.addEventListener('click', () => {
  catPendingImageFile = null;
  clearImageUI(catImagePreview, catImagePlaceholder, catFileName, catImageInput);
  catRemoveImageBtn.classList.add('hidden');
  // Mark removal so we clear it in DB on save
  catRemoveImageBtn.dataset.removeExisting = 'true';
});

// Category save
catModalSave.addEventListener('click', async () => {
  const name = catNameInput.value.trim();
  const description = catDescriptionInput.value.trim();                   
  const inclusions  = catInclusionsInput.value.trim(); 

  if (!name) { setModalMsg(catModalMessage, 'Category name is required.'); return; }

  catModalSave.disabled = true;
  catModalSaveLabel.textContent = 'Saving…';
  setModalMsg(catModalMessage, '');

  try {
    let imageUrl = undefined; // undefined = don't change

    if (catPendingImageFile) {
      setModalMsg(catModalMessage, 'Uploading image…', 'success');
      imageUrl = await uploadToCloudinary(catPendingImageFile, 'eli_coffee_categories');
      setModalMsg(catModalMessage, '');
    } else if (catRemoveImageBtn.dataset.removeExisting === 'true') {
      imageUrl = null; // explicitly clear
    }

    const payload = { 
      category_name: name,
      description: description,
      package_category_inclusions: inclusions
    };
    if (imageUrl !== undefined) payload.category_image = imageUrl;

    if (editingCategoryId) {
      const { data, error } = await supabase
        .from(CATEGORY_TABLE)
        .update(payload)
        .eq('package_category_id', editingCategoryId)
        .select()
        .single();
      if (error) throw error;
      const idx = allCategories.findIndex(c => c.package_category_id === editingCategoryId);
      if (idx !== -1) allCategories[idx] = data;
      await logAudit({
        action:   'Updated Category',
        category: 'package',
        details:  `Category updated: ${name}`,
        entityId: editingCategoryId
      });
      setMessage(catPageMessage, 'Category updated successfully.', 'success');
    } else {
      payload.is_active = true;
      const { data, error } = await supabase
        .from(CATEGORY_TABLE)
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      allCategories.unshift(data);
      await logAudit({
        action:   'Added Category',
        category: 'package',
        details:  `New category created: ${name}`,
        entityId: data.package_category_id
      });
      setMessage(catPageMessage, 'Category added successfully.', 'success');
    }

    renderCategoryTables();
    closeModal(categoryModal);

  } catch (err) {
    setModalMsg(catModalMessage, `Failed to save: ${err.message}`);
  } finally {
    catModalSave.disabled = false;
    catModalSaveLabel.textContent = editingCategoryId ? 'Save Changes' : 'Add Category';
    catRemoveImageBtn.dataset.removeExisting = '';
    catPendingImageFile = null;
  }
});

addCategoryBtn.addEventListener('click', openAddCategoryModal);
catModalClose.addEventListener('click',  () => closeModal(categoryModal));
catModalCancel.addEventListener('click', () => closeModal(categoryModal));
categoryModal.addEventListener('click', e => { if (e.target === categoryModal) closeModal(categoryModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY: ARCHIVE / RESTORE
// ═══════════════════════════════════════════════════════════════════════════════
function openConfirmArchiveCategory(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;
  pendingAction = { scope: 'category', type: 'archive', id: catId };
  confirmTitle.textContent = 'Archive Category';
  confirmCopy.textContent  = `Are you sure you want to archive "${cat.category_name}"? It and its packages will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestoreCategory(catId) {
  const cat = allCategories.find(c => c.package_category_id === catId);
  if (!cat) return;
  pendingAction = { scope: 'category', type: 'restore', id: catId };
  confirmTitle.textContent = 'Restore Category';
  confirmCopy.textContent  = `Restore "${cat.category_name}" and make it visible to customers again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: RENDERING
// ═══════════════════════════════════════════════════════════════════════════════
function buildPkgThumb(pkg) {
  if (pkg.package_image) {
    return `<div class="pkg-thumb"><img src="${escapeHtml(pkg.package_image)}" alt="${escapeHtml(pkg.package_name)}" loading="lazy"></div>`;
  }
  return `<div class="pkg-thumb">
    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  </div>`;
}

function buildPkgRow(pkg) {
  const isArchived = !pkg.is_active;
  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-pkg-action="edit" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn restore" data-pkg-action="restore" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Restore
        </button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn tiers" data-pkg-action="tiers" data-id="${pkg.package_id}" data-name="${escapeHtml(pkg.package_name)}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          Tiers
        </button>
        <button class="action-btn edit" data-pkg-action="edit" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn archive" data-pkg-action="archive" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
          Archive
        </button>
      </div>`;

  return `<tr>
    <td>
      <div class="pkg-cell">
        ${buildPkgThumb(pkg)}
        <div>
          <div class="pkg-name">${escapeHtml(pkg.package_name)}</div>
          <div class="pkg-id">${escapeHtml(pkg.package_id.slice(0, 8))}…</div>
        </div>
      </div>
    </td>
    <td><span class="category-pill">${escapeHtml(pkg.package_type || '—')}</span></td>
    <td>${escapeHtml(formatCurrency(pkg.price))}</td>
    <td>${escapeHtml(formatCapacity(pkg.guest_capacity))}</td>
    <td>${escapeHtml(formatDuration(pkg.duration_hours))}</td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function getFilteredPackages(isActive) {
  const term    = (pkgSearchInput.value || '').trim().toLowerCase();
  const typeVal = pkgTypeFilter.value;
  return allPackages.filter(pkg => {
    if (Boolean(pkg.is_active) !== isActive) return false;
    if (typeVal && pkg.package_type !== typeVal) return false;
    if (term) {
      const hay = `${pkg.package_name} ${pkg.package_type} ${pkg.description || ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

function renderPackageTables() {
  const active   = getFilteredPackages(true);
  const archived = getFilteredPackages(false);

  activePkgBody.innerHTML = active.length
    ? active.map(buildPkgRow).join('')
    : '<tr class="empty-row"><td colspan="7">No active packages found.</td></tr>';

  archivedPkgBody.innerHTML = archived.length
    ? archived.map(buildPkgRow).join('')
    : '<tr class="empty-row"><td colspan="7">No archived packages.</td></tr>';

  updatePackageStats();
}

function updatePackageStats() {
  const active   = allPackages.filter(p => p.is_active).length;
  const archived = allPackages.filter(p => !p.is_active).length;
  pkgStatActive.textContent   = active;
  pkgStatArchived.textContent = archived;
  pkgStatTotal.textContent    = allPackages.length;
}

// ─── Package archive toggle ──────────────────────────────────────────────────
function applyPkgArchiveToggle() {
  if (pkgShowingArchived) {
    archivedPkgSection.style.display = '';
    activePkgSection.style.display   = 'none';
    pkgToggleArchiveLabel.textContent = 'Show Active';
    pkgToggleArchiveBtn.classList.add('showing-active');
  } else {
    activePkgSection.style.display   = '';
    archivedPkgSection.style.display = 'none';
    pkgToggleArchiveLabel.textContent = 'Show Archived';
    pkgToggleArchiveBtn.classList.remove('showing-active');
  }
}

pkgToggleArchiveBtn.addEventListener('click', () => { pkgShowingArchived = !pkgShowingArchived; applyPkgArchiveToggle(); });
pkgSearchInput.addEventListener('input', renderPackageTables);
pkgTypeFilter.addEventListener('change', renderPackageTables);

// ─── Package table action delegation ──────────────────────────────────────────
function handlePkgTableAction(e) {
  const btn = e.target.closest('[data-pkg-action]');
  if (!btn) return;
  const { pkgAction, id, name } = btn.dataset;
  if (pkgAction === 'edit')    openEditPackageModal(id);
  if (pkgAction === 'archive') openConfirmArchivePackage(id);
  if (pkgAction === 'restore') openConfirmRestorePackage(id);
  if (pkgAction === 'tiers')   openTierPanel(id, name);
}

activePkgBody.addEventListener('click', handlePkgTableAction);
archivedPkgBody.addEventListener('click', handlePkgTableAction);

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: MODAL (Add / Edit)
// ═══════════════════════════════════════════════════════════════════════════════
function openAddPackageModal() {
  editingPackageId   = null;
  pkgPendingImageFile = null;
  pkgModalTitle.textContent     = 'Add New Package';
  pkgModalSub.textContent       = `Add a package to "${activeCategoryName}"`;
  pkgModalSaveLabel.textContent = 'Add Package';
  clearPackageForm();
  setModalMsg(pkgModalMessage, '');
  openModal(packageModal);
}

function openEditPackageModal(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;

  editingPackageId    = packageId;
  pkgPendingImageFile = null;
  pkgModalTitle.textContent     = 'Edit Package';
  pkgModalSub.textContent       = 'Update the package details below';
  pkgModalSaveLabel.textContent = 'Save Changes';

  pkgName.value           = pkg.package_name || '';
  pkgType.value           = pkg.package_type || '';
  pkgDescription.value    = pkg.description || '';
  pkgPrice.value          = pkg.price ?? '';
  pkgCapacity.value       = pkg.guest_capacity ?? '';
  pkgDuration.value       = pkg.duration_hours ?? '';
  pkgExtensionPrice.value = pkg.extension_price ?? '';
  pkgLocationType.value   = pkg.location_type || '';

  if (pkg.package_image) {
    pkgImagePreview.src = pkg.package_image;
    pkgImagePreview.classList.remove('hidden');
    pkgImagePlaceholder.style.display = 'none';
    pkgFileName.textContent = 'Current image loaded';
    pkgRemoveImageBtn.classList.remove('hidden');
  } else {
    clearImageUI(pkgImagePreview, pkgImagePlaceholder, pkgFileName, pkgImageInput);
    pkgRemoveImageBtn.classList.add('hidden');
  }

  setModalMsg(pkgModalMessage, '');
  openModal(packageModal);
}

function clearPackageForm() {
  [pkgName, pkgDescription, pkgPrice, pkgCapacity, pkgDuration, pkgExtensionPrice].forEach(el => el.value = '');
  pkgType.value         = '';
  pkgLocationType.value = '';
  pkgImageInput.value   = '';
  clearImageUI(pkgImagePreview, pkgImagePlaceholder, pkgFileName, pkgImageInput);
  pkgRemoveImageBtn.classList.add('hidden');
}

// Package image input
pkgImageInput.addEventListener('change', () => {
  const file = pkgImageInput.files[0];
  if (!file) return;
  const err = validateImageFile(file);
  if (err) { setModalMsg(pkgModalMessage, err); pkgImageInput.value = ''; return; }
  pkgPendingImageFile = file;
  setModalMsg(pkgModalMessage, '');
  previewImageFile(file, pkgImagePreview, pkgImagePlaceholder, pkgFileName);
  pkgRemoveImageBtn.classList.remove('hidden');
});

pkgRemoveImageBtn.addEventListener('click', () => {
  pkgPendingImageFile = null;
  clearImageUI(pkgImagePreview, pkgImagePlaceholder, pkgFileName, pkgImageInput);
  pkgRemoveImageBtn.classList.add('hidden');
  pkgRemoveImageBtn.dataset.removeExisting = 'true';
});

// Package validation
function validatePackageForm() {
  if (!pkgName.value.trim()) return 'Package name is required.';
  if (!pkgType.value)        return 'Package type is required.';
  if (pkgPrice.value === '' || isNaN(Number(pkgPrice.value)) || Number(pkgPrice.value) < 0)
    return 'A valid price is required.';
  if (pkgCapacity.value !== '' && isNaN(parseInt(pkgCapacity.value)))
    return 'A valid guest capacity is required.';
  if (!pkgDuration.value || isNaN(parseInt(pkgDuration.value)) || parseInt(pkgDuration.value) < 1)
    return 'A valid duration in hours is required.';
  return null;
}

// Package save
pkgModalSave.addEventListener('click', async () => {
  const err = validatePackageForm();
  if (err) { setModalMsg(pkgModalMessage, err); return; }

  pkgModalSave.disabled = true;
  pkgModalSaveLabel.textContent = 'Saving…';
  setModalMsg(pkgModalMessage, '');

  try {
    let imageUrl = undefined;
    if (pkgPendingImageFile) {
      setModalMsg(pkgModalMessage, 'Uploading image…', 'success');
      imageUrl = await uploadToCloudinary(pkgPendingImageFile);
      setModalMsg(pkgModalMessage, '');
    } else if (pkgRemoveImageBtn.dataset.removeExisting === 'true') {
      imageUrl = null;
    }

    const payload = {
      package_name:       pkgName.value.trim(),
      package_type:       pkgType.value,
      description:        pkgDescription.value.trim() || null,
      price:              Number(pkgPrice.value),
      guest_capacity:     parseInt(pkgCapacity.value, 10),
      duration_hours:     parseInt(pkgDuration.value, 10),
      extension_price:    pkgExtensionPrice.value !== '' ? Number(pkgExtensionPrice.value) : null,
      location_type:      pkgLocationType.value || null,
      package_category_id: activeCategoryId,
    };

    if (imageUrl !== undefined) payload.package_image = imageUrl;

    if (editingPackageId) {
      const { data, error } = await supabase
        .from('package')
        .update(payload)
        .eq('package_id', editingPackageId)
        .select()
        .single();
      if (error) throw error;
      const idx = allPackages.findIndex(p => p.package_id === editingPackageId);
      if (idx !== -1) allPackages[idx] = data;
      await logAudit({
        action:   'Updated Package',
        category: 'package',
        details:  `Package updated: ${payload.package_name} (Category: ${activeCategoryName})`,
        entityId: editingPackageId
      });
      setMessage(pkgPageMessage, 'Package updated successfully.', 'success');
    } else {
      payload.is_active = true;
      const { data, error } = await supabase
        .from('package')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      allPackages.unshift(data);
      await logAudit({
        action:   'Added Package',
        category: 'package',
        details:  `New package created: ${payload.package_name} (Category: ${activeCategoryName})`,
        entityId: data.package_id
      });
      setMessage(pkgPageMessage, 'Package added successfully.', 'success');
    }

    renderPackageTables();
    closeModal(packageModal);

  } catch (err) {
    setModalMsg(pkgModalMessage, `Failed to save: ${err.message}`);
  } finally {
    pkgModalSave.disabled = false;
    pkgModalSaveLabel.textContent = editingPackageId ? 'Save Changes' : 'Add Package';
    pkgRemoveImageBtn.dataset.removeExisting = '';
    pkgPendingImageFile = null;
  }
});

addPackageBtn.addEventListener('click', openAddPackageModal);
pkgModalClose.addEventListener('click',  () => closeModal(packageModal));
pkgModalCancel.addEventListener('click', () => closeModal(packageModal));
packageModal.addEventListener('click', e => { if (e.target === packageModal) closeModal(packageModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE: ARCHIVE / RESTORE
// ═══════════════════════════════════════════════════════════════════════════════
function openConfirmArchivePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { scope: 'package', type: 'archive', id: packageId };
  confirmTitle.textContent = 'Archive Package';
  confirmCopy.textContent  = `Are you sure you want to archive "${pkg.package_name}"? It will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmRestorePackage(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { scope: 'package', type: 'restore', id: packageId };
  confirmTitle.textContent = 'Restore Package';
  confirmCopy.textContent  = `Restore "${pkg.package_name}" and make it visible to customers again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIRM MODAL: Shared handler
// ═══════════════════════════════════════════════════════════════════════════════
confirmOk.addEventListener('click', async () => {
  if (!pendingAction) return;
  const { scope, type, id } = pendingAction;
  confirmOk.disabled = true;

  try {
    const isActive = type === 'restore';

    if (scope === 'category') {
      const { data, error } = await supabase
        .from(CATEGORY_TABLE)
        .update({ is_active: isActive })
        .eq('package_category_id', id)
        .select()
        .single();
      if (error) throw error;
      const idx = allCategories.findIndex(c => c.package_category_id === id);
      if (idx !== -1) allCategories[idx] = data;
      await logAudit({
        action:   type === 'archive' ? 'Archived Category' : 'Restored Category',
        category: 'package',
        details:  `Category ${type === 'archive' ? 'archived' : 'restored'}: ${data.category_name}`,
        entityId: id
      });
      catShowingArchived = !isActive;
      applyCatArchiveToggle();
      renderCategoryTables();
      setMessage(catPageMessage, type === 'archive' ? 'Category archived.' : 'Category restored.', 'success');
    }

    if (scope === 'package') {
      const { data, error } = await supabase
        .from('package')
        .update({ is_active: isActive })
        .eq('package_id', id)
        .select()
        .single();
      if (error) throw error;
      const idx = allPackages.findIndex(p => p.package_id === id);
      if (idx !== -1) allPackages[idx] = data;
      await logAudit({
        action:   type === 'archive' ? 'Archived Package' : 'Restored Package',
        category: 'package',
        details:  `Package ${type === 'archive' ? 'archived' : 'restored'}: ${data.package_name} (Category: ${activeCategoryName})`,
        entityId: id
      });
      pkgShowingArchived = !isActive;
      applyPkgArchiveToggle();
      renderPackageTables();
      setMessage(pkgPageMessage, type === 'archive' ? 'Package archived.' : 'Package restored.', 'success');
    }

    if (scope === 'tier') {
      const { data, error } = await supabase
        .from(TIER_TABLE)
        .update({ is_active: isActive })
        .eq('tier_id', id)
        .select()
        .single();
      if (error) throw error;
      const idx = allTiers.findIndex(t => t.tier_id === id);
      if (idx !== -1) allTiers[idx] = data;
      await logAudit({
        action:   type === 'archive' ? 'Archived Tier' : 'Restored Tier',
        category: 'package',
        details:  `Tier ${type === 'archive' ? 'archived' : 'restored'}: ${data.tier_name} (Package: ${tierForPackageName})`,
        entityId: id
      });
      renderTierTable();
    }

    closeModal(confirmModal);
  } catch (err) {
    setModalMsg(confirmMessage, `Failed: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
    pendingAction = null;
  }
});

confirmClose.addEventListener('click',  () => closeModal(confirmModal));
confirmCancel.addEventListener('click', () => closeModal(confirmModal));
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE TIER
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// PACKAGE TIER
// ═══════════════════════════════════════════════════════════════════════════════
function createTierPanel() {
  if (tierPanelEl) return;
  tierPanelEl = document.createElement('div');
  tierPanelEl.className = 'card';
  tierPanelEl.id = 'tierPanel';
  tierPanelEl.style.display = 'none';
  tierPanelEl.innerHTML = `
    <div class="tier-panel-head">
      <div>
        <h2 class="section-title" id="tierPanelTitle">Tiers</h2>
        <p class="section-sub" id="tierPanelSub">Manage tiers for this package</p>
      </div>
      <div class="tier-panel-actions">
        <button type="button" class="btn-primary" id="addTierBtn" style="font-size:13px;padding:8px 14px;">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Tier
        </button>
        <button type="button" class="btn-cancel" id="closeTierPanelBtn" style="font-size:13px;padding:8px 14px;">Close</button>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:16px;">
      <table class="pkg-table">
        <thead>
          <tr>
            <th>Tier</th>
            <th>Subtitle</th>
            <th>Order</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="tierTableBody">
          <tr class="empty-row"><td colspan="5">No tiers yet.</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const activePkg = document.getElementById('activePkgSection');
  activePkg.parentNode.insertBefore(tierPanelEl, activePkg.nextSibling);

  document.getElementById('addTierBtn').addEventListener('click', openAddTierModal);
  document.getElementById('closeTierPanelBtn').addEventListener('click', closeTierPanel);
  document.getElementById('tierTableBody').addEventListener('click', handleTierTableAction);
}

function closeTierPanel() {
  if (tierPanelEl) tierPanelEl.style.display = 'none';
  tierForPackageId = null;
  tierForPackageName = '';
}

async function openTierPanel(packageId, packageName) {
  createTierPanel();
  tierForPackageId   = packageId;
  tierForPackageName = packageName;

  document.getElementById('tierPanelTitle').textContent = `Tiers — ${packageName}`;
  document.getElementById('tierPanelSub').textContent   = 'Manage Bronze, Silver, Gold tiers';

  tierPanelEl.style.display = '';
  tierPanelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  await loadTiers(packageId);
}

async function loadTiers(packageId) {
  const tbody = document.getElementById('tierTableBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading tiers...</td></tr>';

  try {
    const { data, error } = await supabase
      .from(TIER_TABLE)
      .select('*')
      .eq('package_id', packageId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    allTiers = data || [];
    renderTierTable();
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Failed to load tiers: ${err.message}</td></tr>`;
  }
}

function renderTierTable() {
  const tbody = document.getElementById('tierTableBody');
  if (allTiers.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No tiers yet. Click "Add Tier" to create one.</td></tr>';
    return;
  }

  tbody.innerHTML = allTiers.map(tier => {
    const isArchived = !tier.is_active;
    const actions = isArchived
      ? `<div class="action-cell">
          <button class="action-btn edit" data-tier-action="edit" data-id="${tier.tier_id}">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="action-btn restore" data-tier-action="restore" data-id="${tier.tier_id}" data-name="${escapeHtml(tier.tier_name)}">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Restore
          </button>
        </div>`
      : `<div class="action-cell">
          <button class="action-btn edit" data-tier-action="edit" data-id="${tier.tier_id}">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit
          </button>
          <button class="action-btn archive" data-tier-action="archive" data-id="${tier.tier_id}" data-name="${escapeHtml(tier.tier_name)}">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            Archive
          </button>
        </div>`;

    return `<tr>
      <td><span class="tier-name-text">${escapeHtml(tier.tier_name)}</span></td>
      <td>${escapeHtml(tier.tier_subtitle || '—')}</td>
      <td>${tier.sort_order}</td>
      <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}

function handleTierTableAction(e) {
  const btn = e.target.closest('[data-tier-action]');
  if (!btn) return;
  const { tierAction, id, name } = btn.dataset;
  if (tierAction === 'edit')    openEditTierModal(id);
  if (tierAction === 'archive') openConfirmTierArchive(id, name);
  if (tierAction === 'restore') openConfirmTierRestore(id, name);
}

// ─── Tier Modal: Add / Edit ───────────────────────────────────────────────────
function clearTierForm() {
  tierNameInput.value      = '';
  tierSubtitle.value       = '';
  tierFullInclusions.value = '';
  tierSortOrder.value      = '0';
}

function openAddTierModal() {
  editingTierId = null;
  tierModalTitle.textContent     = 'Add Tier';
  tierModalSub.textContent       = `Add a tier to "${tierForPackageName}"`;
  tierModalSaveLabel.textContent = 'Add Tier';
  clearTierForm();
  setModalMsg(tierModalMessage, '');
  openModal(tierModal);
}

function openEditTierModal(tierId) {
  const tier = allTiers.find(t => t.tier_id === tierId);
  if (!tier) return;

  editingTierId = tierId;
  tierModalTitle.textContent     = 'Edit Tier';
  tierModalSub.textContent       = `Edit "${tier.tier_name}" tier`;
  tierModalSaveLabel.textContent = 'Save Changes';

  tierNameInput.value      = tier.tier_name || '';
  tierSubtitle.value       = tier.tier_subtitle || '';
  tierFullInclusions.value = tier.tier_full_inclusions || '';
  tierSortOrder.value      = tier.sort_order ?? 0;

  setModalMsg(tierModalMessage, '');
  openModal(tierModal);
}

tierModalSave.addEventListener('click', async () => {
  const name = tierNameInput.value.trim();
  if (!name) { setModalMsg(tierModalMessage, 'Tier name is required.'); return; }

  tierModalSave.disabled = true;
  tierModalSaveLabel.textContent = 'Saving…';
  setModalMsg(tierModalMessage, '');

  try {
    const payload = {
      tier_name:           name,
      tier_subtitle:       tierSubtitle.value.trim() || null,
      tier_full_inclusions: normalizeTierInclusions(tierFullInclusions.value) || null,
      sort_order:          parseInt(tierSortOrder.value, 10) || 0,
      package_id:          tierForPackageId,
    };

    if (editingTierId) {
      const { data, error } = await supabase
        .from(TIER_TABLE)
        .update(payload)
        .eq('tier_id', editingTierId)
        .select()
        .single();
      if (error) throw error;
      const idx = allTiers.findIndex(t => t.tier_id === editingTierId);
      if (idx !== -1) allTiers[idx] = data;
      await logAudit({
        action:   'Updated Tier',
        category: 'package',
        details:  `Tier updated: ${name} (Package: ${tierForPackageName})`,
        entityId: editingTierId
      });
    } else {
      payload.is_active = true;
      const { data, error } = await supabase
        .from(TIER_TABLE)
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      allTiers.push(data);
      await logAudit({
        action:   'Added Tier',
        category: 'package',
        details:  `New tier created: ${name} (Package: ${tierForPackageName})`,
        entityId: data.tier_id
      });
    }

    allTiers.sort((a, b) => a.sort_order - b.sort_order);
    renderTierTable();
    closeModal(tierModal);
  } catch (err) {
    setModalMsg(tierModalMessage, `Failed to save: ${err.message}`);
  } finally {
    tierModalSave.disabled = false;
    tierModalSaveLabel.textContent = editingTierId ? 'Save Changes' : 'Add Tier';
  }
});

// ─── Tier Archive / Restore ───────────────────────────────────────────────────
function openConfirmTierArchive(tierId, tierNameText) {
  pendingAction = { scope: 'tier', type: 'archive', id: tierId };
  confirmTitle.textContent = 'Archive Tier';
  confirmCopy.textContent  = `Are you sure you want to archive the "${tierNameText}" tier?`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

function openConfirmTierRestore(tierId, tierNameText) {
  pendingAction = { scope: 'tier', type: 'restore', id: tierId };
  confirmTitle.textContent = 'Restore Tier';
  confirmCopy.textContent  = `Restore the "${tierNameText}" tier?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ─── Tier Modal close handlers ────────────────────────────────────────────────
tierModalClose.addEventListener('click',  () => closeModal(tierModal));
tierModalCancel.addEventListener('click', () => closeModal(tierModal));
tierModal.addEventListener('click', e => { if (e.target === tierModal) closeModal(tierModal); });


// ═══════════════════════════════════════════════════════════════════════════════
// KEYBOARD: Escape closes modals
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!categoryModal.classList.contains('hidden')) closeModal(categoryModal);
  if (!packageModal.classList.contains('hidden'))  closeModal(packageModal);
  if (!tierModal.classList.contains('hidden'))      closeModal(tierModal);
  if (!confirmModal.classList.contains('hidden'))   closeModal(confirmModal);
});

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
function init() {
  wireLogoutButton('logoutBtn');
  watchAuthState();
  validateAdminSession({
    onSuccess: ({ profile }) => {
      setupInactivityLogout(profile.role);
      initAdminSidebarBadges(supabase);

      // Set admin badge
      const adminBadge = document.getElementById('adminBadge');
      if (adminBadge) adminBadge.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';

      // Start on category view
      showCategoryView();
      applyCatArchiveToggle();
      loadCategories();
    }
  });
}

init();