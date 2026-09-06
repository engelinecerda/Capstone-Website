// package_details.js — standalone Package Details page (package-details.html?id=...)
//
// The whole page is a scrolling sequence of full-width cards — gallery,
// At a Glance + price row, What's Included, Area Coverage (offsite only),
// Policies — no tabs. See renderGalleryHero, renderGlanceCard,
// renderInclusionsCard, renderAreaCard, renderPolicyCard. The lightbox is
// unaffected. This page still owns its own URL/fetch and loading/not-found
// states a toggled-visibility panel never needed.
import { customerSupabase as supabase } from './supabase.js';
import { loadReservationRules, loadPaymentRules } from './customer_payments.js';
import { optimizedImageUrl } from './cloudinary_optimized_image_delivery.js';

const CATEGORY_TABLE = 'package_category';
const PACKAGE_TABLE  = 'package';
const TIER_TABLE     = 'package_tier';
const PHOTO_TABLE    = 'package_photo';
const BADGE_TABLE    = 'badge';
const PACKAGE_BADGE_TABLE = 'package_badge';

let reservationRules = null;
let paymentRules = null;
let mostBookedPackageId = null;
let lightboxPhotos = [];
let lightboxIndex = 0;
let lightboxLastFocused = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const pkgdLoading  = document.getElementById('pkgdLoading');
const pkgdNotFound = document.getElementById('pkgdNotFound');
const pkgdContent  = document.getElementById('pkgdContent');

const pkgGalleryHero      = document.getElementById('pkgGalleryHero');
const pkgDetailCatTag     = document.getElementById('pkgDetailCatTag');
const pkgDetailMostBooked = document.getElementById('pkgDetailMostBooked');
const pkgAdminBadges = document.getElementById('pkgAdminBadges');
const pkgDetailName    = document.getElementById('pkgDetailName');
const pkgGlanceFacts   = document.getElementById('pkgGlanceFacts');
const pkgGlanceDesc    = document.getElementById('pkgGlanceDesc');
const pkgGlanceReadMore = document.getElementById('pkgGlanceReadMore');
const pkgDetailPricing = document.getElementById('pkgDetailPricing');
const pkgDetailBookBtn = document.getElementById('pkgDetailBookBtn');
const pkgInclusionsGrid = document.getElementById('pkgInclusionsGrid');
const pkgAreaCard      = document.getElementById('pkgAreaCard');
const pkgAreaContent   = document.getElementById('pkgAreaContent');
const pkgPolicyRows    = document.getElementById('pkgPolicyRows');

const pkgLightboxBackdrop = document.getElementById('pkgLightboxBackdrop');
const pkgLightboxImg      = document.getElementById('pkgLightboxImg');
const pkgLightboxCounter  = document.getElementById('pkgLightboxCounter');
const pkgLightboxClose    = document.getElementById('pkgLightboxClose');
const pkgLightboxPrev     = document.getElementById('pkgLightboxPrev');
const pkgLightboxNext     = document.getElementById('pkgLightboxNext');

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function parseItemList(text) {
  if (!text || !text.trim()) return [];
  let items = text.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
  if (items.length === 1) {
    const byComma = items[0].split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (byComma.length > 1 && byComma.every(s => s.length < 60)) items = byComma;
  }
  return items.map(s => s.replace(/^[-•*·]\s*/, '').trim()).filter(s => s.length > 0);
}

