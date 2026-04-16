// super_admin_packages.js
// Connects to Supabase for real data; falls back to demo data if not configured.
// Import your supabase client and session_validation when integrating into your project.

// ─── Imports (uncomment when integrating) ────────────────────────────────────
// import { portalSupabase as supabase } from './supabase.js';
// import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
// import { setupInactivityLogout } from './super_admin_inactivity.js';

// ─── Demo data (remove when integrating with Supabase) ───────────────────────
const DEMO_PACKAGES = [
  {
    package_id: 'PKG-001',
    package_name: 'VIP Plus',
    category: 'Mini Gathering',
    price: 3999,
    capacity: '15-20 pax',
    duration: '3 hours',
    status: 'active',
    description: 'Exclusive VIP lounge experience for intimate gatherings.',
    inclusions: 'VIP Room, Coffee Bar, Pastries, Free WiFi, Sound System',
    additional_details: 'Extension: ₱800/hour.',
    image_url: null,
    created_at: new Date().toISOString()
  },
  {
    package_id: 'PKG-002',
    package_name: 'Coffee Bar 100 pax',
    category: 'Coffee Bar',
    price: 10990,
    capacity: '80-100 pax',
    duration: '4 hours',
    status: 'active',
    description: 'Full coffee bar setup for large events.',
    inclusions: 'Full Coffee Bar Setup, 2 Baristas, Cups & Stirrers, Sweeteners',
    additional_details: 'Extension: ₱1,200/hour.',
    image_url: null,
    created_at: new Date().toISOString()
  },
  {
    package_id: 'PKG-003',
    package_name: 'Main Hall Basic',
    category: 'Mini Gathering',
    price: 4999,
    capacity: '20-30 pax',
    duration: '3 hours',
    status: 'active',
    description: 'Simple yet elegant main hall setup.',
    inclusions: 'Main Hall, Basic Decor, Coffee Station, Tables & Chairs',
    additional_details: '',
    image_url: null,
    created_at: new Date().toISOString()
  },
  {
    package_id: 'PKG-004',
    package_name: 'Workshop Package',
    category: 'Workshop',
    price: 5500,
    capacity: '25-35 pax',
    duration: '4 hours',
    status: 'active',
    description: 'Complete workshop setup with all necessary equipment.',
    inclusions: 'Projector, Whiteboard, Coffee Breaks, Notepads, Pens',
    additional_details: 'Includes complimentary event coordination.',
    image_url: null,
    created_at: new Date().toISOString()
  },
  {
    package_id: 'PKG-005',
    package_name: 'Premium Event Package',
    category: 'Birthday Party',
    price: 8999,
    capacity: '30-50 pax',
    duration: '5 hours',
    status: 'archived',
    description: 'Premium birthday party setup with full decorations.',
    inclusions: 'Full Decor, Birthday Cake Table, Photo Booth, Coffee Bar, Sound System',
    additional_details: 'No longer offered.',
    image_url: null,
    created_at: new Date().toISOString()
  }
];

// ─── State ────────────────────────────────────────────────────────────────────
let allPackages = [...DEMO_PACKAGES];
let showingArchived = false;
let editingPackageId = null;
let pendingAction = null; // { type: 'archive'|'restore', packageId }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const searchInput       = document.getElementById('searchInput');
const categoryFilter    = document.getElementById('categoryFilter');
const toggleArchiveBtn  = document.getElementById('toggleArchiveBtn');
const toggleArchiveLabel= document.getElementById('toggleArchiveLabel');
const activeSection     = document.getElementById('activeSection');
const archivedSection   = document.getElementById('archivedSection');
const activeBody        = document.getElementById('activeBody');
const archivedBody      = document.getElementById('archivedBody');
const statActive        = document.getElementById('statActive');
const statArchived      = document.getElementById('statArchived');
const statTotal         = document.getElementById('statTotal');
const pageMessage       = document.getElementById('pageMessage');

// Modal refs
const packageModal      = document.getElementById('packageModal');
const modalTitle        = document.getElementById('modalTitle');
const modalSub          = packageModal.querySelector('.modal-sub');
const modalSaveLabel    = document.getElementById('modalSaveLabel');
const modalClose        = document.getElementById('modalClose');
const modalCancel       = document.getElementById('modalCancel');
const modalSave         = document.getElementById('modalSave');
const modalMessage      = document.getElementById('modalMessage');
const addPackageBtn     = document.getElementById('addPackageBtn');

