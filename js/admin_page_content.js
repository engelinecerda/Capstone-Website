// admin_page_content.js — Page Content (Maintenance Module)
// Manages page_header, gallery_image, about_section, faq — presentation
// config only, read by the customer pages via js/page_content.js.
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';
import { uploadToCloudinary, destroyCloudinaryImage, validateImageFile, resizeImageFile } from './image_upload.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

const PAGE_LABELS = { home: 'Home', packages: 'Packages', about: 'About', faqs: 'FAQs', menu: 'Menu' };

// Curated set only — mirrors the DB check constraint in
// 20260809_about_values.sql (about_value.icon). Never freeform text: a
// dropdown/grid restricted to this list is what keeps a bad icon name from
// silently rendering nothing on the customer page.
const VALUE_ICONS = [
  { id: 'ti-coffee',       label: 'Coffee' },
  { id: 'ti-heart',        label: 'Heart' },
  { id: 'ti-award',        label: 'Award' },
  { id: 'ti-users',        label: 'Users' },
  { id: 'ti-leaf',         label: 'Leaf' },
  { id: 'ti-sparkles',     label: 'Sparkles' },
  { id: 'ti-shield-check', label: 'Shield Check' },
  { id: 'ti-clock',        label: 'Clock' },
  { id: 'ti-circle-check', label: 'Circle Check' },
];
const DEFAULT_VALUE_ICON = 'ti-circle-check';

// ── STATE ────────────────────────────────────────────────────────
let pageHeaders   = [];
let galleryImages = [];
let aboutSections = [];
let faqs          = [];
let services      = [];
let menuSections  = [];
let menuBanner    = null;
let values        = [];

let editingHeaderKey   = null;
let headerPendingFile  = null;   // resized File chosen but not yet uploaded/saved
let editingGalleryId   = null;
let editingServiceId   = null;
let servicePendingFile = null;
let editingMenuSectionId   = null;
let menuSectionPendingFile = null;
let menuBannerPendingFile  = null;
let editingValueId  = null;
let valueModalIcon  = DEFAULT_VALUE_ICON;
let pendingConfirmAction = null;

// ── DOM refs ─────────────────────────────────────────────────────
const pageHeaderRows = document.getElementById('pageHeaderRows');
const galleryGrid    = document.getElementById('galleryGrid');
const galleryMsg     = document.getElementById('galleryMsg');
const aboutSectionsEl = document.getElementById('aboutSections');
const aboutMsg       = document.getElementById('aboutMsg');
const faqList        = document.getElementById('faqList');
const faqMsg         = document.getElementById('faqMsg');
const serviceList    = document.getElementById('serviceList');
const serviceMsg     = document.getElementById('serviceMsg');
const menuSectionList = document.getElementById('menuSectionList');
const menuSectionMsg  = document.getElementById('menuSectionMsg');
const menuBannerMsg   = document.getElementById('menuBannerMsg');
const valueList       = document.getElementById('valueList');
const valueMsg        = document.getElementById('valueMsg');

const headerModal        = document.getElementById('headerModal');
const headerModalTitle   = document.getElementById('headerModalTitle');
const headerModalSub     = document.getElementById('headerModalSub');
const headerModalMessage = document.getElementById('headerModalMessage');
const headerUploader     = document.getElementById('headerUploader');
const headerFileInput    = document.getElementById('headerFileInput');
const headerImgPreview   = document.getElementById('headerImgPreview');
const headerImgPlaceholder = document.getElementById('headerImgPlaceholder');
const headerFileName     = document.getElementById('headerFileName');
const headerAltInput     = document.getElementById('headerAltInput');
const headerHeadingInput = document.getElementById('headerHeadingInput');
const headerSubInput     = document.getElementById('headerSubInput');
const heroPreviewImg     = document.getElementById('heroPreviewImg');
const heroPreviewHeading = document.getElementById('heroPreviewHeading');
const heroPreviewSub     = document.getElementById('heroPreviewSub');
const headerModalSave    = document.getElementById('headerModalSave');

const galleryFileInput   = document.getElementById('galleryFileInput');
const galleryEditModal   = document.getElementById('galleryEditModal');
const galleryEditPreview = document.getElementById('galleryEditPreview');
const galleryAltInput    = document.getElementById('galleryAltInput');
const galleryCaptionInput = document.getElementById('galleryCaptionInput');
const galleryEditMessage = document.getElementById('galleryEditMessage');

const aboutPreviewModal = document.getElementById('aboutPreviewModal');
const aboutPreviewBody  = document.getElementById('aboutPreviewBody');

const faqModal        = document.getElementById('faqModal');
const faqModalTitle   = document.getElementById('faqModalTitle');
const faqModalMessage = document.getElementById('faqModalMessage');
const faqQuestionInput = document.getElementById('faqQuestionInput');
const faqAnswerInput  = document.getElementById('faqAnswerInput');
const faqModalSave    = document.getElementById('faqModalSave');
const faqModalSaveLabel = document.getElementById('faqModalSaveLabel');
let editingFaqId = null;

const confirmModal   = document.getElementById('confirmModal');
const confirmTitle   = document.getElementById('confirmTitle');
const confirmCopy    = document.getElementById('confirmCopy');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOk      = document.getElementById('confirmOk');

const serviceModal        = document.getElementById('serviceModal');
const serviceModalTitle   = document.getElementById('serviceModalTitle');
const serviceModalMessage = document.getElementById('serviceModalMessage');
const serviceUploader     = document.getElementById('serviceUploader');
const serviceFileInput    = document.getElementById('serviceFileInput');
const serviceImgPreview   = document.getElementById('serviceImgPreview');
const serviceImgPlaceholder = document.getElementById('serviceImgPlaceholder');
const serviceFileName     = document.getElementById('serviceFileName');
const serviceTitleInput   = document.getElementById('serviceTitleInput');
const serviceDescInput    = document.getElementById('serviceDescInput');
const serviceLinkUrlInput = document.getElementById('serviceLinkUrlInput');
const serviceLinkLabelInput = document.getElementById('serviceLinkLabelInput');
const serviceModalSave    = document.getElementById('serviceModalSave');
const serviceModalSaveLabel = document.getElementById('serviceModalSaveLabel');

const menuSectionModal        = document.getElementById('menuSectionModal');
const menuSectionModalTitle   = document.getElementById('menuSectionModalTitle');
const menuSectionModalMessage = document.getElementById('menuSectionModalMessage');
const menuSectionUploader     = document.getElementById('menuSectionUploader');
const menuSectionFileInput    = document.getElementById('menuSectionFileInput');
const menuSectionImgPreview   = document.getElementById('menuSectionImgPreview');
const menuSectionImgPlaceholder = document.getElementById('menuSectionImgPlaceholder');
const menuSectionFileName     = document.getElementById('menuSectionFileName');
const menuSectionHeadingInput = document.getElementById('menuSectionHeadingInput');
const menuSectionAltInput     = document.getElementById('menuSectionAltInput');
const menuSectionModalSave    = document.getElementById('menuSectionModalSave');
const menuSectionModalSaveLabel = document.getElementById('menuSectionModalSaveLabel');

