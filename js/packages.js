// packages.js
// Customer-facing: Dynamic categories → packages from Supabase

import { portalSupabase as supabase } from './supabase.js';

// ─── Constants & Supabase Tables ────────────────────────────────────────────────────────────────
const CATEGORY_TABLE = 'package_category';
const PACKAGE_TABLE  = 'package';
const TIER_TABLE     = 'package_tier';
const TIER_VISIBLE_COUNT = 5; 

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const packagesLoading     = document.getElementById('packagesLoading');
const packagesError       = document.getElementById('packagesError');
const packagesErrorMsg    = document.getElementById('packagesErrorMsg');
const packagesEmpty       = document.getElementById('packagesEmpty');
const categoriesContainer = document.getElementById('categoriesContainer');
const retryBtn            = document.getElementById('retryBtn');

const modal              = document.getElementById('packageCategoryModal');
const modalCloseBtn      = document.getElementById('modalCloseBtn');
const pkgModalCatName    = document.getElementById('pkgModalCatName');
const pkgModalCatDesc    = document.getElementById('pkgModalCatDesc');
const pkgModalInclusions     = document.getElementById('pkgModalInclusions');
const pkgModalInclusionsList = document.getElementById('pkgModalInclusionsList');
const pkgModalLoading    = document.getElementById('pkgModalLoading');
const pkgModalEmpty      = document.getElementById('pkgModalEmpty');
const pkgModalList       = document.getElementById('pkgModalList');
const pkgModalCards      = document.getElementById('pkgModalCards');
const pkgModalAddOns     = document.getElementById('pkgModalAddOns');
const pkgModalAddOnCards = document.getElementById('pkgModalAddOnCards');

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function formatCurrency(v) {
  return `₱${Number(v || 0).toLocaleString()}`;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════════════════════
// SMART DESCRIPTION PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function buildDescriptionHtml(text) {
  if (!text || !text.trim()) return '';

  const raw = text.trim();

  // Step 1: Split by newlines first
  const lines = raw.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  // Step 2: If multiple lines exist, treat each line as a potential section or item
  if (lines.length > 1) {
    return buildMultiLineDesc(lines);
  }

  // Step 3: Single line — try splitting by bullet separators
  const bulletSeparators = /\s*[•·|]\s*/;
  if (bulletSeparators.test(raw)) {
    const items = raw.split(bulletSeparators).map(s => s.trim()).filter(s => s.length > 0);
    if (items.length > 1) {
      return buildBulletList(items);
    }
  }

  // Step 4: Try splitting by commas — only if resulting items are short
  if (raw.includes(',')) {
    const items = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const avgLen = items.reduce((sum, i) => sum + i.length, 0) / items.length;
    if (items.length >= 3 && avgLen < 60) {
      return buildBulletList(items);
    }
  }

  // Step 5: Fallback — just a paragraph
  return `<p class="pkg-card-desc">${escapeHtml(raw)}</p>`;
}

function buildMultiLineDesc(lines) {
  let html = '';
  let currentTitle = null;
  let currentItems = [];
  let introLines = [];

  for (const line of lines) {
    if (isLikelySectionHeader(line)) {
      if (currentTitle) {
        html += buildSection(currentTitle, currentItems);
        currentItems = [];
      }
      currentTitle = line.replace(/[:]\s*$/, '').trim();
    } else if (currentTitle) {
      const subItems = splitLineIntoItems(line);
      currentItems.push(...subItems);
    } else {
      introLines.push(line);
    }
  }

  if (currentTitle) {
    html += buildSection(currentTitle, currentItems);
  }

  if (introLines.length > 0) {
    const avgLen = introLines.reduce((sum, l) => sum + l.length, 0) / introLines.length;
    if (introLines.length >= 2 && avgLen < 80) {
      const allItems = [];
      for (const il of introLines) {
        allItems.push(...splitLineIntoItems(il));
      }
      html = buildBulletList(allItems) + html;
    } else {
      html = `<p class="pkg-card-desc">${escapeHtml(introLines.join(' '))}</p>` + html;
    }
  }

  return html;
}

