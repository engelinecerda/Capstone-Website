// packages.js — Customer-facing packages LISTING page only.
// Agoda-style flow: filter sidebar + vertical result list.
//
// Every value on this page (categories, counts, price bounds, capacity
// buckets, package data, images, the Most Booked badge) is fetched from
// Supabase — nothing here is a hardcoded fallback catalogue. The catalogue
// is small (~15-20 active packages), so filtering/sorting is done
// client-side against one full fetch rather than re-querying per filter
// change (see the module doc in the redesign spec this implements).
//
// Clicking a result card no longer opens an in-page detail panel — it
// navigates to the standalone package-details.html?id=... page (see
// js/package_details.js), which owns the gallery/tabs/sticky sidebar that
// used to live here as an in-page #section-detail panel.

import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader } from './page_content.js';

const CATEGORY_TABLE = 'package_category';
const PACKAGE_TABLE  = 'package';
const PHOTO_TABLE    = 'package_photo';
const BADGE_TABLE    = 'badge';
const PACKAGE_BADGE_TABLE = 'package_badge';

// Fixed bucket BOUNDARIES only — every count shown next to a bucket is
// computed from real package data in computeFacets(), never hardcoded.
const CAPACITY_BUCKETS = [
  { key: '0-20',   label: 'Up to 20',  min: 0,   max: 20 },
  { key: '21-50',  label: '21–50',     min: 21,  max: 50 },
  { key: '51-100', label: '51–100',    min: 51,  max: 100 },
  { key: '101+',   label: '101+',      min: 101, max: Infinity },
];

// ─── State ───────────────────────────────────────────────────────────────────
let allPackages       = [];   // active, non-add-on packages, enriched with _categoryName, _coverPhotoUrl, bookingCount
let categoryNameById  = {};
let mostBookedPackageId = null;
let facets = { categories: [], priceMin: 0, priceMax: 0, capacityBuckets: [], showLocationFilter: false };
let filters = { categoryIds: new Set(), priceMin: 0, priceMax: 0, capacityBucketKey: '', locationType: '' };
let sortKey = 'popularity_desc';

// ─── DOM refs — browse section ────────────────────────────────────────────────
const pkgFiltersToggle     = document.getElementById('pkgFiltersToggle');
const pkgFiltersCountBadge = document.getElementById('pkgFiltersCountBadge');
const pkgSidebarBackdrop   = document.getElementById('pkgSidebarBackdrop');
const pkgSidebar           = document.getElementById('pkgSidebar');
const pkgClearFilters      = document.getElementById('pkgClearFilters');
const pkgSidebarClose      = document.getElementById('pkgSidebarClose');
const pkgSidebarBody       = document.getElementById('pkgSidebarBody');
const pkgApplyFilters      = document.getElementById('pkgApplyFilters');

const pkgListLoading  = document.getElementById('pkgListLoading');
const pkgListError    = document.getElementById('pkgListError');
const pkgListErrorMsg = document.getElementById('pkgListErrorMsg');
const pkgRetryBtn     = document.getElementById('pkgRetryBtn');
const pkgResultsBody  = document.getElementById('pkgResultsBody');
const pkgResultsCount = document.getElementById('pkgResultsCount');
const pkgSortSelect   = document.getElementById('pkgSortSelect');
const pkgEmptyState   = document.getElementById('pkgEmptyState');
const pkgEmptyClearBtn = document.getElementById('pkgEmptyClearBtn');
const pkgList         = document.getElementById('pkgList');

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

