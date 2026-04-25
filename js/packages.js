// packages.js
// Customer-facing: Dynamic categories → packages from Supabase

import { portalSupabase as supabase } from './supabase.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const CATEGORY_TABLE = '(TEST) package_category';
const PACKAGE_TABLE  = 'package';

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
// Automatically detects structure from plain text.
// No special typing format required from admin.
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
// INCLUSIONS PARSER
// Splits inclusions text into individual items by newline or comma
// ═══════════════════════════════════════════════════════════════════════════════

function parseInclusions(text) {
  if (!text || !text.trim()) return [];

  // First try splitting by newlines
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

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD & RENDER PACKAGES IN MODAL
// ═══════════════════════════════════════════════════════════════════════════════

async function openCategoryModal(categoryId, categoryName, categoryDesc, categoryInclusions) {
  pkgModalCatName.textContent  = categoryName;
  pkgModalCards.innerHTML      = '';
  pkgModalAddOnCards.innerHTML = '';

  // Show description under category name
  if (pkgModalCatDesc) {
    if (categoryDesc && categoryDesc.trim()) {
      pkgModalCatDesc.textContent = categoryDesc;
      pkgModalCatDesc.classList.remove('hidden');
    } else {
      pkgModalCatDesc.textContent = '';
      pkgModalCatDesc.classList.add('hidden');
    }
  }

  // Show inclusions section
  if (pkgModalInclusions && pkgModalInclusionsList) {
    const inclusionItems = parseInclusions(categoryInclusions);
    if (inclusionItems.length > 0) {
      pkgModalInclusionsList.innerHTML = inclusionItems
        .map(item => `<li>${escapeHtml(item)}</li>`)
        .join('');
      pkgModalInclusions.classList.remove('hidden');
    } else {
      pkgModalInclusionsList.innerHTML = '';
      pkgModalInclusions.classList.add('hidden');
    }
  }

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

  } catch (err) {
    console.error('Failed to load packages:', err);
    pkgModalCards.innerHTML = `<div class="pkg-modal-error"><p>Failed to load packages. Please try again.</p></div>`;
    showModalContent(true, false);
  }
}

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

  return `
    <div class="pkg-modal-card">
      <div class="pkg-card-header">
        <span class="pkg-card-name">${escapeHtml(pkg.package_name)}</span>
        <span class="pkg-card-price">${formatCurrency(pkg.price)}</span>
      </div>
      ${pillsHtml}
      ${descHtml ? `<div class="pkg-card-desc-wrap">${descHtml}</div>` : ''}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
retryBtn.addEventListener('click', loadCategories);
loadCategories();