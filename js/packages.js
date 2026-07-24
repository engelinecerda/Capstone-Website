// packages.js — Customer-facing packages page
// Inline flow: category tabs → overview → pricing cards → detail panel

import { customerSupabase as supabase } from './supabase.js';

const CATEGORY_TABLE = 'package_category';
const PACKAGE_TABLE  = 'package';
const TIER_TABLE     = 'package_tier';

// ─── State ───────────────────────────────────────────────────────────────────
let allCategories      = [];
let packageCountMap    = {};
let selectedCategoryId = null;
let selectedPackageId  = null;
let allPackagesCache   = [];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const sectionCategories = document.getElementById('section-categories');
const sectionOverview   = document.getElementById('section-overview');
const sectionOptions    = document.getElementById('section-options');
const sectionDetail     = document.getElementById('section-detail');

const pkgCatLoading  = document.getElementById('pkgCatLoading');
const pkgCatError    = document.getElementById('pkgCatError');
const pkgCatErrorMsg = document.getElementById('pkgCatErrorMsg');
const pkgCatEmpty    = document.getElementById('pkgCatEmpty');
const pkgCatGrid     = document.getElementById('pkgCatGrid');
const pkgRetryBtn    = document.getElementById('pkgRetryBtn');

const ovName         = document.getElementById('ovName');
const ovDesc         = document.getElementById('ovDesc');
const ovInclSection  = document.getElementById('ovInclSection');
const ovHighlights   = document.getElementById('ovHighlights');
const ovInfoCardWrap = document.getElementById('ovInfoCardWrap');
const ovInfoCardBody = document.getElementById('ovInfoCardBody');

const optTitle        = document.getElementById('optTitle');
const pkgOptLoading   = document.getElementById('pkgOptLoading');
const pkgOptEmpty     = document.getElementById('pkgOptEmpty');
const pkgMainGrid     = document.getElementById('pkgMainGrid');
const pkgAddonSection = document.getElementById('pkgAddonSection');
const pkgAddonGrid    = document.getElementById('pkgAddonGrid');

const pkgDetailCatTag  = document.getElementById('pkgDetailCatTag');
const pkgDetailName    = document.getElementById('pkgDetailName');
const pkgDetailPills   = document.getElementById('pkgDetailPills');
const pkgDetailPricing = document.getElementById('pkgDetailPricing');
const pkgDetailBookBtn = document.getElementById('pkgDetailBookBtn');
const pkgDetailClose   = document.getElementById('pkgDetailClose');
const pkgTabs          = document.getElementById('pkgTabs');
const tabAreaCoverage  = document.getElementById('tabAreaCoverage');
const panelOverview    = document.getElementById('panelOverview');
const panelInclusions  = document.getElementById('panelInclusions');
const panelArea        = document.getElementById('panelArea');
const panelPolicies    = document.getElementById('panelPolicies');

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

function smoothScrollTo(el, offset = 80) {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top, behavior: 'smooth' });
}

// ─── Category keyword → icon map ─────────────────────────────────────────────
function getCategoryIcon(name) {
  const n = (name || '').toLowerCase();
  if (/coffee.*bar|coffee/i.test(n)) return 'ti-coffee';
  if (/snack.*bar|snack/i.test(n))   return 'ti-cookie';
  if (/gather|private/i.test(n))     return 'ti-users';
  if (/cater/i.test(n))              return 'ti-tools-kitchen-2';
  if (/all.?in/i.test(n))            return 'ti-stars';
  if (/grazing/i.test(n))            return 'ti-grape';
  return 'ti-package';
}