// ══════════════════════════════════════════════════════════════════════════════
// LOAD — full active catalogue + facet data + real booking counts
// ══════════════════════════════════════════════════════════════════════════════
async function loadCatalog() {
  show(pkgListLoading);
  hide(pkgListError);
  hide(pkgResultsBody);

  try {
    const { data: cats, error: catErr } = await supabase
      .from(CATEGORY_TABLE)
      .select('package_category_id, category_name')
      .eq('is_active', true);
    if (catErr) throw catErr;

    categoryNameById = {};
    (cats || []).forEach(c => { categoryNameById[c.package_category_id] = c.category_name || ''; });

    const { data: pkgs, error: pkgErr } = await supabase
      .from(PACKAGE_TABLE)
      .select('*')
      .eq('is_active', true)
      .neq('package_type', 'add on')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (pkgErr) throw pkgErr;

    allPackages = pkgs || [];

    if (allPackages.length) {
      const packageIds = allPackages.map(p => p.package_id);

      // Batch-fetch photos — admin manages up to 8 per package with one
      // marked cover. Only the cover is needed here for the result-card
      // thumbnail; the full gallery now lives on package-details.html,
      // which fetches a package's photos itself.
      let coverByPackageId = {};
      try {
        const { data: photos } = await supabase
          .from(PHOTO_TABLE)
          .select('package_id, image_url, alt_text, is_cover, sort_order')
          .in('package_id', packageIds)
          .order('sort_order', { ascending: true });
        (photos || []).forEach(ph => {
          const existing = coverByPackageId[ph.package_id];
          if (!existing || ph.is_cover) coverByPackageId[ph.package_id] = ph;
        });
      } catch { /* image is optional — placeholder covers this */ }

      // Real, reservation-derived booking counts (SECURITY DEFINER RPC —
      // never exposes reservation rows, just package_id + a count).
      let bookingCountMap = {};
      try {
        const { data: counts } = await supabase.rpc('get_package_booking_counts');
        (counts || []).forEach(row => { bookingCountMap[row.package_id] = row.booking_count || 0; });
      } catch { /* popularity sort/badge just falls back to 0s */ }

      // Admin-assigned badges (e.g. "Best Value") — manually set via
      // Bookable Inventory. Independent of Most Booked, which stays the
      // only booking-count-derived indicator; a package can carry both.
      let badgeMap = {};
      try {
        const { data: badgeDefs } = await supabase
          .from(BADGE_TABLE)
          .select('badge_id, label, variant, sort_order')
          .eq('is_active', true);
        const badgeDefsById = {};
        (badgeDefs || []).forEach(b => { badgeDefsById[b.badge_id] = b; });

        const { data: assignedRows } = await supabase
          .from(PACKAGE_BADGE_TABLE)
          .select('package_id, badge_id')
          .in('package_id', packageIds);
        (assignedRows || []).forEach(row => {
          const def = badgeDefsById[row.badge_id];
          if (!def) return;
          if (!badgeMap[row.package_id]) badgeMap[row.package_id] = [];
          badgeMap[row.package_id].push(def);
        });
      } catch { /* badges optional — never block the catalogue */ }

      allPackages.forEach(p => {
        p._categoryName = categoryNameById[p.package_category_id] || '';
        p._coverPhoto = coverByPackageId[p.package_id] || null;
        p.bookingCount = bookingCountMap[p.package_id] || 0;
        p._badges = (badgeMap[p.package_id] || [])
          .slice()
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
          .slice(0, 2);
      });

      // Most Booked is a single, unambiguous winner across the WHOLE active
      // catalogue (not just the current filter) — suppressed entirely if
      // nobody has any real bookings yet, or if the top count is tied.
      const maxCount = Math.max(...allPackages.map(p => p.bookingCount));
      const leaders = allPackages.filter(p => p.bookingCount === maxCount);
      mostBookedPackageId = (maxCount > 0 && leaders.length === 1) ? leaders[0].package_id : null;
    } else {
      mostBookedPackageId = null;
    }

    // Backward compatibility for any stale link still pointing at the old
    // in-page panel's deep-link param — package details now live on their
    // own page.
    const legacyPackageId = new URLSearchParams(window.location.search).get('package');
    if (legacyPackageId) {
      window.location.replace(`/package-details.html?id=${encodeURIComponent(legacyPackageId)}`);
      return;
    }

    computeFacets();
    resetFiltersToFacetBounds();
    renderSidebar();
    applyFiltersAndRender();

    hide(pkgListLoading);
    show(pkgResultsBody);
  } catch (err) {
    hide(pkgListLoading);
    show(pkgListError);
    if (pkgListErrorMsg) pkgListErrorMsg.textContent = 'Unable to load packages right now. Please try again.';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FACETS — derived once from the fetched catalogue, never hardcoded
// ══════════════════════════════════════════════════════════════════════════════
function capacityRange(pkg) {
  const max = pkg.guest_capacity ?? pkg.max_guests ?? null;
  const min = pkg.min_guests ?? 1;
  return { min, max: max === null ? Infinity : max };
}

function rangesOverlap(aMin, aMax, bMin, bMax) {
  return aMin <= bMax && bMin <= aMax;
}

function computeFacets() {
  const categoryCounts = {};
  let priceMin = Infinity;
  let priceMax = 0;
  let hasOnsite = false;
  let hasOffsite = false;

  allPackages.forEach(p => {
    if (p.package_category_id) {
      categoryCounts[p.package_category_id] = (categoryCounts[p.package_category_id] || 0) + 1;
    }
    const price = Number(p.price || 0);
    if (price > 0) {
      priceMin = Math.min(priceMin, price);
      priceMax = Math.max(priceMax, price);
    }
    const loc = (p.location_type || '').toLowerCase();
    if (loc === 'onsite' || loc === 'both') hasOnsite = true;
    if (loc === 'offsite' || loc === 'both') hasOffsite = true;
  });

  if (!Number.isFinite(priceMin)) priceMin = 0; // no priced packages at all

  const categories = Object.keys(categoryCounts)
    .map(id => ({ id, name: categoryNameById[id] || 'Uncategorized', count: categoryCounts[id] }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const capacityBuckets = CAPACITY_BUCKETS.map(b => ({
    ...b,
    count: allPackages.filter(p => {
      const r = capacityRange(p);
      return rangesOverlap(r.min, r.max, b.min, b.max);
    }).length
  })).filter(b => b.count > 0);

  facets = {
    categories,
    priceMin,
    priceMax,
    capacityBuckets,
    showLocationFilter: hasOnsite && hasOffsite
  };
}

function resetFiltersToFacetBounds() {
  filters = {
    categoryIds: new Set(),
    priceMin: facets.priceMin,
    priceMax: facets.priceMax,
    capacityBucketKey: '',
    locationType: ''
  };
}

function activeFilterCount() {
  let n = filters.categoryIds.size;
  if (filters.priceMin > facets.priceMin || filters.priceMax < facets.priceMax) n += 1;
  if (filters.capacityBucketKey) n += 1;
  if (filters.locationType) n += 1;
  return n;
}

// ══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — rendered entirely from facets()
// ══════════════════════════════════════════════════════════════════════════════
function formatPeso(n) {
  return `₱${Number(n || 0).toLocaleString()}`;
}

function renderSidebar() {
  const categoryRows = facets.categories.map(c => `
    <label class="pkg-filter-row">
      <input type="checkbox" class="pkg-filter-checkbox" data-filter="category" value="${esc(c.id)}">
      <span class="pkg-filter-row-label">${esc(c.name)}</span>
      <span class="pkg-filter-row-count">${c.count}</span>
    </label>`).join('');

  const capacityRows = `
    <label class="pkg-filter-row">
      <input type="radio" name="pkgCapacity" class="pkg-filter-radio" data-filter="capacity" value="" checked>
      <span class="pkg-filter-row-label">Any capacity</span>
    </label>` +
    facets.capacityBuckets.map(b => `
    <label class="pkg-filter-row">
      <input type="radio" name="pkgCapacity" class="pkg-filter-radio" data-filter="capacity" value="${esc(b.key)}">
      <span class="pkg-filter-row-label">${esc(b.label)}</span>
      <span class="pkg-filter-row-count">${b.count}</span>
    </label>`).join('');

  const locationGroup = facets.showLocationFilter ? `
    <div class="pkg-filter-group" id="pkgLocationGroup">
      <p class="pkg-filter-group-title">Location</p>
      <div class="pkg-location-toggle" id="pkgLocationToggle" role="group" aria-label="Location type">
        <button type="button" class="pkg-location-btn" data-location="onsite">Onsite</button>
        <button type="button" class="pkg-location-btn" data-location="offsite">Offsite</button>
      </div>
    </div>` : '';

  pkgSidebarBody.innerHTML = `
    <div class="pkg-filter-group">
      <p class="pkg-filter-group-title">Category</p>
      <div class="pkg-filter-options">${categoryRows || '<p class="pkg-filter-empty-note">No categories available.</p>'}</div>
    </div>

    <div class="pkg-filter-group">
      <p class="pkg-filter-group-title">Price Range</p>
      <div class="pkg-price-slider">
        <div class="pkg-price-track">
          <div class="pkg-price-track-fill" id="pkgPriceTrackFill"></div>
        </div>
        <input type="range" id="pkgPriceMinInput" class="pkg-range-input pkg-range-input--min"
               min="${facets.priceMin}" max="${facets.priceMax}" value="${facets.priceMin}"
               aria-label="Minimum price" aria-valuemin="${facets.priceMin}" aria-valuemax="${facets.priceMax}">
        <input type="range" id="pkgPriceMaxInput" class="pkg-range-input pkg-range-input--max"
               min="${facets.priceMin}" max="${facets.priceMax}" value="${facets.priceMax}"
               aria-label="Maximum price" aria-valuemin="${facets.priceMin}" aria-valuemax="${facets.priceMax}">
      </div>
      <div class="pkg-price-values">
        <span id="pkgPriceMinLabel">${formatPeso(facets.priceMin)}</span>
        <span id="pkgPriceMaxLabel">${formatPeso(facets.priceMax)}</span>
      </div>
    </div>

    <div class="pkg-filter-group">
      <p class="pkg-filter-group-title">Guest Capacity</p>
      <div class="pkg-filter-options">${capacityRows}</div>
    </div>

    ${locationGroup}
  `;

  wireSidebarInputs();
  updatePriceSliderVisual();
}

function wireSidebarInputs() {
  pkgSidebarBody.querySelectorAll('[data-filter="category"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) filters.categoryIds.add(cb.value);
      else filters.categoryIds.delete(cb.value);
      applyFiltersAndRender();
    });
  });

  pkgSidebarBody.querySelectorAll('[data-filter="capacity"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked) filters.capacityBucketKey = radio.value;
      applyFiltersAndRender();
    });
  });

  const locToggle = document.getElementById('pkgLocationToggle');
  locToggle?.querySelectorAll('.pkg-location-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.location;
      filters.locationType = filters.locationType === value ? '' : value;
      locToggle.querySelectorAll('.pkg-location-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.location === filters.locationType));
      applyFiltersAndRender();
    });
  });

  const minInput = document.getElementById('pkgPriceMinInput');
  const maxInput = document.getElementById('pkgPriceMaxInput');
  const onPriceInput = (event) => {
    // Clamp the handle that just moved against the other one, instead of
    // silently swapping stored values — otherwise the two visual thumbs
    // can cross and the slider looks broken even though filtering itself
    // would still be "correct".
    if (event?.target === minInput && Number(minInput.value) > Number(maxInput.value)) {
      minInput.value = maxInput.value;
    } else if (event?.target === maxInput && Number(maxInput.value) < Number(minInput.value)) {
      maxInput.value = minInput.value;
    }

    const minVal = Number(minInput.value);
    const maxVal = Number(maxInput.value);
    filters.priceMin = minVal;
    filters.priceMax = maxVal;
    minInput.setAttribute('aria-valuenow', String(minVal));
    maxInput.setAttribute('aria-valuenow', String(maxVal));
    document.getElementById('pkgPriceMinLabel').textContent = formatPeso(minVal);
    document.getElementById('pkgPriceMaxLabel').textContent = formatPeso(maxVal);
    updatePriceSliderVisual();
    applyFiltersAndRender();
  };
  minInput?.addEventListener('input', onPriceInput);
  maxInput?.addEventListener('input', onPriceInput);
}