// Simple two-column flat checklist — a single green checkmark per item,
// replacing the old varied-icon tile grid.
function buildChecklist(items) {
  if (!items.length) return '';
  return `<div class="pkg-checklist">${
    items.map(item => `
      <div class="pkg-checklist-item">
        <i class="ti ti-check" aria-hidden="true"></i>
        <span>${esc(item)}</span>
      </div>`).join('')
  }</div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// LOAD
// ══════════════════════════════════════════════════════════════════════════════
async function init() {
  const packageId = new URLSearchParams(window.location.search).get('id');
  if (!packageId) {
    showNotFound();
    return;
  }

  try {
    [reservationRules, paymentRules] = await Promise.all([
      loadReservationRules(supabase),
      loadPaymentRules(supabase)
    ]);

    const { data: pkg, error: pkgErr } = await supabase
      .from(PACKAGE_TABLE)
      .select('*')
      .eq('package_id', packageId)
      .eq('is_active', true)
      .maybeSingle();
    if (pkgErr || !pkg) {
      showNotFound();
      return;
    }

    let categoryName = '';
    if (pkg.package_category_id) {
      const { data: cat } = await supabase
        .from(CATEGORY_TABLE)
        .select('category_name')
        .eq('package_category_id', pkg.package_category_id)
        .maybeSingle();
      categoryName = cat?.category_name || '';
    }

    const [{ data: photos }, { data: tiers }] = await Promise.all([
      supabase.from(PHOTO_TABLE)
        .select('package_id, image_url, alt_text, is_cover, sort_order')
        .eq('package_id', packageId)
        .order('sort_order', { ascending: true }),
      supabase.from(TIER_TABLE)
        .select('*')
        .eq('package_id', packageId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
    ]);

    pkg._categoryName = categoryName;
    pkg._photos = (photos || []).map(ph => ({ ...ph, image_url: optimizedImageUrl(ph.image_url) }));
    pkg._tiers = tiers || [];
    pkg._badges = await fetchBadgesForPackage(packageId);

    await resolveMostBooked(packageId);
    renderPackageDetail(pkg);
    hide(pkgdLoading);
    show(pkgdContent);
  } catch (err) {
    showNotFound();
  }
}

// Same global, tie/zero-suppressed "Most Booked" scope as the listing page:
// winner across ALL active, non-add-on packages, computed from the same
// reservation-derived RPC — we only need to know if THIS package is it.
async function resolveMostBooked(packageId) {
  try {
    const [{ data: activeIds }, { data: counts }] = await Promise.all([
      supabase.from(PACKAGE_TABLE).select('package_id').eq('is_active', true).neq('package_type', 'add on'),
      supabase.rpc('get_package_booking_counts')
    ]);
    const idSet = new Set((activeIds || []).map(r => r.package_id));
    const countMap = {};
    (counts || []).forEach(row => { if (idSet.has(row.package_id)) countMap[row.package_id] = row.booking_count || 0; });

    let maxCount = 0;
    let leaders = [];
    idSet.forEach(id => {
      const c = countMap[id] || 0;
      if (c > maxCount) { maxCount = c; leaders = [id]; }
      else if (c === maxCount && c > 0) { leaders.push(id); }
    });
    mostBookedPackageId = (maxCount > 0 && leaders.length === 1) ? leaders[0] : null;
  } catch {
    mostBookedPackageId = null;
  }
}

// Admin-assigned badges (e.g. "Best Value") — manually set via Bookable
// Inventory, independent of the real booking-count-derived Most Booked chip.
async function fetchBadgesForPackage(packageId) {
  try {
    const { data: assignedRows } = await supabase
      .from(PACKAGE_BADGE_TABLE)
      .select('badge_id')
      .eq('package_id', packageId);
    if (!assignedRows || !assignedRows.length) return [];

    const { data: badgeDefs } = await supabase
      .from(BADGE_TABLE)
      .select('badge_id, label, variant, sort_order')
      .eq('is_active', true)
      .in('badge_id', assignedRows.map(r => r.badge_id));

    return (badgeDefs || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  } catch {
    return [];
  }
}

function showNotFound() {
  hide(pkgdLoading);
  hide(pkgdContent);
  show(pkgdNotFound);
}

// ══════════════════════════════════════════════════════════════════════════════
// RENDER — identical to the old selectPackage()
// ══════════════════════════════════════════════════════════════════════════════
function renderPackageDetail(pkg) {
  renderGalleryHero(pkg);

  pkgDetailCatTag.textContent = pkg._categoryName || '';
  pkgDetailName.textContent   = pkg.package_name || '';
  document.title = `${pkg.package_name || 'Package'} — ELI Coffee Events Cafe`;

  pkgAdminBadges.innerHTML = (pkg._badges || []).map(b =>
    `<span class="pkg-admin-badge pkg-admin-badge--${esc(b.variant || 'neutral')}">${esc(b.label)}</span>`
  ).join('');

  if (pkg.package_id && pkg.package_id === mostBookedPackageId) show(pkgDetailMostBooked);
  else hide(pkgDetailMostBooked);

  const loc = (pkg.location_type || '').toLowerCase();

  renderGlanceCard(pkg, loc);

  const price = Number(pkg.price || 0);
  pkgDetailPricing.innerHTML = price > 0
    ? `<p class="pkg-detail-price">₱${price.toLocaleString()}</p>
       <p class="pkg-detail-price-note">Inclusive of setup</p>`
    : `<p class="pkg-detail-price pkg-detail-price--contact">Contact for Quote</p>
       <p class="pkg-detail-price-note">Customized pricing available</p>`;

  if (pkgDetailBookBtn) {
    pkgDetailBookBtn.href = pkg.package_id
      ? `/reservations.html?package=${encodeURIComponent(pkg.package_id)}`
      : '/reservations.html';
  }

  renderInclusionsCard(pkg);

  if (loc === 'offsite') {
    pkgAreaContent.innerHTML = buildAreaContent();
    show(pkgAreaCard);
  } else {
    hide(pkgAreaCard);
  }

  renderPolicyCard(pkg, loc);
}

// ─── Gallery hero + lightbox ──────────────────────────────────────────────────
function renderGalleryHero(pkg) {
  const photos = (pkg._photos || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const name = pkg.package_name || 'Package';

  if (!photos.length) {
    pkgGalleryHero.className = 'pkg-gallery-hero pkg-gallery-hero--empty';
    pkgGalleryHero.innerHTML = `<div class="pkg-gallery-placeholder"><i class="ti ti-photo" aria-hidden="true"></i><span>No photos yet for this package</span></div>`;
    return;
  }

  const count = photos.length;
  const layoutClass = count === 1 ? 'pkg-gallery-hero--single'
    : count === 2 ? 'pkg-gallery-hero--double'
    : count === 3 ? 'pkg-gallery-hero--triple'
    : count === 4 ? 'pkg-gallery-hero--quad'
    : 'pkg-gallery-hero--five-plus';

  pkgGalleryHero.className = `pkg-gallery-hero ${layoutClass}`;

  const visible = photos.slice(0, 5);

  const tilesHtml = visible.map((ph, i) => `
    <button type="button" class="pkg-gallery-tile" data-index="${i}" aria-label="View photo ${i + 1} of ${count} for ${esc(name)}">
      <img src="${esc(ph.image_url)}" alt="${esc(ph.alt_text || `${name} photo ${i + 1}`)}" loading="${i === 0 ? 'eager' : 'lazy'}">
    </button>`).join('');

  // A single photo has nothing to "gallery-browse" — badge only shows once
  // there's more than one image to page through in the lightbox.
  const badgeHtml = count > 1
    ? `<button type="button" class="pkg-gallery-badge" aria-label="View all ${count} photos for ${esc(name)}">
         <i class="ti ti-photo" aria-hidden="true"></i> Gallery (${count})
       </button>`
    : '';

  pkgGalleryHero.innerHTML = tilesHtml + badgeHtml;

  pkgGalleryHero.querySelectorAll('.pkg-gallery-tile').forEach(tile => {
    tile.addEventListener('click', () => openLightbox(photos, Number(tile.dataset.index), name));
  });
  pkgGalleryHero.querySelector('.pkg-gallery-badge')?.addEventListener('click', () => openLightbox(photos, 0, name));
}

function openLightbox(photos, index, name) {
  lightboxPhotos = photos;
  lightboxIndex = index;
  lightboxLastFocused = document.activeElement;
  renderLightboxFrame(name);
  show(pkgLightboxBackdrop);
  pkgLightboxBackdrop.setAttribute('aria-hidden', 'false');
  pkgLightboxClose.focus();
}
function closeLightbox() {
  hide(pkgLightboxBackdrop);
  pkgLightboxBackdrop.setAttribute('aria-hidden', 'true');
  if (lightboxLastFocused?.focus) lightboxLastFocused.focus();
}
function renderLightboxFrame(name) {
  const photo = lightboxPhotos[lightboxIndex];
  if (!photo) return;
  pkgLightboxImg.src = photo.image_url;
  pkgLightboxImg.alt = photo.alt_text || `${name || 'Package'} photo ${lightboxIndex + 1}`;
  pkgLightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxPhotos.length}`;
}
function lightboxStep(delta) {
  if (!lightboxPhotos.length) return;
  lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length;
  renderLightboxFrame(pkgDetailName.textContent);
}