// ─── Inclusion keyword → icon map ────────────────────────────────────────────
const ICON_MAP = [
  { test: /transport|delivery|truck/i,                  icon: 'ti-truck-delivery' },
  { test: /table|setup|preparation/i,                   icon: 'ti-table' },
  { test: /barista|staff|crew|team|personnel/i,         icon: 'ti-users' },
  { test: /\bserving\b|\bcup\b/i,                       icon: 'ti-cup' },
  { test: /tasting|espresso|brew|americano|latte/i,     icon: 'ti-coffee' },
  { test: /coffee/i,                                    icon: 'ti-coffee' },
  { test: /hot|iced|temperature/i,                      icon: 'ti-cup-hot' },
  { test: /hall|venue|room|space|lounge|building/i,     icon: 'ti-building' },
  { test: /lights?|led|bulb|lamp|sound|audio|speaker/i, icon: 'ti-speakerphone' },
  { test: /decor|styling|accent|balloon/i,              icon: 'ti-sparkles' },
  { test: /flower|floral|bouquet/i,                     icon: 'ti-flower' },
  { test: /photobooth|photograph|camera/i,              icon: 'ti-camera' },
  { test: /backdrop|banner|signage/i,                   icon: 'ti-photo' },
  { test: /buffet|catering|meal|food|dish|menu|rice/i,  icon: 'ti-tools-kitchen-2' },
  { test: /drink|beverage|juice|water/i,                icon: 'ti-glass' },
  { test: /dessert|cake|pastry|sweet|chocolate/i,       icon: 'ti-cake' },
  { test: /coordinator|organizer/i,                     icon: 'ti-user-star' },
  { test: /wifi|internet/i,                             icon: 'ti-wifi' },
  { test: /projector|screen/i,                          icon: 'ti-device-projector' },
  { test: /snack/i,                                     icon: 'ti-cookie' },
  { test: /contract|document/i,                         icon: 'ti-file-text' },
];