function updatePriceSliderVisual() {
  const fill = document.getElementById('pkgPriceTrackFill');
  if (!fill) return;
  const span = facets.priceMax - facets.priceMin || 1;
  const leftPct = ((filters.priceMin - facets.priceMin) / span) * 100;
  const rightPct = ((filters.priceMax - facets.priceMin) / span) * 100;
  fill.style.left = `${leftPct}%`;
  fill.style.right = `${100 - rightPct}%`;
}

function updateClearAllVisibility() {
  const count = activeFilterCount();
  if (count > 0) show(pkgClearFilters);
  else hide(pkgClearFilters);

  if (count > 0) {
    pkgFiltersCountBadge.textContent = String(count);
    show(pkgFiltersCountBadge);
  } else {
    hide(pkgFiltersCountBadge);
  }
}

function clearAllFilters() {
  resetFiltersToFacetBounds();
  renderSidebar();
  applyFiltersAndRender();
}

pkgClearFilters?.addEventListener('click', clearAllFilters);
pkgEmptyClearBtn?.addEventListener('click', clearAllFilters);

// ══════════════════════════════════════════════════════════════════════════════
// FILTERING + SORTING (client-side — see module doc)
// ══════════════════════════════════════════════════════════════════════════════
function packageMatchesFilters(p) {
  if (filters.categoryIds.size && !filters.categoryIds.has(p.package_category_id)) return false;

  const price = Number(p.price || 0);
  if (price > 0 && (price < filters.priceMin || price > filters.priceMax)) return false;

  if (filters.capacityBucketKey) {
    const bucket = CAPACITY_BUCKETS.find(b => b.key === filters.capacityBucketKey);
    if (bucket) {
      const r = capacityRange(p);
      if (!rangesOverlap(r.min, r.max, bucket.min, bucket.max)) return false;
    }
  }

  if (filters.locationType) {
    const loc = (p.location_type || '').toLowerCase();
    if (loc !== filters.locationType && loc !== 'both') return false;
  }

  return true;
}

