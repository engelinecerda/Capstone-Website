// super_admin_packages.js
// Full Supabase + Cloudinary integration.
// Table: public.package  |  Image host: Cloudinary

import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

// ─── Cloudinary config ────────────────────────────────────────────────────────
const CLOUDINARY_UPLOAD_URL    = 'https://api.cloudinary.com/v1_1/dgneg418t/image/upload';
const CLOUDINARY_UPLOAD_PRESET = 'eli_coffee_packages'; // ← your unsigned preset name in Cloudinary settings

// ─── State ────────────────────────────────────────────────────────────────────
let allPackages      = [];
let showingArchived  = false;
let editingPackageId = null;   // uuid | null
let pendingAction    = null;   // { type: 'archive'|'restore', packageId }
let pendingImageFile = null;   // File | null — held until save is clicked

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const searchInput        = document.getElementById('searchInput');
const categoryFilter     = document.getElementById('categoryFilter');
const toggleArchiveBtn   = document.getElementById('toggleArchiveBtn');
const toggleArchiveLabel = document.getElementById('toggleArchiveLabel');
const activeSection      = document.getElementById('activeSection');
const archivedSection    = document.getElementById('archivedSection');
const activeBody         = document.getElementById('activeBody');
const archivedBody       = document.getElementById('archivedBody');
const statActive         = document.getElementById('statActive');
const statArchived       = document.getElementById('statArchived');
const statTotal          = document.getElementById('statTotal');
const pageMessage        = document.getElementById('pageMessage');

// Package modal
const packageModal   = document.getElementById('packageModal');
const modalTitle     = document.getElementById('modalTitle');
const modalSub       = packageModal.querySelector('.modal-sub');
const modalSaveLabel = document.getElementById('modalSaveLabel');
const modalClose     = document.getElementById('modalClose');
const modalCancel    = document.getElementById('modalCancel');
const modalSave      = document.getElementById('modalSave');
const modalMessage   = document.getElementById('modalMessage');
const addPackageBtn  = document.getElementById('addPackageBtn');

// Form fields — names match Supabase column names exactly
const imageInput        = document.getElementById('imageInput');
const imagePreview      = document.getElementById('imagePreview');
const imagePlaceholder  = document.getElementById('imagePlaceholder');
const fileName          = document.getElementById('fileName');
const pkgName           = document.getElementById('pkgName');          // package_name
const pkgCategory       = document.getElementById('pkgCategory');      // package_type
const pkgDescription    = document.getElementById('pkgDescription');   // description
const pkgPrice          = document.getElementById('pkgPrice');         // price
const pkgCapacity       = document.getElementById('pkgCapacity');      // guest_capacity (integer)
const pkgDuration       = document.getElementById('pkgDuration');      // duration_hours (integer)
const pkgExtensionPrice = document.getElementById('pkgExtensionPrice');// extension_price
const pkgLocationType   = document.getElementById('pkgLocationType');  // location_type

// Confirm modal
const confirmModal   = document.getElementById('confirmModal');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmCopy    = document.getElementById('confirmCopy');
const confirmClose   = document.getElementById('confirmClose');
const confirmCancel  = document.getElementById('confirmCancel');
const confirmOk      = document.getElementById('confirmOk');
const confirmMessage = document.getElementById('confirmMessage');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function formatCurrency(v)  { return `₱${Number(v || 0).toLocaleString()}`; }
function formatCapacity(v)  { return v ? `${v} pax` : '—'; }
function formatDuration(v)  { return v ? `${v} hr${v !== 1 ? 's' : ''}` : '—'; }

function setPageMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className = 'page-message' + (type ? ` ${type}` : '');
  if (type === 'success') setTimeout(() => setPageMessage(''), 4000);
}

function setModalMsg(msg, type = 'error') {
  if (!msg) { modalMessage.className = 'modal-message hidden'; modalMessage.textContent = ''; return; }
  modalMessage.textContent = msg;
  modalMessage.className = `modal-message ${type}`;
}