const menuBannerUploader     = document.getElementById('menuBannerUploader');
const menuBannerFileInput    = document.getElementById('menuBannerFileInput');
const menuBannerImgPreview   = document.getElementById('menuBannerImgPreview');
const menuBannerImgPlaceholder = document.getElementById('menuBannerImgPlaceholder');
const menuBannerFileName     = document.getElementById('menuBannerFileName');
const menuBannerLabelInput   = document.getElementById('menuBannerLabelInput');
const menuBannerHeadingInput = document.getElementById('menuBannerHeadingInput');
const menuBannerDescInput    = document.getElementById('menuBannerDescInput');
const menuBannerAltInput     = document.getElementById('menuBannerAltInput');
const menuBannerActiveInput  = document.getElementById('menuBannerActiveInput');
const saveMenuBannerBtn      = document.getElementById('saveMenuBannerBtn');

const valueModal        = document.getElementById('valueModal');
const valueModalTitle   = document.getElementById('valueModalTitle');
const valueModalMessage = document.getElementById('valueModalMessage');
const valueLabelInput   = document.getElementById('valueLabelInput');
const valueDescInput    = document.getElementById('valueDescInput');
const valueIconPicker   = document.getElementById('valueIconPicker');
const valueModalSave    = document.getElementById('valueModalSave');
const valueModalSaveLabel = document.getElementById('valueModalSaveLabel');

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
  const [{ data: headers }, { data: gallery }, { data: about }, { data: faqRows }, { data: serviceRows }, { data: menuSectionRows }, { data: bannerRow }, { data: valueRows }] = await Promise.all([
    supabase.from('page_header').select('*'),
    supabase.from('gallery_image').select('*').order('sort_order', { ascending: true }),
    supabase.from('about_section').select('*').order('sort_order', { ascending: true }),
    supabase.from('faq').select('*').order('sort_order', { ascending: true }),
    supabase.from('landing_service').select('*').order('sort_order', { ascending: true }),
    supabase.from('menu_section').select('*').order('sort_order', { ascending: true }),
    supabase.from('menu_banner').select('*').eq('id', true).maybeSingle(),
    supabase.from('about_value').select('*').order('sort_order', { ascending: true }),
  ]);

  pageHeaders   = headers || [];
  galleryImages = gallery || [];
  aboutSections = about || [];
  faqs          = faqRows || [];
  services      = serviceRows || [];
  menuSections  = menuSectionRows || [];
  menuBanner    = bannerRow || null;
  values        = valueRows || [];

  renderPageHeaders();
  renderGallery();
  renderAboutSections();
  renderFaqs();
  renderServices();
  renderMenuSections();
  renderMenuBanner();
  renderValues();
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE HEADERS
// ═══════════════════════════════════════════════════════════════════════════
function renderPageHeaders() {
  const order = ['home', 'packages', 'about', 'faqs', 'menu'];
  const rows = order
    .map(key => pageHeaders.find(h => h.page_key === key))
    .filter(Boolean);

  pageHeaderRows.innerHTML = rows.map(h => `
    <div class="header-row">
      ${h.image_url
        ? `<img class="header-row-thumb" src="${escapeHtml(h.image_url)}" alt="">`
        : `<div class="header-row-thumb"></div>`}
      <div class="header-row-body">
        <div class="header-row-key">${escapeHtml(PAGE_LABELS[h.page_key] || h.page_key)}</div>
        <div class="header-row-heading">${escapeHtml(h.heading || 'No heading set')}</div>
        <div class="header-row-sub">${escapeHtml(h.subheading || '')}</div>
      </div>
      <button type="button" class="btn-outline-sm" data-edit-header="${escapeHtml(h.page_key)}">Edit</button>
    </div>`).join('');
}

pageHeaderRows.addEventListener('click', e => {
  const btn = e.target.closest('[data-edit-header]');
  if (btn) openHeaderModal(btn.dataset.editHeader);
});

function updateHeroPreview() {
  heroPreviewImg.src = headerImgPreview.src && !headerImgPreview.classList.contains('hidden')
    ? headerImgPreview.src
    : (pageHeaders.find(h => h.page_key === editingHeaderKey)?.image_url || '');
  heroPreviewHeading.textContent = headerHeadingInput.value || '(no heading)';
  heroPreviewSub.textContent = headerSubInput.value || '';
}

function openHeaderModal(pageKey) {
  const header = pageHeaders.find(h => h.page_key === pageKey);
  if (!header) return;
  editingHeaderKey = pageKey;
  headerPendingFile = null;

  headerModalTitle.textContent = `Edit ${PAGE_LABELS[pageKey] || pageKey} Header`;
  headerModalSub.textContent = 'Hero image and overlay text for this page';
  headerAltInput.value = header.alt_text || '';
  headerHeadingInput.value = header.heading || '';
  headerSubInput.value = header.subheading || '';
  headerFileName.textContent = 'No file chosen';

  if (header.image_url) {
    headerImgPreview.src = header.image_url;
    headerImgPreview.classList.remove('hidden');
    headerImgPlaceholder.style.display = 'none';
  } else {
    headerImgPreview.src = '';
    headerImgPreview.classList.add('hidden');
    headerImgPlaceholder.style.display = '';
  }

  updateHeroPreview();
  setModalMsg(headerModalMessage, '');
  openModal(headerModal);
}

headerUploader.addEventListener('click', () => headerFileInput.click());
headerUploader.addEventListener('dragover', e => e.preventDefault());
headerUploader.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) handleHeaderFile(file);
});
headerFileInput.addEventListener('change', () => {
  const file = headerFileInput.files?.[0];
  if (file) handleHeaderFile(file);
});

async function handleHeaderFile(file) {
  const err = validateImageFile(file);
  if (err) { setModalMsg(headerModalMessage, err); return; }
  setModalMsg(headerModalMessage, '');
  const resized = await resizeImageFile(file);
  headerPendingFile = resized;
  headerFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    headerImgPreview.src = e.target.result;
    headerImgPreview.classList.remove('hidden');
    headerImgPlaceholder.style.display = 'none';
    updateHeroPreview();
  };
  reader.readAsDataURL(resized);
}

[headerHeadingInput, headerSubInput].forEach(el => el.addEventListener('input', updateHeroPreview));

headerModalSave.addEventListener('click', async () => {
  const altText = headerAltInput.value.trim();
  if ((headerPendingFile || pageHeaders.find(h => h.page_key === editingHeaderKey)?.image_url) && !altText) {
    setModalMsg(headerModalMessage, 'Alt text is required for the hero image.');
    return;
  }

  headerModalSave.disabled = true;
  setModalMsg(headerModalMessage, '');
  try {
    const header = pageHeaders.find(h => h.page_key === editingHeaderKey);
    let imageUrl = header?.image_url || null;

    if (headerPendingFile) {
      imageUrl = await uploadToCloudinary(headerPendingFile, 'eli_coffee_page_content');
    }

    const payload = {
      heading: headerHeadingInput.value.trim() || null,
      subheading: headerSubInput.value.trim() || null,
      image_url: imageUrl,
      alt_text: altText || null,
      updated_at: new Date().toISOString()
    };
    const { data: { user } } = await supabase.auth.getUser();
    payload.updated_by = user?.id ?? null;

    const { error } = await supabase.from('page_header').update(payload).eq('page_key', editingHeaderKey);
    if (error) throw error;

    if (headerPendingFile && header?.image_url) {
      await destroyCloudinaryImage(supabase, header.image_url);
    }

    const idx = pageHeaders.findIndex(h => h.page_key === editingHeaderKey);
    if (idx !== -1) pageHeaders[idx] = { ...pageHeaders[idx], ...payload };

    await logAudit({ action: 'Updated Page Header', category: 'page_content', details: `${PAGE_LABELS[editingHeaderKey] || editingHeaderKey} header updated`, entityId: editingHeaderKey });

    renderPageHeaders();
    closeModal(headerModal);
  } catch (err) {
    setModalMsg(headerModalMessage, `Failed to save: ${err.message}`);
  } finally {
    headerModalSave.disabled = false;
  }
});