function sortPackages(list) {
  const sorted = list.slice();
  if (sortKey === 'price_asc') sorted.sort((a, b) => Number(a.price || 0) - Number(b.price || 0));
  else if (sortKey === 'price_desc') sorted.sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
  else sorted.sort((a, b) => (b.bookingCount || 0) - (a.bookingCount || 0));
  return sorted;
}

function buildResultCountLabel(count) {
  const label = count === 1 ? '1 package found' : `${count} packages found`;
  if (filters.categoryIds.size === 1) {
    const [onlyId] = filters.categoryIds;
    const name = categoryNameById[onlyId];
    if (name) return `${label} in ${name}`;
  }
  return label;
}

function applyFiltersAndRender() {
  const filtered = sortPackages(allPackages.filter(packageMatchesFilters));

  pkgResultsCount.textContent = buildResultCountLabel(filtered.length);
  updateClearAllVisibility();

  if (!filtered.length) {
    pkgList.innerHTML = '';
    hide(pkgList);
    show(pkgEmptyState);
    return;
  }

  hide(pkgEmptyState);
  show(pkgList);
  pkgList.innerHTML = filtered.map(buildResultCard).join('');
  wireResultCards();
}

pkgSortSelect?.addEventListener('change', () => {
  sortKey = pkgSortSelect.value;
  applyFiltersAndRender();
});