function isLikelySectionHeader(line) {
  if (line.endsWith(':') && line.length <= 60) return true;
  return false;
}

function splitLineIntoItems(line) {
  const bulletSeparators = /\s*[•·|;]\s*/;
  if (bulletSeparators.test(line)) {
    return line.split(bulletSeparators).map(s => s.trim()).filter(s => s.length > 0);
  }
  if (line.includes(',')) {
    const parts = line.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const avgLen = parts.reduce((sum, p) => sum + p.length, 0) / parts.length;
    if (parts.length >= 2 && avgLen < 50) {
      return parts;
    }
  }
  return [line];
}

function buildSection(title, items) {
  let html = `<div class="pkg-desc-section">`;
  html += `<h4 class="pkg-desc-section-title">${escapeHtml(title)}</h4>`;
  if (items.length > 0) {
    html += `<ul class="pkg-desc-list">`;
    for (const item of items) {
      html += `<li>${escapeHtml(item)}</li>`;
    }
    html += `</ul>`;
  }
  html += `</div>`;
  return html;
}

function buildBulletList(items) {
  let html = `<ul class="pkg-desc-list">`;
  for (const item of items) {
    html += `<li>${escapeHtml(item)}</li>`;
  }
  html += `</ul>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INCLUSIONS PARSER
// Detects section headers (lines ending with :) for grouped layout
// Falls back to flat bullet list for plain text
// ═══════════════════════════════════════════════════════════════════════════════

function parseInclusionsStructured(text) {
  if (!text || !text.trim()) return { type: 'empty', sections: [], items: [] };

  const lines = text.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);

  // Check if any line looks like a section header (ends with :)
  const hasHeaders = lines.some(line => /^.{1,50}:\s*$/.test(line) || (line.endsWith(':') && line.length <= 50));

  if (hasHeaders) {
    // Parse into grouped sections
    const sections = [];
    let currentSection = null;

    for (const line of lines) {
      if (line.endsWith(':') && line.length <= 50) {
        // New section header
        if (currentSection) sections.push(currentSection);
        currentSection = {
          title: line.replace(/:\s*$/, '').trim(),
          items: []
        };
      } else if (currentSection) {
        // Item under current section — split by comma if short items
        const subItems = splitInclusionLine(line);
        currentSection.items.push(...subItems);
      } else {
        // Item before any header — create unnamed section
        if (!currentSection) {
          currentSection = { title: '', items: [] };
        }
        const subItems = splitInclusionLine(line);
        currentSection.items.push(...subItems);
      }
    }

    if (currentSection) sections.push(currentSection);

    // If we got real titled sections, return grouped
    const titledSections = sections.filter(s => s.title);
    if (titledSections.length > 0) {
      return { type: 'grouped', sections };
    }
  }

  // Flat list fallback
  let items = [];
  for (const line of lines) {
    const subItems = splitInclusionLine(line);
    items.push(...subItems);
  }

  return { type: 'flat', sections: [], items };
}

function splitInclusionLine(line) {
  // Try comma split for short items
  if (line.includes(',')) {
    const parts = line.split(',').map(s => s.trim()).filter(s => s.length > 0);
    const avgLen = parts.reduce((sum, p) => sum + p.length, 0) / parts.length;
    if (parts.length >= 2 && avgLen < 50) {
      return parts;
    }
  }
  return [line];
}
function buildInclusionsHtml(text) {
  const parsed = parseInclusionsStructured(text);

  if (parsed.type === 'empty') return '';

  if (parsed.type === 'grouped') {
    // Render as 3-column grid with cards
    const groupCards = parsed.sections.map(section => {
      if (!section.title && section.items.length === 0) return '';

      const titleHtml = section.title
        ? `<h4 class="inclusions-group-title">${escapeHtml(section.title)}</h4>`
        : '';

      const listHtml = section.items.length > 0
        ? `<ul class="inclusions-group-list">${section.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
        : '';

      return `<div class="inclusions-group">${titleHtml}${listHtml}</div>`;
    }).join('');

    return `<div class="inclusions-grid">${groupCards}</div>`;
  }

  // Flat list
  if (parsed.items.length === 0) return '';
  return `<ul class="pkg-modal-inclusions-list">${parsed.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE STATES
// ═══════════════════════════════════════════════════════════════════════════════

function showPageLoading() {
  show(packagesLoading);
  hide(packagesError);
  hide(packagesEmpty);
  hide(categoriesContainer);
}

function showPageError(msg) {
  hide(packagesLoading);
  show(packagesError);
  hide(packagesEmpty);
  hide(categoriesContainer);
  packagesErrorMsg.textContent = msg || 'Failed to load packages.';
}

function showPageEmpty() {
  hide(packagesLoading);
  hide(packagesError);
  show(packagesEmpty);
  hide(categoriesContainer);
}

function showPageContent() {
  hide(packagesLoading);
  hide(packagesError);
  hide(packagesEmpty);
  show(categoriesContainer);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL STATES
// ═══════════════════════════════════════════════════════════════════════════════

function showModalLoading() {
  show(pkgModalLoading);
  hide(pkgModalEmpty);
  hide(pkgModalList);
  hide(pkgModalAddOns);
}

function showModalEmpty() {
  hide(pkgModalLoading);
  show(pkgModalEmpty);
  hide(pkgModalList);
  hide(pkgModalAddOns);
}

function showModalContent(hasMain, hasAddOns) {
  hide(pkgModalLoading);
  hide(pkgModalEmpty);
  if (hasMain)   show(pkgModalList);    else hide(pkgModalList);
  if (hasAddOns) show(pkgModalAddOns);  else hide(pkgModalAddOns);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL OPEN / CLOSE
// ═══════════════════════════════════════════════════════════════════════════════

function openModal() {
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

modalCloseBtn.addEventListener('click', closeModal);
window.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display === 'flex') closeModal(); });

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD & RENDER CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

async function loadCategories() {
  showPageLoading();
  try {
    const { data, error } = await supabase
      .from(CATEGORY_TABLE)
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!data || data.length === 0) { showPageEmpty(); return; }
    renderCategoryCards(data);
    showPageContent();
  } catch (err) {
    console.error('Failed to load categories:', err);
    showPageError('Unable to load packages right now. Please try again later.');
  }
}

function buildCategoryCardImage(cat) {
  if (cat.category_image) {
    return `<img src="${escapeHtml(cat.category_image)}" class="card-img" alt="${escapeHtml(cat.category_name)}" loading="lazy">`;
  }
  return `<div class="card-img card-img-placeholder"><i class="fa-solid fa-utensils"></i></div>`;
}

function renderCategoryCards(categories) {
  categoriesContainer.innerHTML = categories.map(cat => {
    const desc = cat.description || '';
    const inclusions = cat.package_category_inclusions || '';
    const displayText = desc ? escapeHtml(desc) : 'Tap to view available packages';

    return `
      <div class="card" 
           data-category-id="${cat.package_category_id}" 
           data-category-name="${escapeHtml(cat.category_name)}"
           data-category-desc="${escapeHtml(desc)}"
           data-category-inclusions="${escapeHtml(inclusions)}">
        ${buildCategoryCardImage(cat)}
        <div class="card-body">
          <div class="card-title"><h3>${escapeHtml(cat.category_name)}</h3></div>
          <p>${displayText}</p>
        </div>
      </div>
    `;
  }).join('');

  categoriesContainer.querySelectorAll('.card[data-category-id]').forEach(card => {
    card.addEventListener('click', () => {
      openCategoryModal(
        card.dataset.categoryId,
        card.dataset.categoryName,
        card.dataset.categoryDesc || '',
        card.dataset.categoryInclusions || ''
      );
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD & RENDER PACKAGES IN MODAL
// ═══════════════════════════════════════════════════════════════════════════════

async function openCategoryModal(categoryId, categoryName, categoryDesc, categoryInclusions) {
  // ── Set header ──
  pkgModalCatName.textContent = categoryName;

  // ── Set category description ──
  if (categoryDesc && categoryDesc.trim()) {
    pkgModalCatDesc.textContent = categoryDesc;
    show(pkgModalCatDesc);
  } else {
    pkgModalCatDesc.textContent = '';
    hide(pkgModalCatDesc);
  }

    // ── Set category inclusions ──
  const inclusionsHtml = buildInclusionsHtml(categoryInclusions);
  if (inclusionsHtml) {
    pkgModalInclusionsList.innerHTML = inclusionsHtml;
    show(pkgModalInclusions);
  } else {
    pkgModalInclusionsList.innerHTML = '';
    hide(pkgModalInclusions);
  }

  // ── Reset content ──
  pkgModalCards.innerHTML = '';
  pkgModalAddOnCards.innerHTML = '';
  showModalLoading();
  openModal();

  try {
    const { data, error } = await supabase
      .from(PACKAGE_TABLE)
      .select('*')
      .eq('package_category_id', categoryId)
      .eq('is_active', true)
      .order('price', { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      showModalEmpty();
      return;
    }

    // ── Fetch active tiers for all packages in this category ──
    const packageIds = data.map(p => p.package_id);
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
    } catch (tierErr) {
      console.warn('Could not load tiers:', tierErr);
    }

    // ── Attach tiers to packages ──
    data.forEach(pkg => { pkg._tiers = tierMap[pkg.package_id] || []; });

    const mainPackages  = data.filter(p => p.package_type === 'main');
    const addOnPackages = data.filter(p => p.package_type === 'add on');

    const mainTitle  = document.getElementById('pkgModalMainTitle');
    const addOnTitle = document.getElementById('pkgModalAddOnTitle');

    if (mainPackages.length > 0) {
      pkgModalCards.innerHTML = mainPackages.map(buildPackageCard).join('');
    }

    if (addOnPackages.length > 0) {
      pkgModalAddOnCards.innerHTML = addOnPackages.map(buildPackageCard).join('');
    }

    if (mainPackages.length === 0 && addOnPackages.length > 0) {
      pkgModalCards.innerHTML = addOnPackages.map(buildPackageCard).join('');
      if (mainTitle) mainTitle.textContent = 'Add-On Packages';
      showModalContent(true, false);
    } else if (mainPackages.length === 0 && addOnPackages.length === 0) {
      pkgModalCards.innerHTML = data.map(buildPackageCard).join('');
      if (mainTitle) mainTitle.textContent = 'Package Options';
      showModalContent(true, false);
    } else {
      if (mainTitle) mainTitle.textContent = mainPackages.length > 0 && addOnPackages.length > 0
        ? 'Main Packages' : 'Package Options';
      if (addOnTitle) addOnTitle.textContent = 'Add-On Packages';
      showModalContent(mainPackages.length > 0, addOnPackages.length > 0);
    }

    // ── Wire tier toggle buttons ──
    wireTierToggleButtons();

  } catch (err) {
    console.error('Failed to load packages:', err);
    pkgModalCards.innerHTML = `<div class="pkg-modal-error"><p>Failed to load packages. Please try again.</p></div>`;
    showModalContent(true, false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER TOGGLE BUTTONS
// ═══════════════════════════════════════════════════════════════════════════════

function wireTierToggleButtons() {
  modal.querySelectorAll('.tier-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const extra = btn.nextElementSibling;
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      btn.textContent = expanded ? 'View full inclusions' : 'Hide full inclusions';
      if (extra) {
        if (expanded) extra.setAttribute('hidden', '');
        else extra.removeAttribute('hidden');
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD PACKAGE CARD
// ═══════════════════════════════════════════════════════════════════════════════

function buildPackageCard(pkg) {
  const pills = [];

  if (pkg.guest_capacity) {
    pills.push(`<span class="pkg-pill">${pkg.guest_capacity} pax</span>`);
  }

  if (pkg.duration_hours) {
    pills.push(`<span class="pkg-pill">${pkg.duration_hours} hr${pkg.duration_hours !== 1 ? 's' : ''}</span>`);
  }

  if (pkg.location_type) {
    const locLabel = pkg.location_type.charAt(0).toUpperCase() + pkg.location_type.slice(1);
    pills.push(`<span class="pkg-pill">${escapeHtml(locLabel)}</span>`);
  }

  if (pkg.extension_price) {
    pills.push(`<span class="pkg-pill">+${formatCurrency(pkg.extension_price)}/hr ext.</span>`);
  }

  const pillsHtml = pills.length
    ? `<div class="pkg-card-pills">${pills.join('')}</div>`
    : '';

  const descHtml = buildDescriptionHtml(pkg.description);

  // ── Build tier cards ──
  const tiersHtml = buildTiersHtml(pkg._tiers || []);

  return `
    <div class="pkg-modal-card">
      <div class="pkg-card-header">
        <span class="pkg-card-name">${escapeHtml(pkg.package_name)}</span>
        <span class="pkg-card-price">${formatCurrency(pkg.price)}</span>
      </div>
      ${pillsHtml}
      ${descHtml ? `<div class="pkg-card-desc-wrap">${descHtml}</div>` : ''}
      ${tiersHtml}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD TIERS HTML