document.getElementById('headerModalClose').addEventListener('click', () => closeModal(headerModal));
document.getElementById('headerModalCancel').addEventListener('click', () => closeModal(headerModal));
headerModal.addEventListener('click', e => { if (e.target === headerModal) closeModal(headerModal); });

// ═══════════════════════════════════════════════════════════════════════════
// GALLERY
// ═══════════════════════════════════════════════════════════════════════════
function renderGallery() {
  if (!galleryImages.length) {
    galleryGrid.innerHTML = '<p class="gallery-empty">No gallery images yet. Add photos of the café and past events.</p>';
    return;
  }
  galleryGrid.innerHTML = galleryImages.map((g, i) => `
    <div class="gallery-admin-card ${g.is_active ? '' : 'is-inactive'}" data-id="${g.id}">
      <div class="gallery-admin-thumb-wrap">
        <img class="gallery-admin-thumb" src="${escapeHtml(g.image_url)}" alt="">
      </div>
      <div class="gallery-admin-body">
        <div class="gallery-admin-caption">${escapeHtml(g.caption || 'Untitled')}</div>
        <div class="gallery-admin-alt">${g.alt_text ? escapeHtml(g.alt_text) : '⚠ No alt text — hidden from customers'}</div>
        <div class="gallery-admin-actions">
          <button type="button" class="btn-icon-xs" data-move-gallery="up" data-id="${g.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(g.caption || 'photo')} up">↑</button>
          <button type="button" class="btn-icon-xs" data-move-gallery="down" data-id="${g.id}" ${i === galleryImages.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(g.caption || 'photo')} down">↓</button>
          <span class="spacer"></span>
          <button type="button" class="btn-outline-sm" data-edit-gallery="${g.id}">Edit</button>
          <button type="button" class="btn-icon-xs" data-toggle-gallery="${g.id}" aria-label="${g.is_active ? 'Deactivate' : 'Activate'} ${escapeHtml(g.caption || 'photo')}" ${g.alt_text ? '' : 'disabled title="Add alt text first"'}>${g.is_active ? '●' : '○'}</button>
          <button type="button" class="btn-icon-xs" data-remove-gallery="${g.id}" aria-label="Remove ${escapeHtml(g.caption || 'photo')}">✕</button>
        </div>
      </div>
    </div>`).join('');
}

galleryGrid.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-gallery]');
  if (moveBtn) { moveGalleryImage(moveBtn.dataset.id, moveBtn.dataset.moveGallery); return; }
  const editBtn = e.target.closest('[data-edit-gallery]');
  if (editBtn) { openGalleryEditModal(editBtn.dataset.editGallery); return; }
  const toggleBtn = e.target.closest('[data-toggle-gallery]');
  if (toggleBtn) { toggleGalleryActive(toggleBtn.dataset.toggleGallery); return; }
  const removeBtn = e.target.closest('[data-remove-gallery]');
  if (removeBtn) { openConfirmRemoveGallery(removeBtn.dataset.removeGallery); return; }
});

document.getElementById('addGalleryBtn').addEventListener('click', () => galleryFileInput.click());

