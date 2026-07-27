// admin_business_profile.js — Business Profile (locations, contact & social)
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';

// ── STATE ────────────────────────────────────────────────────────
let locations = [];
let contact   = null;
let editingLocationId = null;
let pendingConfirmAction = null;

// ── DOM refs ─────────────────────────────────────────────────────
const locationList = document.getElementById('locationList');
const locationMsg  = document.getElementById('locationMsg');
const contactMsg   = document.getElementById('contactMsg');

const fieldBrandDesc = document.getElementById('fieldBrandDesc');
const fieldPhone     = document.getElementById('fieldPhone');
const fieldEmail     = document.getElementById('fieldEmail');
const fieldFacebook  = document.getElementById('fieldFacebook');
const fieldInstagram = document.getElementById('fieldInstagram');

const locationModal        = document.getElementById('locationModal');
const locationModalTitle   = document.getElementById('locationModalTitle');
const locationModalMessage = document.getElementById('locationModalMessage');
const locationTagInput     = document.getElementById('locationTagInput');
const locationNameInput    = document.getElementById('locationNameInput');
const locationAddressInput = document.getElementById('locationAddressInput');
const locationHoursInput   = document.getElementById('locationHoursInput');
const locationModalSave    = document.getElementById('locationModalSave');
const locationModalSaveLabel = document.getElementById('locationModalSaveLabel');

const confirmModal   = document.getElementById('confirmModal');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmCopy    = document.getElementById('confirmCopy');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOk      = document.getElementById('confirmOk');

// ── UTILITIES ────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function setMsg(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'form-message' + (type ? ` ${type}` : '');
}
function setModalMsg(el, msg, type = 'error') {
  if (!msg) { el.className = 'modal-message hidden'; el.textContent = ''; return; }
  el.textContent = msg;
  el.className = `modal-message ${type}`;
}
function openModal(modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; }
function closeModal(modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }

// ── LOAD ─────────────────────────────────────────────────────────
async function loadAll() {
  const [{ data: locRows }, { data: contactRow }] = await Promise.all([
    supabase.from('business_location').select('*').order('sort_order', { ascending: true }),
    supabase.from('business_contact').select('*').eq('id', true).maybeSingle()
  ]);

  locations = locRows || [];
  contact = contactRow || null;

  renderLocations();

  if (contact) {
    fieldBrandDesc.value = contact.brand_description || '';
    fieldPhone.value = contact.phone || '';
    fieldEmail.value = contact.email || '';
    fieldFacebook.value = contact.facebook_url || '';
    fieldInstagram.value = contact.instagram_url || '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderLocations() {
  if (!locations.length) {
    locationList.innerHTML = '<p class="location-empty">No locations yet. Add your first branch.</p>';
    return;
  }
  locationList.innerHTML = locations.map((loc, i) => `
    <div class="location-admin-row ${loc.is_active ? '' : 'is-inactive'}" data-id="${loc.id}">
      <div class="location-admin-reorder">
        <button type="button" class="btn-icon-xs" data-move-location="up" data-id="${loc.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(loc.name)} up">↑</button>
        <button type="button" class="btn-icon-xs" data-move-location="down" data-id="${loc.id}" ${i === locations.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(loc.name)} down">↓</button>
      </div>
      <div class="location-admin-body">
        ${loc.branch_tag ? `<span class="location-admin-tag">${escapeHtml(loc.branch_tag)}</span>` : ''}
        <div class="location-admin-name">${escapeHtml(loc.name)}</div>
        <div class="location-admin-address">${escapeHtml(loc.address)}</div>
        ${loc.hours_label ? `<div class="location-admin-hours">${escapeHtml(loc.hours_label)}</div>` : ''}
      </div>
      <div class="location-admin-actions">
        <button type="button" class="btn-icon-xs" data-toggle-location="${loc.id}" aria-label="${loc.is_active ? 'Deactivate' : 'Activate'} ${escapeHtml(loc.name)}">${loc.is_active ? '●' : '○'}</button>
        <button type="button" class="btn-outline-sm" data-edit-location="${loc.id}">Edit</button>
        <button type="button" class="btn-icon-xs" data-remove-location="${loc.id}" aria-label="Remove ${escapeHtml(loc.name)}">✕</button>
      </div>
    </div>`).join('');
}

locationList.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-location]');
  if (moveBtn) { moveLocation(moveBtn.dataset.id, moveBtn.dataset.moveLocation); return; }
  const toggleBtn = e.target.closest('[data-toggle-location]');
  if (toggleBtn) { toggleLocationActive(toggleBtn.dataset.toggleLocation); return; }
  const editBtn = e.target.closest('[data-edit-location]');
  if (editBtn) { openLocationModal(editBtn.dataset.editLocation); return; }
  const removeBtn = e.target.closest('[data-remove-location]');
  if (removeBtn) { openConfirmRemoveLocation(removeBtn.dataset.removeLocation); return; }
});

document.getElementById('addLocationBtn').addEventListener('click', () => openLocationModal(null));