// Uses only DB columns: tier_name, tier_subtitle, tier_full_inclusions, sort_order
// Splits tier_full_inclusions by newline or comma
// Shows first 5 items, "View full inclusions" button if more than 5
// ═══════════════════════════════════════════════════════════════════════════════

function parseTierInclusions(text) {
  if (!text || !text.trim()) return [];

  // Split by newlines first
  let items = text.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);

  // If only one line, try splitting by commas
  if (items.length === 1) {
    const commaSplit = items[0].split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (commaSplit.length > 1) {
      items = commaSplit;
    }
  }

  return items;
}

function buildTiersHtml(tiers) {
  if (!tiers || tiers.length === 0) return '';

  const tierCards = tiers.map(tier => {
    const allInclusions = parseTierInclusions(tier.tier_full_inclusions);
    const hasMany = allInclusions.length > TIER_VISIBLE_COUNT;
    const visibleItems = hasMany ? allInclusions.slice(0, TIER_VISIBLE_COUNT) : allInclusions;
    const hiddenItems = hasMany ? allInclusions.slice(TIER_VISIBLE_COUNT) : [];

    // Build visible inclusions list
    const visibleListHtml = visibleItems.length > 0
      ? `<ul class="tier-list">${visibleItems.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : '';

    // Build toggle + hidden inclusions (only if > 5 items)
    let toggleHtml = '';
    if (hiddenItems.length > 0) {
      toggleHtml = `
        <button type="button" class="tier-toggle-btn" aria-expanded="false">View full inclusions</button>
        <div class="tier-extra" hidden>
          <ul class="tier-list">${hiddenItems.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        </div>
      `;
    }

    return `
      <div class="tier-card">
        <div class="tier-card-head">
          <h4>${escapeHtml(tier.tier_name)}</h4>
          ${tier.tier_subtitle ? `<p>${escapeHtml(tier.tier_subtitle)}</p>` : ''}
        </div>
        <div class="tier-card-body">
          ${visibleListHtml}
          ${toggleHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="pkg-tiers-section">
      <h4 class="pkg-tiers-title">Package Tiers:</h4>
      <div class="tier-grid">${tierCards}</div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
retryBtn.addEventListener('click', loadCategories);
loadCategories();