pkgLightboxClose?.addEventListener('click', closeLightbox);
pkgLightboxPrev?.addEventListener('click', () => lightboxStep(-1));
pkgLightboxNext?.addEventListener('click', () => lightboxStep(1));
pkgLightboxBackdrop?.addEventListener('click', e => { if (e.target === pkgLightboxBackdrop) closeLightbox(); });
document.addEventListener('keydown', e => {
  if (pkgLightboxBackdrop.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
  else if (e.key === 'ArrowRight') lightboxStep(1);
});

let lightboxTouchStartX = null;
pkgLightboxBackdrop?.addEventListener('touchstart', e => { lightboxTouchStartX = e.touches[0].clientX; }, { passive: true });
pkgLightboxBackdrop?.addEventListener('touchend', e => {
  if (lightboxTouchStartX === null) return;
  const delta = e.changedTouches[0].clientX - lightboxTouchStartX;
  if (Math.abs(delta) > 40) lightboxStep(delta < 0 ? 1 : -1);
  lightboxTouchStartX = null;
}, { passive: true });

// ─── "At a Glance" card — quick facts + expandable description ──────────────
function renderGlanceCard(pkg, loc) {
  const facts = [];
  if (pkg.guest_capacity) {
    facts.push({ icon: 'ti-users', text: `Up to ${pkg.guest_capacity} guests` });
  }
  if (pkg.duration_hours) {
    facts.push({ icon: 'ti-clock', text: `${pkg.duration_hours} hour${pkg.duration_hours !== 1 ? 's' : ''} (approx.)` });
  }
  if (loc) {
    facts.push({ icon: 'ti-map-pin', text: loc === 'offsite' ? 'Offsite' : 'Onsite' });
  }
  pkgGlanceFacts.innerHTML = facts.map(f => `
    <div class="pkg-glance-fact">
      <i class="ti ${f.icon}" aria-hidden="true"></i>
      <span>${esc(f.text)}</span>
    </div>`).join('');

  const description = (pkg.description || '').trim() || 'No description available for this package.';
  pkgGlanceDesc.textContent = description;
  pkgGlanceDesc.classList.add('pkg-glance-desc--clamped');
  pkgGlanceReadMore.setAttribute('aria-expanded', 'false');
  pkgGlanceReadMore.textContent = 'Read more';
  hide(pkgGlanceReadMore);

  // Only offer the toggle if the text actually overflows the 3-line clamp —
  // checked post-paint since it depends on the rendered width/line count,
  // not just a character-count guess.
  requestAnimationFrame(() => {
    if (pkgGlanceDesc.scrollHeight > pkgGlanceDesc.clientHeight + 1) {
      show(pkgGlanceReadMore);
    }
  });
}

pkgGlanceReadMore?.addEventListener('click', () => {
  const expanded = pkgGlanceReadMore.getAttribute('aria-expanded') === 'true';
  pkgGlanceDesc.classList.toggle('pkg-glance-desc--clamped', expanded);
  pkgGlanceReadMore.setAttribute('aria-expanded', String(!expanded));
  pkgGlanceReadMore.textContent = expanded ? 'Read more' : 'Read less';
});

// ─── What's Included card ─────────────────────────────────────────────────────
function renderInclusionsCard(pkg) {
  if (pkg._tiers && pkg._tiers.length > 0) {
    pkgInclusionsGrid.innerHTML = pkg._tiers.map(tier => {
      const items = parseItemList(tier.tier_full_inclusions || '');
      return `
        <div class="pkg-tier-block">
          <div class="pkg-tier-head">
            <p class="pkg-tier-name">${esc(tier.tier_name)}</p>
            ${tier.tier_subtitle ? `<p class="pkg-tier-sub">${esc(tier.tier_subtitle)}</p>` : ''}
          </div>
          ${items.length ? buildChecklist(items) : '<p class="pkg-section-empty">No inclusions listed for this tier.</p>'}
        </div>`;
    }).join('');
    return;
  }

  const items = Array.isArray(pkg.inclusions) && pkg.inclusions.length
    ? pkg.inclusions
    : parseItemList(pkg.description || '');
  pkgInclusionsGrid.innerHTML = items.length
    ? buildChecklist(items)
    : `<p class="pkg-section-empty">Inclusions are provided upon inquiry. Please contact us for details.</p>`;
}

// ─── Area Coverage card (offsite packages only) ──────────────────────────────
function buildAreaContent() {
  return `
    <div class="pkg-area-note">
      <i class="ti ti-info-circle" aria-hidden="true"></i>
      <p>This is an offsite service — our team travels to your chosen venue. Travel rates are based on distance from ELI Coffee Binangonan. Contact us to confirm availability and the applicable rate for your location.</p>
    </div>
    <div class="pkg-area-cards">
      <div class="pkg-area-card">
        <i class="ti ti-map-pin" aria-hidden="true"></i>
        <div>
          <p class="pkg-area-loc">Rizal Area</p>
          <p class="pkg-area-note-text">Less than 10km from ELI Coffee Binangonan</p>
        </div>
      </div>
      <div class="pkg-area-card">
        <i class="ti ti-map-2" aria-hidden="true"></i>
        <div>
          <p class="pkg-area-loc">Out of Town Area</p>
          <p class="pkg-area-note-text">11km and above from ELI Coffee Binangonan</p>
        </div>
      </div>
    </div>`;
}

// ─── Policies card — structured rows from real system_settings + this
// package's own price/location_type/extension_price ──────────────────────────
function renderPolicyCard(pkg, loc) {
  const rows = [];

  const depositPct = reservationRules?.deposit_pct;
  if (depositPct != null) {
    const amount = Math.round(Number(pkg.price || 0) * (depositPct / 100));
    rows.push({
      icon: 'ti-file-text',
      label: 'Downpayment required',
      value: `${depositPct}% (₱${amount.toLocaleString()})`
    });
  }

  const cancelFee = loc === 'offsite' ? paymentRules?.cancellation_fee_offsite : paymentRules?.cancellation_fee_onsite;
  const cancelWindow = paymentRules?.cancellation_request_window_days;
  if (cancelFee != null && cancelWindow != null) {
    rows.push({
      icon: 'ti-calendar-x',
      label: 'Cancellation fee',
      value: `₱${Number(cancelFee).toLocaleString()} within ${cancelWindow} day${cancelWindow !== 1 ? 's' : ''} of event`
    });
  }

  const rescheduleFee = paymentRules?.reschedule_fee;
  if (rescheduleFee != null) {
    rows.push({
      icon: 'ti-calendar-repeat',
      label: 'Reschedule fee',
      value: `₱${Number(rescheduleFee).toLocaleString()}, subject to availability`
    });
  }

  const extensionPrice = Number(pkg.extension_price || 0);
  if (extensionPrice > 0) {
    rows.push({
      icon: 'ti-clock',
      label: 'Duration & extensions',
      value: `₱${extensionPrice.toLocaleString()} per additional hour`
    });
  }

  pkgPolicyRows.innerHTML = rows.map(r => `
    <div class="pkg-policy-row">
      <div class="pkg-policy-row-label"><i class="ti ${r.icon}" aria-hidden="true"></i><span>${esc(r.label)}</span></div>
      <span class="pkg-policy-row-value">${esc(r.value)}</span>
    </div>`).join('');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
init();