function openLocationModal(id) {
  editingLocationId = id;
  const loc = id ? locations.find(l => l.id === id) : null;
  locationModalTitle.textContent = loc ? 'Edit Location' : 'Add Location';
  locationModalSaveLabel.textContent = loc ? 'Save Changes' : 'Add Location';
  locationTagInput.value = loc?.branch_tag || '';
  locationNameInput.value = loc?.name || '';
  locationAddressInput.value = loc?.address || '';
  locationHoursInput.value = loc?.hours_label || '';
  setModalMsg(locationModalMessage, '');
  openModal(locationModal);
}

locationModalSave.addEventListener('click', async () => {
  const name = locationNameInput.value.trim();
  const address = locationAddressInput.value.trim();
  if (!name || !address) { setModalMsg(locationModalMessage, 'Name and address are both required.'); return; }

  locationModalSave.disabled = true;
  try {
    const payload = {
      branch_tag: locationTagInput.value.trim() || null,
      name,
      address,
      hours_label: locationHoursInput.value.trim() || null,
      updated_at: new Date().toISOString()
    };

    if (editingLocationId) {
      const { error } = await supabase.from('business_location').update(payload).eq('id', editingLocationId);
      if (error) throw error;
      Object.assign(locations.find(l => l.id === editingLocationId), payload);
      await logAudit({ action: 'Updated Location', category: 'business_profile', details: `Updated: ${name}`, entityId: editingLocationId });
    } else {
      const nextSort = locations.length ? Math.max(...locations.map(l => l.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('business_location').insert({ ...payload, sort_order: nextSort }).select().single();
      if (error) throw error;
      locations.push(data);
      await logAudit({ action: 'Added Location', category: 'business_profile', details: `Added: ${name}`, entityId: data.id });
    }
    renderLocations();
    closeModal(locationModal);
  } catch (err) {
    setModalMsg(locationModalMessage, `Failed to save: ${err.message}`);
  } finally {
    locationModalSave.disabled = false;
  }
});

document.getElementById('locationModalClose').addEventListener('click', () => closeModal(locationModal));
document.getElementById('locationModalCancel').addEventListener('click', () => closeModal(locationModal));
locationModal.addEventListener('click', e => { if (e.target === locationModal) closeModal(locationModal); });

async function toggleLocationActive(id) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  const nextActive = !loc.is_active;
  const { error } = await supabase.from('business_location').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(locationMsg, `Failed: ${error.message}`, 'error'); return; }
  loc.is_active = nextActive;
  renderLocations();
}

async function moveLocation(id, direction) {
  const idx = locations.findIndex(l => l.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= locations.length) return;

  const a = locations[idx];
  const b = locations[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('business_location').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('business_location').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(locationMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  locations.sort((x, y) => x.sort_order - y.sort_order);
  renderLocations();
}

function openConfirmRemoveLocation(id) {
  const loc = locations.find(l => l.id === id);
  if (!loc) return;
  pendingConfirmAction = { type: 'remove-location', id };
  confirmTitle.textContent = 'Remove Location';
  confirmCopy.textContent = `Remove "${loc.name}"? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

confirmOk.addEventListener('click', async () => {
  if (!pendingConfirmAction) return;
  confirmOk.disabled = true;
  try {
    if (pendingConfirmAction.type === 'remove-location') {
      const loc = locations.find(l => l.id === pendingConfirmAction.id);
      const { error } = await supabase.from('business_location').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      locations = locations.filter(l => l.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed Location', category: 'business_profile', details: `Removed: ${loc?.name}`, entityId: pendingConfirmAction.id });
      renderLocations();
    }
    closeModal(confirmModal);
  } catch (err) {
    setModalMsg(confirmMessage, `Failed: ${err.message}`);
  } finally {
    confirmOk.disabled = false;
    pendingConfirmAction = null;
  }
});
document.getElementById('confirmClose').addEventListener('click', () => closeModal(confirmModal));
document.getElementById('confirmCancel').addEventListener('click', () => closeModal(confirmModal));
confirmModal.addEventListener('click', e => { if (e.target === confirmModal) closeModal(confirmModal); });

// ═══════════════════════════════════════════════════════════════════════════
// CONTACT & SOCIAL
// ═══════════════════════════════════════════════════════════════════════════
document.getElementById('saveContactBtn').addEventListener('click', async () => {
  setMsg(contactMsg, 'Saving…');
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      id: true,
      brand_description: fieldBrandDesc.value.trim() || null,
      phone: fieldPhone.value.trim() || null,
      email: fieldEmail.value.trim() || null,
      facebook_url: fieldFacebook.value.trim() || null,
      instagram_url: fieldInstagram.value.trim() || null,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null
    };
    const { error } = await supabase.from('business_contact').upsert(payload, { onConflict: 'id' });
    if (error) throw error;
    contact = { ...contact, ...payload };
    await logAudit({ action: 'Updated Business Contact', category: 'business_profile', details: 'Updated contact & social info' });
    setMsg(contactMsg, 'Saved successfully.', 'success');
  } catch (err) {
    setMsg(contactMsg, `Failed to save: ${err.message}`, 'error');
  }
});

// ── KEYBOARD: Escape closes modals ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  [locationModal, confirmModal].forEach(m => { if (!m.classList.contains('hidden')) closeModal(m); });
});

// ── SESSION ──────────────────────────────────────────────────────
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

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });
  loadAll();
}

init();