function setConfirmMsg(msg, type = 'error') {
  if (!msg) { confirmMessage.className = 'modal-message hidden'; confirmMessage.textContent = ''; return; }
  confirmMessage.textContent = msg;
  confirmMessage.className = `modal-message ${type}`;
}

function setSaving(on) {
  modalSave.disabled = on;
  modalSaveLabel.textContent = on ? 'Saving…' : (editingPackageId ? 'Save Changes' : 'Add Package');
}

// ─── Cloudinary upload ────────────────────────────────────────────────────────
async function uploadToCloudinary(file) {
  const form = new FormData();
  form.append('file', file);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  form.append('folder', 'eli_coffee_packages');

  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Image upload failed (HTTP ${res.status})`);
  }

  const data = await res.json();
  return data.secure_url; // https:// URL → stored in package_image column
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function loadPackagesFromSupabase() {
  setPageMessage('Loading packages…');
  try {
    const { data, error } = await supabase
      .from('package')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    allPackages = data || [];
    renderTables();
    setPageMessage('');
  } catch (err) {
    setPageMessage(`Failed to load packages: ${err.message}`, 'error');
    renderTables();
  }
}

async function insertPackage(payload) {
  const { data, error } = await supabase.from('package').insert(payload).select().single();
  if (error) throw error;
  return data;
}

async function updatePackage(id, payload) {
  const { data, error } = await supabase.from('package').update(payload).eq('package_id', id).select().single();
  if (error) throw error;
  return data;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const active   = allPackages.filter(p => p.is_active).length;
  const archived = allPackages.filter(p => !p.is_active).length;
  statActive.textContent   = active;
  statArchived.textContent = archived;
  statTotal.textContent    = allPackages.length;
}

// ─── Table rendering ──────────────────────────────────────────────────────────
function buildThumb(pkg) {
  if (pkg.package_image) {
    return `<div class="pkg-thumb"><img src="${escapeHtml(pkg.package_image)}" alt="${escapeHtml(pkg.package_name)}" loading="lazy"></div>`;
  }
  return `<div class="pkg-thumb">
    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  </div>`;
}

function buildRow(pkg) {
  const isArchived = !pkg.is_active;
  const actions = isArchived
    ? `<div class="action-cell">
        <button class="action-btn edit" data-action="edit" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn restore" data-action="restore" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Restore
        </button>
      </div>`
    : `<div class="action-cell">
        <button class="action-btn edit" data-action="edit" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
        <button class="action-btn archive" data-action="archive" data-id="${pkg.package_id}">
          <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
          Archive
        </button>
      </div>`;

  return `<tr>
    <td>
      <div class="pkg-cell">
        ${buildThumb(pkg)}
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

function getFiltered(isActive) {
  const term     = (searchInput.value || '').trim().toLowerCase();
  const category = categoryFilter.value;
  return allPackages.filter(pkg => {
    if (Boolean(pkg.is_active) !== isActive) return false;
    if (category && pkg.package_type !== category) return false;
    if (term) {
      const hay = `${pkg.package_name} ${pkg.package_type} ${pkg.description || ''}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

function renderTables() {
  const active   = getFiltered(true);
  const archived = getFiltered(false);
  activeBody.innerHTML   = active.length   ? active.map(buildRow).join('')   : '<tr class="empty-row"><td colspan="7">No active packages found.</td></tr>';
  archivedBody.innerHTML = archived.length ? archived.map(buildRow).join('') : '<tr class="empty-row"><td colspan="7">No archived packages found.</td></tr>';
  updateStats();
}

// ─── Archive toggle ───────────────────────────────────────────────────────────
function applyArchiveToggle() {
  if (showingArchived) {
    archivedSection.style.display = '';
    activeSection.style.display   = 'none';
    toggleArchiveLabel.textContent = 'Show Active';
    toggleArchiveBtn.classList.add('showing-active');
  } else {
    activeSection.style.display   = '';
    archivedSection.style.display = 'none';
    toggleArchiveLabel.textContent = 'Show Archived';
    toggleArchiveBtn.classList.remove('showing-active');
  }
}

toggleArchiveBtn.addEventListener('click', () => { showingArchived = !showingArchived; applyArchiveToggle(); });
searchInput.addEventListener('input', renderTables);
categoryFilter.addEventListener('change', renderTables);

// ─── Table action delegation ──────────────────────────────────────────────────
function handleTableAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'edit')    openEditModal(id);
  if (action === 'archive') openConfirmArchive(id);
  if (action === 'restore') openConfirmRestore(id);
}
activeBody.addEventListener('click', handleTableAction);
archivedBody.addEventListener('click', handleTableAction);

// ─── Add modal ────────────────────────────────────────────────────────────────
function openAddModal() {
  editingPackageId = null;
  pendingImageFile = null;
  modalTitle.textContent     = 'Add New Package';
  modalSub.textContent       = 'Create a new event package with details, pricing, and image';
  modalSaveLabel.textContent = 'Add Package';
  clearModalForm();
  setModalMsg('');
  openModal(packageModal);
}

// ─── Edit modal ───────────────────────────────────────────────────────────────
function openEditModal(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;

  editingPackageId = packageId;
  pendingImageFile = null;
  modalTitle.textContent     = 'Edit Package';
  modalSub.textContent       = 'Update the package details below';
  modalSaveLabel.textContent = 'Save Changes';

  pkgName.value           = pkg.package_name || '';
  pkgCategory.value       = pkg.package_type || '';
  pkgDescription.value    = pkg.description || '';
  pkgPrice.value          = pkg.price ?? '';
  pkgCapacity.value       = pkg.guest_capacity ?? '';
  pkgDuration.value       = pkg.duration_hours ?? '';
  pkgExtensionPrice.value = pkg.extension_price ?? '';
  pkgLocationType.value   = pkg.location_type || '';

  if (pkg.package_image) {
    imagePreview.src = pkg.package_image;
    imagePreview.classList.remove('hidden');
    imagePlaceholder.style.display = 'none';
    fileName.textContent = 'Current image loaded';
  } else {
    clearImagePreview();
  }

  setModalMsg('');
  openModal(packageModal);
}

function clearModalForm() {
  [pkgName, pkgDescription, pkgPrice, pkgCapacity, pkgDuration, pkgExtensionPrice].forEach(el => el.value = '');
  pkgCategory.value     = '';
  pkgLocationType.value = '';
  imageInput.value      = '';
  clearImagePreview();
}

function clearImagePreview() {
  imagePreview.src = '';
  imagePreview.classList.add('hidden');
  imagePlaceholder.style.display = '';
  fileName.textContent = 'No file chosen';
}

// ─── Image selection & preview ────────────────────────────────────────────────
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (!file) return;

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    setModalMsg('Only JPG, PNG, or WEBP images are allowed.');
    imageInput.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setModalMsg('Image must be under 5 MB.');
    imageInput.value = '';
    return;
  }

  pendingImageFile = file;
  fileName.textContent = file.name;
  setModalMsg('');

  const reader = new FileReader();
  reader.onload = e => {
    imagePreview.src = e.target.result;
    imagePreview.classList.remove('hidden');
    imagePlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
});

// ─── Validation ───────────────────────────────────────────────────────────────
function validateForm() {
  if (!pkgName.value.trim()) return 'Package name is required.';
  if (!pkgCategory.value)    return 'Package type is required.';
  if (pkgPrice.value === '' || isNaN(Number(pkgPrice.value)) || Number(pkgPrice.value) < 0)
    return 'A valid price is required.';
  if (pkgCapacity.value !== '' && isNaN(parseInt(pkgCapacity.value)))
    return 'A valid guest capacity is required.';
  if (!pkgDuration.value || isNaN(parseInt(pkgDuration.value)) || parseInt(pkgDuration.value) < 1)
    return 'A valid duration in hours is required (whole number).';
  return null;
}

// ─── Save ─────────────────────────────────────────────────────────────────────
modalSave.addEventListener('click', async () => {
  const err = validateForm();
  if (err) { setModalMsg(err); return; }

  setSaving(true);
  setModalMsg('');

  try {
    // Step 1: upload image to Cloudinary if a new file is pending
    let imageUrl = null;
    if (pendingImageFile) {
      setModalMsg('Uploading image…', 'success');
      imageUrl = await uploadToCloudinary(pendingImageFile);
      setModalMsg('');
    }

    // Step 2: build payload using exact column names from the schema
    const payload = {
      package_name:    pkgName.value.trim(),
      package_type:    pkgCategory.value,
      description:     pkgDescription.value.trim() || null,
      price:           Number(pkgPrice.value),
      guest_capacity:  parseInt(pkgCapacity.value, 10),
      duration_hours:  parseInt(pkgDuration.value, 10),
      extension_price: pkgExtensionPrice.value !== '' ? Number(pkgExtensionPrice.value) : null,
      location_type:   pkgLocationType.value || null,
    };

    // Only overwrite package_image if a new image was uploaded
    if (imageUrl) payload.package_image = imageUrl;

    if (editingPackageId) {
      const updated = await updatePackage(editingPackageId, payload);
      const idx = allPackages.findIndex(p => p.package_id === editingPackageId);
      if (idx !== -1) allPackages[idx] = updated;
      setPageMessage('Package updated successfully.', 'success');
    } else {
      payload.is_active = true;
      const created = await insertPackage(payload);
      allPackages.unshift(created);
      setPageMessage('Package added successfully.', 'success');
    }

    renderTables();
    closeModal(packageModal);

  } catch (err) {
    setModalMsg(`Failed to save: ${err.message}`);
  } finally {
    setSaving(false);
  }
});

// ─── Archive / Restore confirms ───────────────────────────────────────────────
function openConfirmArchive(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { type: 'archive', packageId };
  confirmTitle.textContent = 'Archive Package';
  confirmCopy.textContent  = `Are you sure you want to archive "${pkg.package_name}"? It will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setConfirmMsg('');
  openModal(confirmModal);
}

function openConfirmRestore(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { type: 'restore', packageId };
  confirmTitle.textContent = 'Restore Package';
  confirmCopy.textContent  = `Restore "${pkg.package_name}" and make it visible to customers again?`;
  confirmOk.textContent    = 'Restore';
  confirmOk.className      = 'btn-primary';
  setConfirmMsg('');
  openModal(confirmModal);
}

confirmOk.addEventListener('click', async () => {
  if (!pendingAction) return;
  const { type, packageId } = pendingAction;
  confirmOk.disabled = true;

  try {
    const isActive = type === 'restore';
    const updated  = await updatePackage(packageId, { is_active: isActive });
    const idx      = allPackages.findIndex(p => p.package_id === packageId);
    if (idx !== -1) allPackages[idx] = updated;

    showingArchived = !isActive;
    applyArchiveToggle();
    renderTables();
    closeModal(confirmModal);
    setPageMessage(type === 'archive' ? 'Package archived.' : 'Package restored.', 'success');
  } catch (err) {
    setConfirmMsg(`Failed: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
    pendingAction = null;
  }
});

// ─── Modal open / close ───────────────────────────────────────────────────────
function openModal(modal) {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(modal) {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  pendingImageFile = null;
}

addPackageBtn.addEventListener('click', openAddModal);
modalClose.addEventListener('click',    () => closeModal(packageModal));
modalCancel.addEventListener('click',   () => closeModal(packageModal));
confirmClose.addEventListener('click',  () => closeModal(confirmModal));
confirmCancel.addEventListener('click', () => closeModal(confirmModal));

packageModal.addEventListener('click', e => { if (e.target === packageModal) closeModal(packageModal); });
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!packageModal.classList.contains('hidden')) closeModal(packageModal);
  if (!confirmModal.classList.contains('hidden'))  closeModal(confirmModal);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  wireLogoutButton('logoutBtn');
  watchAuthState();
  validateAdminSession({
    onSuccess: ({ profile }) => {
      setupInactivityLogout(profile.role);
      initAdminSidebarBadges(supabase);
      loadPackagesFromSupabase();
    }
  });
  applyArchiveToggle();
}

init();