function getInclusionIcon(text) {
  for (const { test, icon } of ICON_MAP) {
    if (test.test(text)) return icon;
  }
  return 'ti-check';
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function parseItemList(text) {
  if (!text || !text.trim()) return [];
  let items = text.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
  if (items.length === 1) {
    const byComma = items[0].split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (byComma.length > 1 && byComma.every(s => s.length < 60)) items = byComma;
  }
  return items.map(s => s.replace(/^[-•*·]\s*/, '').trim()).filter(s => s.length > 0);
}

// Compact icon-row list for the category overview "What's included" summary.
// Max 6 items; shows a "+N more" label if the category has additional inclusions.
// Two-column layout so the card doesn't become a wall of tiles.
function buildOverviewInclList(items) {
  if (!items.length) return '';
  const visible = items.slice(0, 6);
  const overflow = items.length - visible.length;
  const rows = visible.map(item => `
    <div class="pkg-ov-incl-row">
      <i class="ti ${esc(getInclusionIcon(item))}"></i>
      <span>${esc(item)}</span>
    </div>`).join('');
  const more = overflow > 0
    ? `<p class="pkg-ov-incl-more">+${overflow} more included — see package details</p>`
    : '';
  return `<div class="pkg-ov-incl-list">${rows}</div>${more}`;
}

// Icon tile grid — used in the detail panel Inclusions tab (full, browsable view)
function buildTileGrid(items) {
  if (!items.length) return '';
  return `<div class="pkg-incl-grid">${
    items.map(item => `
      <div class="pkg-incl-tile">
        <i class="ti ${esc(getInclusionIcon(item))}"></i>
        <span>${esc(item)}</span>
      </div>`).join('')
  }</div>`;
}

function buildFlatList(items) {
  if (!items.length) return '';
  return `<ul class="pkg-incl-flat">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — LOAD & RENDER CATEGORY TABS
// ══════════════════════════════════════════════════════════════════════════════
async function loadCategories() {
  show(pkgCatLoading);
  hide(pkgCatError);
  hide(pkgCatEmpty);
  hide(pkgCatGrid);

  try {
    const { data: cats, error: catErr } = await supabase
      .from(CATEGORY_TABLE)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });
    if (catErr) throw catErr;

    if (!cats || cats.length === 0) {
      hide(pkgCatLoading);
      show(pkgCatEmpty);
      return;
    }

    // Batch-fetch package counts
    const { data: countRows } = await supabase
      .from(PACKAGE_TABLE)
      .select('package_category_id')
      .eq('is_active', true);

    packageCountMap = {};
    (countRows || []).forEach(r => {
      if (r.package_category_id)
        packageCountMap[r.package_category_id] = (packageCountMap[r.package_category_id] || 0) + 1;
    });

    // A category whose products are all inactive shouldn't appear in the
    // catalogue — filter on live package counts, not just the category's
    // own is_active flag.
    const visibleCats = cats.filter(c => (packageCountMap[c.package_category_id] || 0) > 0);
    allCategories = visibleCats;

    if (!visibleCats.length) {
      hide(pkgCatLoading);
      show(pkgCatEmpty);
      return;
    }

    renderCategoryGrid(visibleCats);
    hide(pkgCatLoading);
    show(pkgCatGrid);

    // Auto-select first category without scrolling (data loads immediately on page open)
    selectCategory(visibleCats[0], { scroll: false });

  } catch (err) {
    console.error('loadCategories:', err);
    hide(pkgCatLoading);
    show(pkgCatError);
    if (pkgCatErrorMsg) pkgCatErrorMsg.textContent = 'Unable to load packages right now. Please try again.';
  }
}

function buildCategoryCard(cat) {
  const name       = cat.category_name || '';
  const count      = packageCountMap[cat.package_category_id] || 0;
  const countLabel = count === 1 ? '1 package' : `${count} packages`;
  const icon       = getCategoryIcon(name);

  return `
    <div class="pkg-cat-card" data-cat-id="${esc(cat.package_category_id)}"
         role="button" tabindex="0" aria-label="View ${esc(name)} packages">
      <div class="pkg-cat-check"><i class="ti ti-check"></i></div>
      <i class="ti ${esc(icon)} pkg-cat-icon"></i>
      <p class="pkg-cat-name">${esc(name)}</p>
      <p class="pkg-cat-count">${esc(countLabel)}</p>
    </div>`;
}

function renderCategoryGrid(cats) {
  pkgCatGrid.innerHTML = cats.map(buildCategoryCard).join('');

  pkgCatGrid.querySelectorAll('.pkg-cat-card').forEach(card => {
    const handler = () => {
      const cat = allCategories.find(c => c.package_category_id === card.dataset.catId);
      if (cat) selectCategory(cat, { scroll: true });
    };
    card.addEventListener('click', handler);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — CATEGORY OVERVIEW
// ══════════════════════════════════════════════════════════════════════════════
function selectCategory(cat, { scroll = true } = {}) {
  selectedCategoryId = cat.package_category_id;
  selectedPackageId  = null;

  pkgCatGrid.querySelectorAll('.pkg-cat-card').forEach(el =>
    el.classList.toggle('active', el.dataset.catId === selectedCategoryId));

  // Left card: name + description + inclusions icon grid
  ovName.textContent = cat.category_name || '';
  ovDesc.textContent = cat.description  || '';

  const inclItems = parseItemList(cat.package_category_inclusions || '');
  if (inclItems.length) {
    ovHighlights.innerHTML = buildOverviewInclList(inclItems);
    show(ovInclSection);
  } else {
    ovHighlights.innerHTML = '';
    hide(ovInclSection);
  }

  show(sectionOverview);
  show(sectionOptions);
  hide(sectionDetail);

  optTitle.textContent = `${cat.category_name || ''} packages`;

  if (scroll) smoothScrollTo(sectionOverview, 88);

  loadPackages(cat.package_category_id, cat.category_name || '');
}

// Right card — always shown; bottom row adapts to onsite vs offsite vs mixed.
// Onsite: venue address. Offsite: area coverage. Mixed: area coverage (travel is the key detail).
function buildInfoCard(pkgs) {
  const locationTypes = [...new Set(pkgs.map(p => p.location_type).filter(Boolean))];
  const hasOffsite    = locationTypes.includes('offsite');
  const hasOnsite     = locationTypes.includes('onsite');

  const durations  = pkgs.map(p => Number(p.duration_hours)).filter(d => d > 0);
  const minDur     = durations.length ? Math.min(...durations) : null;
  const maxDur     = durations.length ? Math.max(...durations) : null;
  const capacities = pkgs.map(p => Number(p.guest_capacity)).filter(c => c > 0);
  const maxCap     = capacities.length ? Math.max(...capacities) : null;

  let locationLabel = '';
  if (hasOnsite && hasOffsite) locationLabel = 'Onsite &amp; Offsite';
  else if (hasOffsite)          locationLabel = 'Offsite — we come to you';
  else if (hasOnsite)           locationLabel = 'At our venue';

  let html = '';

  if (locationLabel) {
    html += `<div class="pkg-svc-row">
      <i class="ti ti-map-pin"></i>
      <div><p class="pkg-svc-label">Location</p><p class="pkg-svc-value">${locationLabel}</p></div>
    </div>`;
  }

  if (minDur !== null) {
    const durLabel = minDur === maxDur
      ? `${minDur} hour${minDur !== 1 ? 's' : ''}`
      : `${minDur}–${maxDur} hours`;
    html += `<div class="pkg-svc-row">
      <i class="ti ti-clock"></i>
      <div><p class="pkg-svc-label">Duration</p><p class="pkg-svc-value">${durLabel}</p></div>
    </div>`;
  }

  if (maxCap !== null) {
    html += `<div class="pkg-svc-row">
      <i class="ti ti-users"></i>
      <div><p class="pkg-svc-label">Guest capacity</p><p class="pkg-svc-value">Up to ${maxCap} guests</p></div>
    </div>`;
  }

  html += `<hr class="pkg-svc-divider" />`;

  if (hasOffsite) {
    // Offsite or mixed: official distance zones from ELI Coffee Binangonan
    html += `<div class="pkg-svc-row">
      <i class="ti ti-map-2"></i>
      <div><p class="pkg-svc-label">Area coverage</p>
      <p class="pkg-svc-value">Rizal Area — within 10km<br>Out of Town — 11km and above</p></div>
    </div>`;
  } else {
    // Onsite-only: show the venue so customers know where they're going
    html += `<div class="pkg-svc-row">
      <i class="ti ti-building"></i>
      <div><p class="pkg-svc-label">Our venue</p>
      <p class="pkg-svc-value">ELI Coffee Events Cafe<br>Binangonan, Rizal &amp; Antipolo City</p></div>
    </div>`;
  }

  ovInfoCardBody.innerHTML = html;
  show(ovInfoCardWrap);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — PACKAGE PRICING CARDS
// ══════════════════════════════════════════════════════════════════════════════
async function loadPackages(categoryId, categoryName) {
  pkgMainGrid.innerHTML  = '';
  pkgAddonGrid.innerHTML = '';
  hide(pkgAddonSection);
  hide(pkgOptEmpty);
  show(pkgOptLoading);
  hide(sectionDetail);

  try {
    const { data: pkgs, error: pkgErr } = await supabase
      .from(PACKAGE_TABLE)
      .select('*')
      .eq('package_category_id', categoryId)
      .eq('is_active', true)
      .order('price', { ascending: true });
    if (pkgErr) throw pkgErr;

    if (!pkgs || pkgs.length === 0) {
      hide(pkgOptLoading);
      show(pkgOptEmpty);
      return;
    }

    // Batch-fetch tiers
    const packageIds = pkgs.map(p => p.package_id);
    let tierMap = {};
    try {
      const { data: tiers } = await supabase
        .from(TIER_TABLE)
        .select('*')
        .in('package_id', packageIds)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      (tiers || []).forEach(t => {
        if (!tierMap[t.package_id]) tierMap[t.package_id] = [];
        tierMap[t.package_id].push(t);
      });
    } catch { /* tiers optional */ }

    pkgs.forEach(p => { p._tiers = tierMap[p.package_id] || []; });
    allPackagesCache = pkgs;

    const mainPkgs  = pkgs.filter(p => p.package_type !== 'add on');
    const addonPkgs = pkgs.filter(p => p.package_type === 'add on');

    // Identify the highest-priced main package for the "Best value" badge.
    // Excludes contact-for-quote packages (price = 0) so the badge is only
    // shown when there's an actual price to justify the tier recommendation.
    const displayPkgs   = mainPkgs.length ? mainPkgs : pkgs;
    const highestPrice  = Math.max(...displayPkgs.map(p => Number(p.price) || 0));
    pkgMainGrid.innerHTML = displayPkgs
      .map(p => buildPackageCard(p, categoryName, highestPrice > 0 && Number(p.price) === highestPrice))
      .join('');

    if (addonPkgs.length > 0) {
      pkgAddonGrid.innerHTML = addonPkgs.map(p => buildPackageCard(p, categoryName)).join('');
      show(pkgAddonSection);
    }

    buildInfoCard(pkgs);
    wirePackageCards();
    hide(pkgOptLoading);

  } catch (err) {
    console.error('loadPackages:', err);
    hide(pkgOptLoading);
    pkgMainGrid.innerHTML = `<p style="color:#b91c1c;font-size:14px">Failed to load packages. Please try again.</p>`;
  }
}

function buildPackageCard(pkg, categoryName, isBest = false) {
  const name     = pkg.package_name || 'Package';
  const price    = Number(pkg.price || 0);
  const loc      = (pkg.location_type || '').toLowerCase();
  const locLabel = loc === 'offsite' ? 'Offsite' : loc === 'onsite' ? 'Onsite' : '';

  const locBadge = locLabel
    ? `<span class="pkg-card-loc-badge pkg-card-loc-badge--${loc}">${esc(locLabel)}</span>`
    : `<span></span>`;

  // "Best value" badge — positioned absolutely at top-right of card, sits in
  // the card's top padding area so it doesn't displace any content below it.
  const bestBadge = isBest
    ? `<span class="pkg-card-best-badge" aria-label="Best value package">Best value</span>`
    : '';

  const pills = [];
  if (pkg.guest_capacity) pills.push(`<span class="pkg-pill"><i class="ti ti-users"></i>${pkg.guest_capacity} guests</span>`);
  if (pkg.duration_hours) pills.push(`<span class="pkg-pill"><i class="ti ti-clock"></i>${pkg.duration_hours} hr${pkg.duration_hours !== 1 ? 's' : ''}</span>`);
  // Always render the pills container — even when empty it reserves consistent
  // vertical space so all cards in the same row share the same pill-row height.
  const pillsHtml = `<div class="pkg-card-pills">${pills.join('')}</div>`;

  // Always render pkg-card-price-note so every card has the border-bottom zone
  // separator between the price block and the pills/actions below it.
  const priceHtml = price > 0
    ? `<p class="pkg-card-price">₱${price.toLocaleString()}</p>
       <p class="pkg-card-price-note">Starting price</p>`
    : `<p class="pkg-card-price pkg-card-price--contact">Contact for quote</p>
       <p class="pkg-card-price-note">Custom pricing</p>`;

  return `
    <div class="pkg-card${isBest ? ' pkg-card--best' : ''}" data-pkg-id="${esc(pkg.package_id)}" data-cat-name="${esc(categoryName || '')}">
      ${bestBadge}
      <div class="pkg-card-body">
        <div class="pkg-card-top-row">
          ${locBadge}
        </div>
        <h4 class="pkg-card-name">${esc(name)}</h4>
        ${priceHtml}
        ${pillsHtml}
        <div class="pkg-card-actions">
          <button class="pkg-card-btn-details" data-action="view" aria-label="View details for ${esc(name)}">Details</button>
          <a href="/reservations.html${pkg.package_id ? '?package=' + esc(pkg.package_id) : ''}" class="pkg-card-btn-book" aria-label="Book ${esc(name)}">
            Book
          </a>
        </div>
      </div>
    </div>`;
}

function wirePackageCards() {
  [pkgMainGrid, pkgAddonGrid].forEach(grid => {
    grid.querySelectorAll('.pkg-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.pkg-card-actions')) return;
        triggerDetail(card.dataset.pkgId, card.dataset.catName);
      });
      card.querySelector('[data-action="view"]')?.addEventListener('click', e => {
        e.stopPropagation();
        triggerDetail(card.dataset.pkgId, card.dataset.catName);
      });
    });
  });
}

function triggerDetail(pkgId, catName) {
  const pkg = allPackagesCache.find(p => p.package_id === pkgId);
  if (pkg) selectPackage(pkg, catName);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PACKAGE DETAIL PANEL
// ══════════════════════════════════════════════════════════════════════════════
function selectPackage(pkg, catName) {
  selectedPackageId = pkg.package_id;

  [pkgMainGrid, pkgAddonGrid].forEach(grid =>
    grid.querySelectorAll('.pkg-card').forEach(c =>
      c.classList.toggle('selected', c.dataset.pkgId === selectedPackageId)));

  // Header — left
  pkgDetailCatTag.textContent = catName || '';
  pkgDetailName.textContent   = pkg.package_name || '';

  const loc   = (pkg.location_type || '').toLowerCase();
  const pills = [];
  if (pkg.guest_capacity) pills.push(`<span class="pkg-pill"><i class="ti ti-users"></i>${pkg.guest_capacity} guests</span>`);
  if (pkg.duration_hours) pills.push(`<span class="pkg-pill"><i class="ti ti-clock"></i>${pkg.duration_hours} hr${pkg.duration_hours !== 1 ? 's' : ''}</span>`);
  if (loc) pills.push(`<span class="pkg-pill${loc === 'offsite' ? ' pkg-pill--offsite' : ''}">${loc === 'offsite' ? 'Offsite' : 'Onsite'}</span>`);
  pkgDetailPills.innerHTML = pills.join('');

  // Header — right (Inter font applied via CSS class to prevent ₱ glyph fallback)
  const price = Number(pkg.price || 0);
  pkgDetailPricing.innerHTML = price > 0
    ? `<p class="pkg-detail-price">₱${price.toLocaleString()}</p>
       <p class="pkg-detail-price-note">Starting price · inclusive of setup</p>`
    : `<p class="pkg-detail-price pkg-detail-price--contact">Contact for Quote</p>
       <p class="pkg-detail-price-note">Customized pricing available</p>`;

  // Detail "Book This Package" button — pass package id as URL param
  if (pkgDetailBookBtn) {
    pkgDetailBookBtn.href = pkg.package_id
      ? `/reservations.html?package=${encodeURIComponent(pkg.package_id)}`
      : '/reservations.html';
  }

  // Area coverage tab
  if (loc === 'offsite') show(tabAreaCoverage);
  else hide(tabAreaCoverage);

  // Panels
  panelOverview.innerHTML   = buildOverviewPanel(pkg);
  panelInclusions.innerHTML = buildInclusionsPanel(pkg);
  if (loc === 'offsite') panelArea.innerHTML = buildAreaPanel();

  switchTab('overview');
  show(sectionDetail);
  smoothScrollTo(sectionDetail, 88);
}

// ─── Panel builders ───────────────────────────────────────────────────────────
function buildOverviewPanel(pkg) {
  let html = '<div class="pkg-overview-content">';

  if (pkg.description && pkg.description.trim()) {
    pkg.description.split('\n').map(s => s.trim()).filter(Boolean).forEach(line => {
      html += `<p class="pkg-overview-para">${esc(line)}</p>`;
    });
  } else {
    html += `<p class="pkg-overview-para" style="color:var(--text-light)">No description available for this package.</p>`;
  }

  if (pkg._tiers && pkg._tiers.length > 0) {
    html += `<p class="pkg-tier-label">Available tiers</p>
             <div class="pkg-card-pills" style="margin-top:10px;flex-wrap:wrap;gap:8px">`;
    pkg._tiers.forEach(t => {
      html += `<span class="pkg-pill"><i class="ti ti-layers-intersect"></i>${esc(t.tier_name)}</span>`;
    });
    html += `</div>
             <p style="font-size:13px;color:var(--text-light);margin-top:12px">See the <strong>Inclusions</strong> tab for a full breakdown per tier.</p>`;
  }

  html += '</div>';
  return html;
}

function buildInclusionsPanel(pkg) {
  if (pkg._tiers && pkg._tiers.length > 0) {
    return pkg._tiers.map(tier => {
      const items   = parseItemList(tier.tier_full_inclusions || '');
      const content = items.length >= 4 ? buildTileGrid(items) : buildFlatList(items);
      return `
        <div class="pkg-tier-block">
          <div class="pkg-tier-head">
            <p class="pkg-tier-name">${esc(tier.tier_name)}</p>
            ${tier.tier_subtitle ? `<p class="pkg-tier-sub">${esc(tier.tier_subtitle)}</p>` : ''}
          </div>
          ${items.length ? content : '<p style="font-size:14px;color:var(--text-light)">No inclusions listed for this tier.</p>'}
        </div>`;
    }).join('');
  }

  // Structured inclusions (admin's repeatable-list editor) take priority
  // once a package has been re-saved through it; packages not yet re-edited
  // keep rendering via the legacy description-parsing fallback below.
  const items = Array.isArray(pkg.inclusions) && pkg.inclusions.length
    ? pkg.inclusions
    : parseItemList(pkg.description || '');
  if (!items.length) {
    return `<p style="font-size:14px;color:var(--text-light)">Inclusions are provided upon inquiry. Please contact us for details.</p>`;
  }
  return items.length >= 4 ? buildTileGrid(items) : buildFlatList(items);
}

function buildAreaPanel() {
  return `
    <div class="pkg-area-content">
      <div class="pkg-area-note">
        <i class="ti ti-info-circle"></i>
        <p>This is an offsite service — our team travels to your chosen venue. Travel rates are based on distance from ELI Coffee Binangonan. Contact us to confirm availability and the applicable rate for your location.</p>
      </div>
      <div class="pkg-area-cards">
        <div class="pkg-area-card">
          <i class="ti ti-map-pin"></i>
          <div>
            <p class="pkg-area-loc">Rizal Area</p>
            <p class="pkg-area-note-text">Less than 10km from ELI Coffee Binangonan</p>
          </div>
        </div>
        <div class="pkg-area-card">
          <i class="ti ti-map-2"></i>
          <div>
            <p class="pkg-area-loc">Out of Town Area</p>
            <p class="pkg-area-note-text">11km and above from ELI Coffee Binangonan</p>
          </div>
        </div>
      </div>
    </div>`;
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(targetTab) {
  const panels = { overview: panelOverview, inclusions: panelInclusions, area: panelArea, policies: panelPolicies };

  pkgTabs.querySelectorAll('.pkg-tab').forEach(btn => {
    const active = btn.dataset.tab === targetTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  Object.entries(panels).forEach(([tab, panel]) => {
    if (!panel) return;
    if (tab === targetTab) show(panel);
    else hide(panel);
  });
}

pkgTabs.addEventListener('click', e => {
  const btn = e.target.closest('.pkg-tab');
  if (btn?.dataset.tab) switchTab(btn.dataset.tab);
});

// ─── "Hide details" collapses the detail panel ───────────────────────────────
pkgDetailClose.addEventListener('click', () => {
  hide(sectionDetail);
  selectedPackageId = null;
  [pkgMainGrid, pkgAddonGrid].forEach(grid =>
    grid.querySelectorAll('.pkg-card').forEach(c => c.classList.remove('selected')));
  smoothScrollTo(sectionOptions, 88);
});

// ─── Retry ────────────────────────────────────────────────────────────────────
pkgRetryBtn.addEventListener('click', loadCategories);

// ─── Init ─────────────────────────────────────────────────────────────────────
loadCategories();