// ══════════════════════════════════════════════════════════════════════════════
// RESULT CARDS — horizontal list rows
// ══════════════════════════════════════════════════════════════════════════════
function buildResultCard(pkg) {
  const name = pkg.package_name || 'Package';
  const loc = (pkg.location_type || '').toLowerCase();
  const locLabel = loc === 'offsite' ? 'Offsite' : (loc === 'onsite' || loc === 'both') ? 'Onsite' : '';

  const chips = [];
  const capMax = pkg.guest_capacity ?? pkg.max_guests ?? null;
  if (capMax) chips.push(`<span class="pkg-chip"><i class="ti ti-users"></i>Up to ${capMax} guests</span>`);
  if (pkg.duration_hours) chips.push(`<span class="pkg-chip"><i class="ti ti-clock"></i>${pkg.duration_hours} hr${pkg.duration_hours !== 1 ? 's' : ''}</span>`);
  if (locLabel) chips.push(`<span class="pkg-chip pkg-chip--location">${esc(locLabel)}</span>`);

  const price = Number(pkg.price || 0);
  const priceHtml = price > 0
    ? `<p class="pkg-result-price-note">Starting price</p><p class="pkg-result-price">${formatPeso(price)}</p>`
    : `<p class="pkg-result-price-note">Custom pricing</p><p class="pkg-result-price pkg-result-price--contact">Contact for Quote</p>`;

  const imgHtml = pkg._coverPhoto?.image_url
    ? `<img class="pkg-result-img" src="${esc(pkg._coverPhoto.image_url)}" alt="${esc(pkg._coverPhoto.alt_text || name)}" loading="lazy">`
    : `<div class="pkg-result-img pkg-result-img--placeholder"><i class="ti ti-photo"></i></div>`;

  const mostBookedHtml = pkg.package_id === mostBookedPackageId
    ? `<span class="pkg-most-booked-badge"><i class="ti ti-flame"></i>Most Booked</span>`
    : '';

  const adminBadgesHtml = (pkg._badges || []).map(b =>
    `<span class="pkg-admin-badge pkg-admin-badge--${esc(b.variant || 'neutral')}">${esc(b.label)}</span>`
  ).join('');

  const badgeStackHtml = (mostBookedHtml || adminBadgesHtml)
    ? `<div class="pkg-result-badges">${mostBookedHtml}${adminBadgesHtml}</div>`
    : '';

  return `
    <article class="pkg-result-card" data-pkg-id="${esc(pkg.package_id)}">
      <div class="pkg-result-img-wrap">
        ${imgHtml}
        ${badgeStackHtml}
      </div>
      <div class="pkg-result-body">
        <p class="pkg-result-category">${esc(pkg._categoryName || '')}</p>
        <h3 class="pkg-result-name">${esc(name)}</h3>
        <div class="pkg-result-chips">${chips.join('')}</div>
      </div>
      <div class="pkg-result-action">
        ${priceHtml}
        <div class="pkg-result-action-buttons">
          <a href="/reservations.html${pkg.package_id ? '?package=' + esc(pkg.package_id) : ''}" class="pkg-result-book-btn" aria-label="Book ${esc(name)}">
            Book
          </a>
        </div>
      </div>
    </article>`;
}