// Form fields
const imageInput        = document.getElementById('imageInput');
const imagePreview      = document.getElementById('imagePreview');
const imagePlaceholder  = document.getElementById('imagePlaceholder');
const fileName          = document.getElementById('fileName');
const pkgName           = document.getElementById('pkgName');
const pkgCategory       = document.getElementById('pkgCategory');
const pkgDescription    = document.getElementById('pkgDescription');
const pkgPrice          = document.getElementById('pkgPrice');
const pkgCapacity       = document.getElementById('pkgCapacity');
const pkgDuration       = document.getElementById('pkgDuration');
const pkgInclusions     = document.getElementById('pkgInclusions');
const pkgAdditional     = document.getElementById('pkgAdditional');

// Confirm modal
const confirmModal      = document.getElementById('confirmModal');
const confirmTitle      = document.getElementById('confirmTitle');
const confirmCopy       = document.getElementById('confirmCopy');
const confirmClose      = document.getElementById('confirmClose');
const confirmCancel     = document.getElementById('confirmCancel');
const confirmOk         = document.getElementById('confirmOk');
const confirmMessage    = document.getElementById('confirmMessage');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[m]));
}

function formatCurrency(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

function setPageMessage(msg, type = '') {
  pageMessage.textContent = msg;
  pageMessage.className = 'page-message' + (type ? ` ${type}` : '');
}

function setModalMessage(msg, type = 'error') {
  if (!msg) {
    modalMessage.className = 'modal-message hidden';
    modalMessage.textContent = '';
    return;
  }
  modalMessage.textContent = msg;
  modalMessage.className = `modal-message ${type}`;
}

function setConfirmMessage(msg, type = 'error') {
  if (!msg) {
    confirmMessage.className = 'modal-message hidden';
    confirmMessage.textContent = '';
    return;
  }
  confirmMessage.textContent = msg;
  confirmMessage.className = `modal-message ${type}`;
}

function generatePackageId() {
  const maxNum = allPackages.reduce((max, pkg) => {
    const match = String(pkg.package_id || '').match(/PKG-(\d+)/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  return `PKG-${String(maxNum + 1).padStart(3, '0')}`;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const active   = allPackages.filter(p => p.status === 'active').length;
  const archived = allPackages.filter(p => p.status === 'archived').length;
  statActive.textContent   = active;
  statArchived.textContent = archived;
  statTotal.textContent    = allPackages.length;
}

// ─── Render helpers ───────────────────────────────────────────────────────────
function buildThumb(pkg) {
  if (pkg.image_url) {
    return `<div class="pkg-thumb"><img src="${escapeHtml(pkg.image_url)}" alt="${escapeHtml(pkg.package_name)}"></div>`;
  }
  return `<div class="pkg-thumb">
    <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
  </div>`;
}

function buildRow(pkg) {
  const isArchived = pkg.status === 'archived';
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
          <div class="pkg-id">${escapeHtml(pkg.package_id)}</div>
        </div>
      </div>
    </td>
    <td><span class="category-pill">${escapeHtml(pkg.category || '—')}</span></td>
    <td>${escapeHtml(formatCurrency(pkg.price))}</td>
    <td>${escapeHtml(pkg.capacity || '—')}</td>
    <td>${escapeHtml(pkg.duration || '—')}</td>
    <td><span class="status-pill ${isArchived ? 'archived' : 'active'}">${isArchived ? 'Archived' : 'Active'}</span></td>
    <td>${actions}</td>
  </tr>`;
}

function getFilteredPackages(status) {
  const term     = (searchInput.value || '').trim().toLowerCase();
  const category = categoryFilter.value;

  return allPackages.filter(pkg => {
    if (pkg.status !== status) return false;
    if (category && pkg.category !== category) return false;
    if (term) {
      const haystack = `${pkg.package_name} ${pkg.category} ${pkg.description}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

function renderTables() {
  const active   = getFilteredPackages('active');
  const archived = getFilteredPackages('archived');

  activeBody.innerHTML = active.length
    ? active.map(buildRow).join('')
    : '<tr class="empty-row"><td colspan="7">No active packages found.</td></tr>';

  archivedBody.innerHTML = archived.length
    ? archived.map(buildRow).join('')
    : '<tr class="empty-row"><td colspan="7">No archived packages found.</td></tr>';

  updateStats();
}

// ─── Show/hide archived section ───────────────────────────────────────────────
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

toggleArchiveBtn.addEventListener('click', () => {
  showingArchived = !showingArchived;
  applyArchiveToggle();
});

// ─── Filters ──────────────────────────────────────────────────────────────────
searchInput.addEventListener('input', renderTables);
categoryFilter.addEventListener('change', renderTables);

// ─── Table action delegation ──────────────────────────────────────────────────
function handleTableAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id     = btn.dataset.id;

  if (action === 'edit')    openEditModal(id);
  if (action === 'archive') openConfirmArchive(id);
  if (action === 'restore') openConfirmRestore(id);
}

activeBody.addEventListener('click', handleTableAction);
archivedBody.addEventListener('click', handleTableAction);

// ─── Add Package Modal ────────────────────────────────────────────────────────
function openAddModal() {
  editingPackageId = null;
  modalTitle.textContent      = 'Add New Package';
  modalSub.textContent        = 'Create a new event package with details, pricing, and image';
  modalSaveLabel.textContent  = 'Add Package';
  clearModalForm();
  setModalMessage('');
  openModal(packageModal);
}

function openEditModal(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;

  editingPackageId = packageId;
  modalTitle.textContent      = 'Edit Package';
  modalSub.textContent        = 'Update the package details below';
  modalSaveLabel.textContent  = 'Save Changes';

  pkgName.value        = pkg.package_name || '';
  pkgCategory.value    = pkg.category || '';
  pkgDescription.value = pkg.description || '';
  pkgPrice.value       = pkg.price || '';
  pkgCapacity.value    = pkg.capacity || '';
  pkgDuration.value    = pkg.duration || '';
  pkgInclusions.value  = pkg.inclusions || '';
  pkgAdditional.value  = pkg.additional_details || '';

  if (pkg.image_url) {
    imagePreview.src = pkg.image_url;
    imagePreview.classList.remove('hidden');
    imagePlaceholder.style.display = 'none';
    fileName.textContent = 'Image loaded';
  } else {
    clearImagePreview();
  }

  setModalMessage('');
  openModal(packageModal);
}

function clearModalForm() {
  pkgName.value        = '';
  pkgCategory.value    = '';
  pkgDescription.value = '';
  pkgPrice.value       = '';
  pkgCapacity.value    = '';
  pkgDuration.value    = '';
  pkgInclusions.value  = '';
  pkgAdditional.value  = '';
  imageInput.value     = '';
  clearImagePreview();
}

function clearImagePreview() {
  imagePreview.src = '';
  imagePreview.classList.add('hidden');
  imagePlaceholder.style.display = '';
  fileName.textContent = 'No file chosen';
}

function validatePackageForm() {
  if (!pkgName.value.trim())        return 'Package name is required.';
  if (!pkgCategory.value)           return 'Category is required.';
  if (!pkgDescription.value.trim()) return 'Description is required.';
  if (!pkgPrice.value || isNaN(Number(pkgPrice.value)) || Number(pkgPrice.value) < 0)
    return 'A valid price is required.';
  if (!pkgCapacity.value.trim())    return 'Guest capacity is required.';
  if (!pkgDuration.value.trim())    return 'Duration is required.';
  if (!pkgInclusions.value.trim())  return 'Inclusions are required.';
  return null;
}

modalSave.addEventListener('click', async () => {
  const validationError = validatePackageForm();
  if (validationError) {
    setModalMessage(validationError);
    return;
  }

  modalSave.disabled = true;
  setModalMessage('');

  try {
    // ── Build package data ──
    const packageData = {
      package_name:       pkgName.value.trim(),
      category:           pkgCategory.value,
      description:        pkgDescription.value.trim(),
      price:              Number(pkgPrice.value),
      capacity:           pkgCapacity.value.trim(),
      duration:           pkgDuration.value.trim(),
      inclusions:         pkgInclusions.value.trim(),
      additional_details: pkgAdditional.value.trim(),
      // image_url would be set after upload in real integration
    };

    if (editingPackageId) {
      // ── Edit existing ──
      // In real integration: await supabase.from('packages').update(packageData).eq('package_id', editingPackageId)
      const idx = allPackages.findIndex(p => p.package_id === editingPackageId);
      if (idx !== -1) {
        allPackages[idx] = { ...allPackages[idx], ...packageData };
      }
      setPageMessage('Package updated successfully.', 'success');
    } else {
      // ── Add new ──
      // In real integration: await supabase.from('packages').insert({ ...packageData, status: 'active' })
      const newPkg = {
        ...packageData,
        package_id: generatePackageId(),
        status: 'active',
        image_url: null,
        created_at: new Date().toISOString()
      };
      allPackages.unshift(newPkg);
      setPageMessage('Package added successfully.', 'success');
    }

    renderTables();
    closeModal(packageModal);
  } catch (err) {
    setModalMessage(`Failed to save package: ${err.message}`);
  } finally {
    modalSave.disabled = false;
  }
});

// ─── Image preview ────────────────────────────────────────────────────────────
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (!file) return;

  fileName.textContent = file.name;

  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreview.src = e.target.result;
    imagePreview.classList.remove('hidden');
    imagePlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(file);
});

// ─── Confirm: Archive ─────────────────────────────────────────────────────────
function openConfirmArchive(packageId) {
  const pkg = allPackages.find(p => p.package_id === packageId);
  if (!pkg) return;
  pendingAction = { type: 'archive', packageId };
  confirmTitle.textContent = 'Archive Package';
  confirmCopy.textContent  = `Are you sure you want to archive "${pkg.package_name}"? It will no longer be visible to customers.`;
  confirmOk.textContent    = 'Archive';
  confirmOk.className      = 'btn-danger';
  setConfirmMessage('');
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
  setConfirmMessage('');
  openModal(confirmModal);
}

confirmOk.addEventListener('click', async () => {
  if (!pendingAction) return;
  const { type, packageId } = pendingAction;
  confirmOk.disabled = true;

  try {
    const newStatus = type === 'archive' ? 'archived' : 'active';
    // In real integration: await supabase.from('packages').update({ status: newStatus }).eq('package_id', packageId)
    const idx = allPackages.findIndex(p => p.package_id === packageId);
    if (idx !== -1) allPackages[idx].status = newStatus;

    if (type === 'archive') {
      showingArchived = true;
      applyArchiveToggle();
      setPageMessage('Package archived.', 'success');
    } else {
      showingArchived = false;
      applyArchiveToggle();
      setPageMessage('Package restored.', 'success');
    }

    renderTables();
    closeModal(confirmModal);
  } catch (err) {
    setConfirmMessage(`Failed: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
    pendingAction = null;
  }
});

// ─── Modal helpers ────────────────────────────────────────────────────────────
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

addPackageBtn.addEventListener('click', openAddModal);
modalClose.addEventListener('click',  () => closeModal(packageModal));
modalCancel.addEventListener('click', () => closeModal(packageModal));
confirmClose.addEventListener('click',  () => closeModal(confirmModal));
confirmCancel.addEventListener('click', () => closeModal(confirmModal));

// Close on overlay click
packageModal.addEventListener('click', e => { if (e.target === packageModal) closeModal(packageModal); });
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!packageModal.classList.contains('hidden')) closeModal(packageModal);
  if (!confirmModal.classList.contains('hidden'))  closeModal(confirmModal);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  // ── Auth (uncomment when integrating) ──
  // wireLogoutButton('logoutBtn');
  // watchAuthState();
  // validateAdminSession({
  //   onSuccess: ({ session, profile }) => {
  //     setupInactivityLogout(profile.role);
  //     loadPackagesFromSupabase();
  //   }
  // });

  applyArchiveToggle();
  renderTables();
}

// ─── Supabase integration stub ────────────────────────────────────────────────
// Replace allPackages with real data when connecting.
// async function loadPackagesFromSupabase() {
//   try {
//     const { data, error } = await supabase
//       .from('packages')
//       .select('*')
//       .order('created_at', { ascending: false });
//     if (error) throw error;
//     allPackages = data || [];
//     renderTables();
//   } catch (err) {
//     setPageMessage(`Failed to load packages: ${err.message}`, 'error');
//   }
// }

init();