galleryFileInput.addEventListener('change', async () => {
  const files = Array.from(galleryFileInput.files || []);
  galleryFileInput.value = '';
  if (!files.length) return;

  setMsg(galleryMsg, `Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
  let uploaded = 0;
  for (const file of files) {
    const err = validateImageFile(file);
    if (err) { setMsg(galleryMsg, err, 'error'); continue; }
    try {
      const resized = await resizeImageFile(file);
      const imageUrl = await uploadToCloudinary(resized, 'eli_coffee_page_content');
      const nextSort = galleryImages.length ? Math.max(...galleryImages.map(g => g.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('gallery_image').insert({
        image_url: imageUrl, alt_text: '', is_active: false, sort_order: nextSort
      }).select().single();
      if (error) throw error;
      galleryImages.push(data);
      uploaded++;
    } catch (err) {
      setMsg(galleryMsg, `Failed to upload ${file.name}: ${err.message}`, 'error');
    }
  }
  renderGallery();
  if (uploaded) {
    setMsg(galleryMsg, `${uploaded} photo${uploaded === 1 ? '' : 's'} uploaded — add alt text to each before it goes live.`, 'success');
    // Immediately prompt for alt text on the last uploaded image.
    const last = galleryImages[galleryImages.length - 1];
    if (last) openGalleryEditModal(last.id);
  }
});

function openGalleryEditModal(id) {
  const img = galleryImages.find(g => g.id === id);
  if (!img) return;
  editingGalleryId = id;
  galleryEditPreview.src = img.image_url;
  galleryAltInput.value = img.alt_text || '';
  galleryCaptionInput.value = img.caption || '';
  setModalMsg(galleryEditMessage, '');
  openModal(galleryEditModal);
}

document.getElementById('galleryEditSave').addEventListener('click', async () => {
  const altText = galleryAltInput.value.trim();
  if (!altText) { setModalMsg(galleryEditMessage, 'Alt text is required.'); return; }

  try {
    const img = galleryImages.find(g => g.id === editingGalleryId);
    const payload = { alt_text: altText, caption: galleryCaptionInput.value.trim() || null, is_active: true };
    const { error } = await supabase.from('gallery_image').update(payload).eq('id', editingGalleryId);
    if (error) throw error;
    Object.assign(img, payload);
    await logAudit({ action: 'Updated Gallery Image', category: 'page_content', details: `Updated caption/alt text for a gallery image`, entityId: editingGalleryId });
    renderGallery();
    closeModal(galleryEditModal);
  } catch (err) {
    setModalMsg(galleryEditMessage, `Failed to save: ${err.message}`);
  }
});
document.getElementById('galleryEditClose').addEventListener('click', () => closeModal(galleryEditModal));
document.getElementById('galleryEditCancel').addEventListener('click', () => closeModal(galleryEditModal));
galleryEditModal.addEventListener('click', e => { if (e.target === galleryEditModal) closeModal(galleryEditModal); });

async function toggleGalleryActive(id) {
  const img = galleryImages.find(g => g.id === id);
  if (!img || !img.alt_text) return;
  const nextActive = !img.is_active;
  const { error } = await supabase.from('gallery_image').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(galleryMsg, `Failed: ${error.message}`, 'error'); return; }
  img.is_active = nextActive;
  renderGallery();
}

async function moveGalleryImage(id, direction) {
  const idx = galleryImages.findIndex(g => g.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= galleryImages.length) return;

  const a = galleryImages[idx];
  const b = galleryImages[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('gallery_image').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('gallery_image').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(galleryMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  galleryImages.sort((x, y) => x.sort_order - y.sort_order);
  renderGallery();
}

function openConfirmRemoveGallery(id) {
  const img = galleryImages.find(g => g.id === id);
  if (!img) return;
  pendingConfirmAction = { type: 'remove-gallery', id };
  confirmTitle.textContent = 'Remove Photo';
  confirmCopy.textContent = `Remove "${img.caption || 'this photo'}" from the gallery? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════
// ABOUT
// ═══════════════════════════════════════════════════════════════════════════
// 'values' intentionally excluded — "What We Stand For" moved from a
// freeform about_section body (rendered as plain text) to the structured
// about_value repeatable list below, which is now the only editor for it.
const ABOUT_ORDER = ['home_teaser', 'who_we_are', 'mission'];

function renderAboutSections() {
  if (!aboutSections.length) {
    aboutSectionsEl.innerHTML = '<p class="about-empty">No About content yet.</p>';
    return;
  }
  const ordered = ABOUT_ORDER.map(key => aboutSections.find(s => s.section_key === key)).filter(Boolean);
  aboutSectionsEl.innerHTML = ordered.map(s => `
    <div class="about-section-card" data-key="${escapeHtml(s.section_key)}">
      <div class="about-section-head">
        <span class="about-section-title">${escapeHtml(s.title)}</span>
      </div>
      <textarea class="about-body-input" data-about-body="${escapeHtml(s.section_key)}" rows="6">${escapeHtml(s.body || '')}</textarea>
      <div class="about-section-actions">
        <button type="button" class="btn-outline-sm" data-about-preview="${escapeHtml(s.section_key)}">Preview</button>
        <button type="button" class="btn-primary" data-about-save="${escapeHtml(s.section_key)}">Save</button>
      </div>
    </div>`).join('');
}

aboutSectionsEl.addEventListener('click', async e => {
  const previewBtn = e.target.closest('[data-about-preview]');
  if (previewBtn) {
    const key = previewBtn.dataset.aboutPreview;
    const textarea = aboutSectionsEl.querySelector(`textarea[data-about-body="${key}"]`);
    aboutPreviewBody.innerHTML = renderPolicyBlocks(parsePolicyBody(textarea.value));
    openModal(aboutPreviewModal);
    return;
  }
  const saveBtn = e.target.closest('[data-about-save]');
  if (saveBtn) {
    const key = saveBtn.dataset.aboutSave;
    const textarea = aboutSectionsEl.querySelector(`textarea[data-about-body="${key}"]`);
    saveBtn.disabled = true;
    setMsg(aboutMsg, 'Saving…');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('about_section').update({
        body: textarea.value.trim() || null,
        updated_at: new Date().toISOString(),
        updated_by: user?.id ?? null
      }).eq('section_key', key);
      if (error) throw error;
      const section = aboutSections.find(s => s.section_key === key);
      if (section) section.body = textarea.value.trim() || null;
      await logAudit({ action: 'Updated About Section', category: 'page_content', details: `Updated "${section?.title || key}"`, entityId: key });
      setMsg(aboutMsg, 'Saved successfully.', 'success');
    } catch (err) {
      setMsg(aboutMsg, `Failed to save: ${err.message}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }
});

document.getElementById('aboutPreviewClose').addEventListener('click', () => closeModal(aboutPreviewModal));
document.getElementById('aboutPreviewDone').addEventListener('click', () => closeModal(aboutPreviewModal));
aboutPreviewModal.addEventListener('click', e => { if (e.target === aboutPreviewModal) closeModal(aboutPreviewModal); });

// ═══════════════════════════════════════════════════════════════════════════
// FAQS
// ═══════════════════════════════════════════════════════════════════════════
function renderFaqs() {
  if (!faqs.length) {
    faqList.innerHTML = '<p class="faq-empty">No FAQs yet. Add the questions customers ask most.</p>';
    return;
  }
  faqList.innerHTML = faqs.map((f, i) => `
    <div class="faq-admin-row ${f.is_active ? '' : 'is-inactive'}" data-id="${f.id}">
      <div class="faq-admin-reorder">
        <button type="button" class="btn-icon-xs" data-move-faq="up" data-id="${f.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button type="button" class="btn-icon-xs" data-move-faq="down" data-id="${f.id}" ${i === faqs.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      </div>
      <div class="faq-admin-body">
        <div class="faq-admin-question">${escapeHtml(f.question)}</div>
        <div class="faq-admin-answer">${escapeHtml(f.answer)}</div>
      </div>
      <div class="faq-admin-actions">
        <button type="button" class="btn-icon-xs" data-toggle-faq="${f.id}" aria-label="${f.is_active ? 'Deactivate' : 'Activate'} this FAQ">${f.is_active ? '●' : '○'}</button>
        <button type="button" class="btn-outline-sm" data-edit-faq="${f.id}">Edit</button>
        <button type="button" class="btn-icon-xs" data-remove-faq="${f.id}" aria-label="Remove this FAQ">✕</button>
      </div>
    </div>`).join('');
}

faqList.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-faq]');
  if (moveBtn) { moveFaq(moveBtn.dataset.id, moveBtn.dataset.moveFaq); return; }
  const toggleBtn = e.target.closest('[data-toggle-faq]');
  if (toggleBtn) { toggleFaqActive(toggleBtn.dataset.toggleFaq); return; }
  const editBtn = e.target.closest('[data-edit-faq]');
  if (editBtn) { openFaqModal(editBtn.dataset.editFaq); return; }
  const removeBtn = e.target.closest('[data-remove-faq]');
  if (removeBtn) { openConfirmRemoveFaq(removeBtn.dataset.removeFaq); return; }
});

document.getElementById('addFaqBtn').addEventListener('click', () => openFaqModal(null));

function openFaqModal(id) {
  editingFaqId = id;
  const faq = id ? faqs.find(f => f.id === id) : null;
  faqModalTitle.textContent = faq ? 'Edit FAQ' : 'Add FAQ';
  faqModalSaveLabel.textContent = faq ? 'Save Changes' : 'Add FAQ';
  faqQuestionInput.value = faq?.question || '';
  faqAnswerInput.value = faq?.answer || '';
  setModalMsg(faqModalMessage, '');
  openModal(faqModal);
}

faqModalSave.addEventListener('click', async () => {
  const question = faqQuestionInput.value.trim();
  const answer = faqAnswerInput.value.trim();
  if (!question || !answer) { setModalMsg(faqModalMessage, 'Question and answer are both required.'); return; }

  faqModalSave.disabled = true;
  try {
    if (editingFaqId) {
      const { error } = await supabase.from('faq').update({ question, answer, updated_at: new Date().toISOString() }).eq('id', editingFaqId);
      if (error) throw error;
      const faq = faqs.find(f => f.id === editingFaqId);
      Object.assign(faq, { question, answer });
      await logAudit({ action: 'Updated FAQ', category: 'page_content', details: `Updated: ${question}`, entityId: editingFaqId });
    } else {
      const nextSort = faqs.length ? Math.max(...faqs.map(f => f.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('faq').insert({ question, answer, sort_order: nextSort }).select().single();
      if (error) throw error;
      faqs.push(data);
      await logAudit({ action: 'Added FAQ', category: 'page_content', details: `Added: ${question}`, entityId: data.id });
    }
    renderFaqs();
    closeModal(faqModal);
  } catch (err) {
    setModalMsg(faqModalMessage, `Failed to save: ${err.message}`);
  } finally {
    faqModalSave.disabled = false;
  }
});

document.getElementById('faqModalClose').addEventListener('click', () => closeModal(faqModal));
document.getElementById('faqModalCancel').addEventListener('click', () => closeModal(faqModal));
faqModal.addEventListener('click', e => { if (e.target === faqModal) closeModal(faqModal); });

async function toggleFaqActive(id) {
  const faq = faqs.find(f => f.id === id);
  if (!faq) return;
  const nextActive = !faq.is_active;
  const { error } = await supabase.from('faq').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(faqMsg, `Failed: ${error.message}`, 'error'); return; }
  faq.is_active = nextActive;
  renderFaqs();
}

async function moveFaq(id, direction) {
  const idx = faqs.findIndex(f => f.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= faqs.length) return;

  const a = faqs[idx];
  const b = faqs[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('faq').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('faq').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(faqMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  faqs.sort((x, y) => x.sort_order - y.sort_order);
  renderFaqs();
}

function openConfirmRemoveFaq(id) {
  const faq = faqs.find(f => f.id === id);
  if (!faq) return;
  pendingConfirmAction = { type: 'remove-faq', id };
  confirmTitle.textContent = 'Remove FAQ';
  confirmCopy.textContent = `Remove "${faq.question}"? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICES (What We Offer)
// ═══════════════════════════════════════════════════════════════════════════
function renderServices() {
  if (!services.length) {
    serviceList.innerHTML = '<p class="service-empty">No services yet. Add the offerings shown on the homepage.</p>';
    return;
  }
  serviceList.innerHTML = services.map((s, i) => `
    <div class="service-admin-row ${s.is_active ? '' : 'is-inactive'}" data-id="${s.id}">
      <div class="service-admin-reorder">
        <button type="button" class="btn-icon-xs" data-move-service="up" data-id="${s.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(s.title)} up">↑</button>
        <button type="button" class="btn-icon-xs" data-move-service="down" data-id="${s.id}" ${i === services.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(s.title)} down">↓</button>
      </div>
      ${s.image_url
        ? `<img class="service-admin-thumb" src="${escapeHtml(s.image_url)}" alt="">`
        : `<div class="service-admin-thumb"></div>`}
      <div class="service-admin-body">
        <div class="service-admin-title">${escapeHtml(s.title)}</div>
        ${s.description ? `<div class="service-admin-desc">${escapeHtml(s.description)}</div>` : ''}
        ${s.link_url ? `<div class="service-admin-link">${escapeHtml(s.link_label || 'Link')} → ${escapeHtml(s.link_url)}</div>` : ''}
      </div>
      <div class="service-admin-actions">
        <button type="button" class="btn-icon-xs" data-toggle-service="${s.id}" aria-label="${s.is_active ? 'Deactivate' : 'Activate'} ${escapeHtml(s.title)}">${s.is_active ? '●' : '○'}</button>
        <button type="button" class="btn-outline-sm" data-edit-service="${s.id}">Edit</button>
        <button type="button" class="btn-icon-xs" data-remove-service="${s.id}" aria-label="Remove ${escapeHtml(s.title)}">✕</button>
      </div>
    </div>`).join('');
}

serviceList.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-service]');
  if (moveBtn) { moveService(moveBtn.dataset.id, moveBtn.dataset.moveService); return; }
  const toggleBtn = e.target.closest('[data-toggle-service]');
  if (toggleBtn) { toggleServiceActive(toggleBtn.dataset.toggleService); return; }
  const editBtn = e.target.closest('[data-edit-service]');
  if (editBtn) { openServiceModal(editBtn.dataset.editService); return; }
  const removeBtn = e.target.closest('[data-remove-service]');
  if (removeBtn) { openConfirmRemoveService(removeBtn.dataset.removeService); return; }
});

document.getElementById('addServiceBtn').addEventListener('click', () => openServiceModal(null));

function openServiceModal(id) {
  editingServiceId = id;
  servicePendingFile = null;
  const svc = id ? services.find(s => s.id === id) : null;

  serviceModalTitle.textContent = svc ? 'Edit Service' : 'Add Service';
  serviceModalSaveLabel.textContent = svc ? 'Save Changes' : 'Add Service';
  serviceTitleInput.value = svc?.title || '';
  serviceDescInput.value = svc?.description || '';
  serviceLinkUrlInput.value = svc?.link_url || '';
  serviceLinkLabelInput.value = svc?.link_label || '';
  serviceFileName.textContent = 'No file chosen';

  if (svc?.image_url) {
    serviceImgPreview.src = svc.image_url;
    serviceImgPreview.classList.remove('hidden');
    serviceImgPlaceholder.style.display = 'none';
  } else {
    serviceImgPreview.src = '';
    serviceImgPreview.classList.add('hidden');
    serviceImgPlaceholder.style.display = '';
  }

  setModalMsg(serviceModalMessage, '');
  openModal(serviceModal);
}

serviceUploader.addEventListener('click', () => serviceFileInput.click());
serviceUploader.addEventListener('dragover', e => e.preventDefault());
serviceUploader.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) handleServiceFile(file);
});
serviceFileInput.addEventListener('change', () => {
  const file = serviceFileInput.files?.[0];
  if (file) handleServiceFile(file);
});

async function handleServiceFile(file) {
  const err = validateImageFile(file);
  if (err) { setModalMsg(serviceModalMessage, err); return; }
  setModalMsg(serviceModalMessage, '');
  const resized = await resizeImageFile(file);
  servicePendingFile = resized;
  serviceFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    serviceImgPreview.src = e.target.result;
    serviceImgPreview.classList.remove('hidden');
    serviceImgPlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(resized);
}

serviceModalSave.addEventListener('click', async () => {
  const title = serviceTitleInput.value.trim();
  if (!title) { setModalMsg(serviceModalMessage, 'Title is required.'); return; }

  serviceModalSave.disabled = true;
  try {
    const svc = editingServiceId ? services.find(s => s.id === editingServiceId) : null;
    let imageUrl = svc?.image_url || null;
    if (servicePendingFile) {
      imageUrl = await uploadToCloudinary(servicePendingFile, 'eli_coffee_page_content');
    }

    const payload = {
      title,
      description: serviceDescInput.value.trim() || null,
      link_url: serviceLinkUrlInput.value.trim() || null,
      link_label: serviceLinkLabelInput.value.trim() || null,
      image_url: imageUrl
    };

    if (editingServiceId) {
      const { error } = await supabase.from('landing_service').update(payload).eq('id', editingServiceId);
      if (error) throw error;
      if (servicePendingFile && svc?.image_url) await destroyCloudinaryImage(supabase, svc.image_url);
      Object.assign(svc, payload);
      await logAudit({ action: 'Updated Service', category: 'page_content', details: `Updated: ${title}`, entityId: editingServiceId });
    } else {
      const nextSort = services.length ? Math.max(...services.map(s => s.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('landing_service').insert({ ...payload, sort_order: nextSort }).select().single();
      if (error) throw error;
      services.push(data);
      await logAudit({ action: 'Added Service', category: 'page_content', details: `Added: ${title}`, entityId: data.id });
    }
    renderServices();
    closeModal(serviceModal);
  } catch (err) {
    setModalMsg(serviceModalMessage, `Failed to save: ${err.message}`);
  } finally {
    serviceModalSave.disabled = false;
  }
});

document.getElementById('serviceModalClose').addEventListener('click', () => closeModal(serviceModal));
document.getElementById('serviceModalCancel').addEventListener('click', () => closeModal(serviceModal));
serviceModal.addEventListener('click', e => { if (e.target === serviceModal) closeModal(serviceModal); });

async function toggleServiceActive(id) {
  const svc = services.find(s => s.id === id);
  if (!svc) return;
  const nextActive = !svc.is_active;
  const { error } = await supabase.from('landing_service').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(serviceMsg, `Failed: ${error.message}`, 'error'); return; }
  svc.is_active = nextActive;
  renderServices();
}

async function moveService(id, direction) {
  const idx = services.findIndex(s => s.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= services.length) return;

  const a = services[idx];
  const b = services[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('landing_service').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('landing_service').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(serviceMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  services.sort((x, y) => x.sort_order - y.sort_order);
  renderServices();
}

function openConfirmRemoveService(id) {
  const svc = services.find(s => s.id === id);
  if (!svc) return;
  pendingConfirmAction = { type: 'remove-service', id };
  confirmTitle.textContent = 'Remove Service';
  confirmCopy.textContent = `Remove "${svc.title}"? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU IMAGES
// ═══════════════════════════════════════════════════════════════════════════
function renderMenuSections() {
  if (!menuSections.length) {
    menuSectionList.innerHTML = '<p class="menu-section-empty">No menu images yet. Add the scanned menu photos shown on the Menu page.</p>';
    return;
  }
  menuSectionList.innerHTML = menuSections.map((m, i) => `
    <div class="menu-section-admin-row ${m.is_active ? '' : 'is-inactive'}" data-id="${m.id}">
      <div class="menu-section-admin-reorder">
        <button type="button" class="btn-icon-xs" data-move-menu-section="up" data-id="${m.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(m.heading)} up">↑</button>
        <button type="button" class="btn-icon-xs" data-move-menu-section="down" data-id="${m.id}" ${i === menuSections.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(m.heading)} down">↓</button>
      </div>
      <img class="menu-section-admin-thumb" src="${escapeHtml(m.image_url)}" alt="">
      <div class="menu-section-admin-body">
        <div class="menu-section-admin-heading">${escapeHtml(m.heading)}</div>
        <div class="menu-section-admin-alt">${m.alt_text ? escapeHtml(m.alt_text) : '⚠ No alt text — hidden from customers'}</div>
      </div>
      <div class="menu-section-admin-actions">
        <button type="button" class="btn-outline-sm" data-edit-menu-section="${m.id}">Edit</button>
        <button type="button" class="btn-icon-xs" data-toggle-menu-section="${m.id}" aria-label="${m.is_active ? 'Deactivate' : 'Activate'} ${escapeHtml(m.heading)}">${m.is_active ? '●' : '○'}</button>
        <button type="button" class="btn-icon-xs" data-remove-menu-section="${m.id}" aria-label="Remove ${escapeHtml(m.heading)}">✕</button>
      </div>
    </div>`).join('');
}

menuSectionList.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-menu-section]');
  if (moveBtn) { moveMenuSection(moveBtn.dataset.id, moveBtn.dataset.moveMenuSection); return; }
  const editBtn = e.target.closest('[data-edit-menu-section]');
  if (editBtn) { openMenuSectionModal(editBtn.dataset.editMenuSection); return; }
  const toggleBtn = e.target.closest('[data-toggle-menu-section]');
  if (toggleBtn) { toggleMenuSectionActive(toggleBtn.dataset.toggleMenuSection); return; }
  const removeBtn = e.target.closest('[data-remove-menu-section]');
  if (removeBtn) { openConfirmRemoveMenuSection(removeBtn.dataset.removeMenuSection); return; }
});

document.getElementById('addMenuSectionBtn').addEventListener('click', () => openMenuSectionModal(null));

function openMenuSectionModal(id) {
  editingMenuSectionId = id;
  menuSectionPendingFile = null;
  const section = id ? menuSections.find(m => m.id === id) : null;

  menuSectionModalTitle.textContent = section ? 'Edit Menu Image' : 'Add Menu Image';
  menuSectionModalSaveLabel.textContent = section ? 'Save Changes' : 'Add Menu Image';
  menuSectionHeadingInput.value = section?.heading || '';
  menuSectionAltInput.value = section?.alt_text || '';
  menuSectionFileName.textContent = 'No file chosen';

  if (section?.image_url) {
    menuSectionImgPreview.src = section.image_url;
    menuSectionImgPreview.classList.remove('hidden');
    menuSectionImgPlaceholder.style.display = 'none';
  } else {
    menuSectionImgPreview.src = '';
    menuSectionImgPreview.classList.add('hidden');
    menuSectionImgPlaceholder.style.display = '';
  }

  setModalMsg(menuSectionModalMessage, '');
  openModal(menuSectionModal);
}

menuSectionUploader.addEventListener('click', () => menuSectionFileInput.click());
menuSectionUploader.addEventListener('dragover', e => e.preventDefault());
menuSectionUploader.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) handleMenuSectionFile(file);
});
menuSectionFileInput.addEventListener('change', () => {
  const file = menuSectionFileInput.files?.[0];
  if (file) handleMenuSectionFile(file);
});

async function handleMenuSectionFile(file) {
  const err = validateImageFile(file);
  if (err) { setModalMsg(menuSectionModalMessage, err); return; }
  setModalMsg(menuSectionModalMessage, '');
  const resized = await resizeImageFile(file);
  menuSectionPendingFile = resized;
  menuSectionFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    menuSectionImgPreview.src = e.target.result;
    menuSectionImgPreview.classList.remove('hidden');
    menuSectionImgPlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(resized);
}

menuSectionModalSave.addEventListener('click', async () => {
  const heading = menuSectionHeadingInput.value.trim();
  const altText = menuSectionAltInput.value.trim();
  const section = editingMenuSectionId ? menuSections.find(m => m.id === editingMenuSectionId) : null;
  if (!heading) { setModalMsg(menuSectionModalMessage, 'Heading is required.'); return; }
  if (!altText) { setModalMsg(menuSectionModalMessage, 'Alt text is required.'); return; }
  if (!menuSectionPendingFile && !section?.image_url) { setModalMsg(menuSectionModalMessage, 'A menu image is required.'); return; }

  menuSectionModalSave.disabled = true;
  try {
    let imageUrl = section?.image_url || null;
    if (menuSectionPendingFile) {
      imageUrl = await uploadToCloudinary(menuSectionPendingFile, 'eli_coffee_page_content');
    }

    const payload = { heading, alt_text: altText, image_url: imageUrl, updated_at: new Date().toISOString() };
    const { data: { user } } = await supabase.auth.getUser();
    payload.updated_by = user?.id ?? null;

    if (editingMenuSectionId) {
      const { error } = await supabase.from('menu_section').update(payload).eq('id', editingMenuSectionId);
      if (error) throw error;
      if (menuSectionPendingFile && section?.image_url) await destroyCloudinaryImage(supabase, section.image_url);
      Object.assign(section, payload);
      await logAudit({ action: 'Updated Menu Image', category: 'page_content', details: `Updated: ${heading}`, entityId: editingMenuSectionId });
    } else {
      const nextSort = menuSections.length ? Math.max(...menuSections.map(m => m.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('menu_section').insert({ ...payload, sort_order: nextSort }).select().single();
      if (error) throw error;
      menuSections.push(data);
      await logAudit({ action: 'Added Menu Image', category: 'page_content', details: `Added: ${heading}`, entityId: data.id });
    }
    renderMenuSections();
    closeModal(menuSectionModal);
  } catch (err) {
    setModalMsg(menuSectionModalMessage, `Failed to save: ${err.message}`);
  } finally {
    menuSectionModalSave.disabled = false;
  }
});

document.getElementById('menuSectionModalClose').addEventListener('click', () => closeModal(menuSectionModal));
document.getElementById('menuSectionModalCancel').addEventListener('click', () => closeModal(menuSectionModal));
menuSectionModal.addEventListener('click', e => { if (e.target === menuSectionModal) closeModal(menuSectionModal); });

async function toggleMenuSectionActive(id) {
  const section = menuSections.find(m => m.id === id);
  if (!section) return;
  const nextActive = !section.is_active;
  const { error } = await supabase.from('menu_section').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(menuSectionMsg, `Failed: ${error.message}`, 'error'); return; }
  section.is_active = nextActive;
  renderMenuSections();
}

async function moveMenuSection(id, direction) {
  const idx = menuSections.findIndex(m => m.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= menuSections.length) return;

  const a = menuSections[idx];
  const b = menuSections[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('menu_section').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('menu_section').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(menuSectionMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  menuSections.sort((x, y) => x.sort_order - y.sort_order);
  renderMenuSections();
}

function openConfirmRemoveMenuSection(id) {
  const section = menuSections.find(m => m.id === id);
  if (!section) return;
  pendingConfirmAction = { type: 'remove-menu-section', id };
  confirmTitle.textContent = 'Remove Menu Image';
  confirmCopy.textContent = `Remove "${section.heading}" from the Menu page? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════
// ELITE CARD BANNER (singleton)
// ═══════════════════════════════════════════════════════════════════════════
function renderMenuBanner() {
  const banner = menuBanner;
  menuBannerLabelInput.value = banner?.label ?? 'Members Only';
  menuBannerHeadingInput.value = banner?.heading ?? 'Elite Card';
  menuBannerDescInput.value = banner?.description ?? '';
  menuBannerAltInput.value = banner?.alt_text ?? '';
  menuBannerActiveInput.checked = banner?.is_active !== false;
  menuBannerFileName.textContent = 'No file chosen';

  if (banner?.image_url) {
    menuBannerImgPreview.src = banner.image_url;
    menuBannerImgPreview.classList.remove('hidden');
    menuBannerImgPlaceholder.style.display = 'none';
  } else {
    menuBannerImgPreview.src = '';
    menuBannerImgPreview.classList.add('hidden');
    menuBannerImgPlaceholder.style.display = '';
  }
}

menuBannerUploader.addEventListener('click', () => menuBannerFileInput.click());
menuBannerUploader.addEventListener('dragover', e => e.preventDefault());
menuBannerUploader.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) handleMenuBannerFile(file);
});
menuBannerFileInput.addEventListener('change', () => {
  const file = menuBannerFileInput.files?.[0];
  if (file) handleMenuBannerFile(file);
});

async function handleMenuBannerFile(file) {
  const err = validateImageFile(file);
  if (err) { setMsg(menuBannerMsg, err, 'error'); return; }
  setMsg(menuBannerMsg, '');
  const resized = await resizeImageFile(file);
  menuBannerPendingFile = resized;
  menuBannerFileName.textContent = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    menuBannerImgPreview.src = e.target.result;
    menuBannerImgPreview.classList.remove('hidden');
    menuBannerImgPlaceholder.style.display = 'none';
  };
  reader.readAsDataURL(resized);
}

saveMenuBannerBtn.addEventListener('click', async () => {
  const label = menuBannerLabelInput.value.trim();
  const heading = menuBannerHeadingInput.value.trim();
  const description = menuBannerDescInput.value.trim();
  const altText = menuBannerAltInput.value.trim();
  const isActive = menuBannerActiveInput.checked;

  if (!label || !heading || !description) { setMsg(menuBannerMsg, 'Label, heading, and description are all required.', 'error'); return; }
  if (isActive && (menuBannerPendingFile || menuBanner?.image_url) && !altText) {
    setMsg(menuBannerMsg, 'Alt text is required for the banner image.', 'error');
    return;
  }

  saveMenuBannerBtn.disabled = true;
  setMsg(menuBannerMsg, 'Saving…');
  try {
    let imageUrl = menuBanner?.image_url || null;
    if (menuBannerPendingFile) {
      imageUrl = await uploadToCloudinary(menuBannerPendingFile, 'eli_coffee_page_content');
    }

    const payload = {
      label, heading, description,
      alt_text: altText || null,
      image_url: imageUrl,
      is_active: isActive,
      updated_at: new Date().toISOString()
    };
    const { data: { user } } = await supabase.auth.getUser();
    payload.updated_by = user?.id ?? null;

    const { error } = await supabase.from('menu_banner').update(payload).eq('id', true);
    if (error) throw error;

    if (menuBannerPendingFile && menuBanner?.image_url) {
      await destroyCloudinaryImage(supabase, menuBanner.image_url);
    }

    menuBanner = { ...menuBanner, ...payload };
    menuBannerPendingFile = null;
    await logAudit({ action: 'Updated Elite Card Banner', category: 'page_content', details: `is_active=${isActive}` });
    setMsg(menuBannerMsg, 'Banner saved successfully.', 'success');
  } catch (err) {
    setMsg(menuBannerMsg, `Failed to save: ${err.message}`, 'error');
  } finally {
    saveMenuBannerBtn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OUR VALUES ("What We Stand For" icon cards)
// ═══════════════════════════════════════════════════════════════════════════
function iconLabel(iconId) {
  return VALUE_ICONS.find(i => i.id === iconId)?.label || iconId;
}

function renderValues() {
  if (!values.length) {
    valueList.innerHTML = '<p class="value-empty">No values yet. Add the principles shown on the About page.</p>';
    return;
  }
  valueList.innerHTML = values.map((v, i) => `
    <div class="value-admin-row ${v.is_active ? '' : 'is-inactive'}" data-id="${v.id}">
      <div class="value-admin-reorder">
        <button type="button" class="btn-icon-xs" data-move-value="up" data-id="${v.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(v.label)} up">↑</button>
        <button type="button" class="btn-icon-xs" data-move-value="down" data-id="${v.id}" ${i === values.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(v.label)} down">↓</button>
      </div>
      <div class="value-admin-icon"><i class="ti ${escapeHtml(v.icon || DEFAULT_VALUE_ICON)}" aria-hidden="true"></i></div>
      <div class="value-admin-body">
        <div class="value-admin-label">${escapeHtml(v.label)}</div>
        <div class="value-admin-desc">${escapeHtml(v.description)}</div>
      </div>
      <div class="value-admin-actions">
        <button type="button" class="btn-outline-sm" data-edit-value="${v.id}">Edit</button>
        <button type="button" class="btn-icon-xs" data-toggle-value="${v.id}" aria-label="${v.is_active ? 'Deactivate' : 'Activate'} ${escapeHtml(v.label)}">${v.is_active ? '●' : '○'}</button>
        <button type="button" class="btn-icon-xs" data-remove-value="${v.id}" aria-label="Remove ${escapeHtml(v.label)}">✕</button>
      </div>
    </div>`).join('');
}

valueList.addEventListener('click', e => {
  const moveBtn = e.target.closest('[data-move-value]');
  if (moveBtn) { moveValue(moveBtn.dataset.id, moveBtn.dataset.moveValue); return; }
  const editBtn = e.target.closest('[data-edit-value]');
  if (editBtn) { openValueModal(editBtn.dataset.editValue); return; }
  const toggleBtn = e.target.closest('[data-toggle-value]');
  if (toggleBtn) { toggleValueActive(toggleBtn.dataset.toggleValue); return; }
  const removeBtn = e.target.closest('[data-remove-value]');
  if (removeBtn) { openConfirmRemoveValue(removeBtn.dataset.removeValue); return; }
});

document.getElementById('addValueBtn').addEventListener('click', () => openValueModal(null));

function renderValueIconPicker() {
  valueIconPicker.innerHTML = VALUE_ICONS.map(icon => `
    <button type="button" class="icon-pick-btn ${icon.id === valueModalIcon ? 'active' : ''}"
            data-pick-icon="${icon.id}" aria-pressed="${icon.id === valueModalIcon}" aria-label="${icon.label} icon">
      <i class="ti ${icon.id}" aria-hidden="true"></i>
    </button>`).join('');
}

valueIconPicker.addEventListener('click', e => {
  const btn = e.target.closest('[data-pick-icon]');
  if (!btn) return;
  valueModalIcon = btn.dataset.pickIcon;
  renderValueIconPicker();
});

function openValueModal(id) {
  editingValueId = id;
  const value = id ? values.find(v => v.id === id) : null;

  valueModalTitle.textContent = value ? 'Edit Value' : 'Add Value';
  valueModalSaveLabel.textContent = value ? 'Save Changes' : 'Add Value';
  valueLabelInput.value = value?.label || '';
  valueDescInput.value = value?.description || '';
  valueModalIcon = value?.icon || DEFAULT_VALUE_ICON;
  renderValueIconPicker();

  setModalMsg(valueModalMessage, '');
  openModal(valueModal);
}

valueModalSave.addEventListener('click', async () => {
  const label = valueLabelInput.value.trim();
  const description = valueDescInput.value.trim();
  if (!label) { setModalMsg(valueModalMessage, 'Label is required.'); return; }
  if (!description) { setModalMsg(valueModalMessage, 'Description is required.'); return; }
  if (!VALUE_ICONS.some(i => i.id === valueModalIcon)) { setModalMsg(valueModalMessage, 'Choose an icon from the list.'); return; }

  valueModalSave.disabled = true;
  try {
    const payload = { label, description, icon: valueModalIcon, updated_at: new Date().toISOString() };
    const { data: { user } } = await supabase.auth.getUser();
    payload.updated_by = user?.id ?? null;

    if (editingValueId) {
      const { error } = await supabase.from('about_value').update(payload).eq('id', editingValueId);
      if (error) throw error;
      Object.assign(values.find(v => v.id === editingValueId), payload);
      await logAudit({ action: 'Updated Value', category: 'page_content', details: `Updated: ${label}`, entityId: editingValueId });
    } else {
      const nextSort = values.length ? Math.max(...values.map(v => v.sort_order)) + 1 : 0;
      const { data, error } = await supabase.from('about_value').insert({ ...payload, sort_order: nextSort }).select().single();
      if (error) throw error;
      values.push(data);
      await logAudit({ action: 'Added Value', category: 'page_content', details: `Added: ${label}`, entityId: data.id });
    }
    renderValues();
    closeModal(valueModal);
  } catch (err) {
    setModalMsg(valueModalMessage, `Failed to save: ${err.message}`);
  } finally {
    valueModalSave.disabled = false;
  }
});

document.getElementById('valueModalClose').addEventListener('click', () => closeModal(valueModal));
document.getElementById('valueModalCancel').addEventListener('click', () => closeModal(valueModal));
valueModal.addEventListener('click', e => { if (e.target === valueModal) closeModal(valueModal); });

async function toggleValueActive(id) {
  const value = values.find(v => v.id === id);
  if (!value) return;
  const nextActive = !value.is_active;
  const { error } = await supabase.from('about_value').update({ is_active: nextActive }).eq('id', id);
  if (error) { setMsg(valueMsg, `Failed: ${error.message}`, 'error'); return; }
  value.is_active = nextActive;
  renderValues();
}

async function moveValue(id, direction) {
  const idx = values.findIndex(v => v.id === id);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || swapIdx < 0 || swapIdx >= values.length) return;

  const a = values[idx];
  const b = values[swapIdx];
  const [aOrder, bOrder] = [a.sort_order, b.sort_order];

  try {
    await Promise.all([
      supabase.from('about_value').update({ sort_order: bOrder }).eq('id', a.id),
      supabase.from('about_value').update({ sort_order: aOrder }).eq('id', b.id)
    ]);
  } catch (err) {
    setMsg(valueMsg, `Failed to reorder: ${err.message}`, 'error');
    return;
  }

  a.sort_order = bOrder;
  b.sort_order = aOrder;
  values.sort((x, y) => x.sort_order - y.sort_order);
  renderValues();
}

function openConfirmRemoveValue(id) {
  const value = values.find(v => v.id === id);
  if (!value) return;
  pendingConfirmAction = { type: 'remove-value', id };
  confirmTitle.textContent = 'Remove Value';
  confirmCopy.textContent = `Remove "${value.label}" from the About page? This can't be undone.`;
  setModalMsg(confirmMessage, '');
  openModal(confirmModal);
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED CONFIRM MODAL
// ═══════════════════════════════════════════════════════════════════════════
confirmOk.addEventListener('click', async () => {
  if (!pendingConfirmAction) return;
  confirmOk.disabled = true;
  try {
    if (pendingConfirmAction.type === 'remove-gallery') {
      const img = galleryImages.find(g => g.id === pendingConfirmAction.id);
      const { error } = await supabase.from('gallery_image').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      if (img?.image_url) await destroyCloudinaryImage(supabase, img.image_url);
      galleryImages = galleryImages.filter(g => g.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed Gallery Image', category: 'page_content', details: `Removed: ${img?.caption || img?.image_url}`, entityId: pendingConfirmAction.id });
      renderGallery();
    } else if (pendingConfirmAction.type === 'remove-faq') {
      const faq = faqs.find(f => f.id === pendingConfirmAction.id);
      const { error } = await supabase.from('faq').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      faqs = faqs.filter(f => f.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed FAQ', category: 'page_content', details: `Removed: ${faq?.question}`, entityId: pendingConfirmAction.id });
      renderFaqs();
    } else if (pendingConfirmAction.type === 'remove-service') {
      const svc = services.find(s => s.id === pendingConfirmAction.id);
      const { error } = await supabase.from('landing_service').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      if (svc?.image_url) await destroyCloudinaryImage(supabase, svc.image_url);
      services = services.filter(s => s.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed Service', category: 'page_content', details: `Removed: ${svc?.title}`, entityId: pendingConfirmAction.id });
      renderServices();
    } else if (pendingConfirmAction.type === 'remove-menu-section') {
      const section = menuSections.find(m => m.id === pendingConfirmAction.id);
      const { error } = await supabase.from('menu_section').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      if (section?.image_url) await destroyCloudinaryImage(supabase, section.image_url);
      menuSections = menuSections.filter(m => m.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed Menu Image', category: 'page_content', details: `Removed: ${section?.heading}`, entityId: pendingConfirmAction.id });
      renderMenuSections();
    } else if (pendingConfirmAction.type === 'remove-value') {
      const value = values.find(v => v.id === pendingConfirmAction.id);
      const { error } = await supabase.from('about_value').delete().eq('id', pendingConfirmAction.id);
      if (error) throw error;
      values = values.filter(v => v.id !== pendingConfirmAction.id);
      await logAudit({ action: 'Removed Value', category: 'page_content', details: `Removed: ${value?.label}`, entityId: pendingConfirmAction.id });
      renderValues();
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

// ── KEYBOARD: Escape closes modals ──────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  [headerModal, galleryEditModal, aboutPreviewModal, faqModal, serviceModal, menuSectionModal, valueModal, confirmModal].forEach(m => {
    if (!m.classList.contains('hidden')) closeModal(m);
  });
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