// The "Details" button was removed as redundant — the whole card (image,
// name, chips, price) already opens the same detail page on click; Book
// is the only explicit button now, and stops that click from also firing.
function wireResultCards() {
  pkgList.querySelectorAll('.pkg-result-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.pkg-result-book-btn')) return;
      triggerDetail(card.dataset.pkgId);
    });
  });
}

function triggerDetail(pkgId) {
  window.location.href = `/package-details.html?id=${encodeURIComponent(pkgId)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// MOBILE FILTER DRAWER
// ══════════════════════════════════════════════════════════════════════════════
function openFilterDrawer() {
  pkgSidebar.classList.add('is-open');
  show(pkgSidebarBackdrop);
  document.body.classList.add('pkg-no-scroll');
}
function closeFilterDrawer() {
  pkgSidebar.classList.remove('is-open');
  hide(pkgSidebarBackdrop);
  document.body.classList.remove('pkg-no-scroll');
}

pkgFiltersToggle?.addEventListener('click', openFilterDrawer);
pkgSidebarClose?.addEventListener('click', closeFilterDrawer);
pkgSidebarBackdrop?.addEventListener('click', closeFilterDrawer);
pkgApplyFilters?.addEventListener('click', closeFilterDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pkgSidebar.classList.contains('is-open')) closeFilterDrawer();
});

// ─── Retry ────────────────────────────────────────────────────────────────────
pkgRetryBtn?.addEventListener('click', loadCatalog);

// ─── Init ─────────────────────────────────────────────────────────────────────
loadPageHeader(supabase, 'packages', {
  imgEl: document.querySelector('.page-hero-img'),
  headingEl: document.querySelector('.page-hero-title'),
  subEl: document.querySelector('.page-hero-sub')
});
loadCatalog();
