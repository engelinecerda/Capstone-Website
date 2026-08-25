import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader, loadGalleryImages, loadAboutSections, revealConfigContent, withConfigTimeout } from './page_content.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}


async function initHero() {
  const headingEl = document.querySelector('.hero-title');
  const subEl = document.querySelector('.hero-sub');
  try {
    await withConfigTimeout(
      loadPageHeader(supabase, 'home', {
        imgEl: document.querySelector('.hero-bg'),
        headingEl,
        subEl
      }),
      undefined
    );
  } finally {
    revealConfigContent(headingEl, subEl);
  }
}

async function initGallery() {
  try {
    const images = await withConfigTimeout(loadGalleryImages(supabase), []);
    if (!images.length) return; 

    grid.innerHTML = images.slice(0, 6).map((img, i) => `
      <div class="g-item gi${i + 1}">
        <img src="${escapeHtml(img.image_url)}" alt="${escapeHtml(img.alt_text)}">
      </div>`).join('');
  } finally {
    revealConfigContent(grid);
  }
}

async function initOurStoryTeaser() {
  const target = document.querySelector('.about-text');
  if (!target) return;

  const existingParas = target.querySelectorAll('.about-body');
  const sections = await withConfigTimeout(loadAboutSections(supabase), []);
  const teaser = sections.find(s => s.section_key === 'home_teaser');
  if (!teaser || !teaser.body) {
    revealConfigContent(...existingParas); // still in the DOM, untouched — reveal the fallback
    return;
  }

  const rendered = renderPolicyBlocks(parsePolicyBody(teaser.body));
  const wrapper = document.createElement('div');
  wrapper.innerHTML = rendered;
  wrapper.querySelectorAll('p, h4, ul').forEach(el => {
    if (el.tagName === 'P') el.classList.add('about-body');
  });

  if (existingParas.length) {
    existingParas[0].replaceWith(wrapper);
    existingParas.forEach((p, i) => { if (i > 0) p.remove(); });
  }
}

async function initServices() {
  const grid = document.querySelector('.services-grid');
  if (!grid) return;

  try {
    const { data, error } = await withConfigTimeout(
      supabase
        .from('landing_service')
        .select('image_url, title, description, link_url, link_label')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      { data: null, error: null }
    );
    if (error || !data || !data.length) return; // keep the 3 hardcoded cards as fallback

    grid.innerHTML = data.map((s, i) => `
      <div class="service-card">
        ${s.image_url ? `<img class="service-card-img" src="${escapeHtml(s.image_url)}" alt="${escapeHtml(s.title)}" />` : ''}
        <div class="service-card-body">
          <p class="service-num">${String(i + 1).padStart(2, '0')}</p>
          <h3 class="service-title">${escapeHtml(s.title)}</h3>
          ${s.description ? `<p class="service-desc">${escapeHtml(s.description)}</p>` : ''}
          ${s.link_url ? `<a href="${escapeHtml(s.link_url)}" class="service-link">${escapeHtml(s.link_label || 'Learn more')}</a>` : ''}
        </div>
      </div>`).join('');
  } catch (err) {
    // Falls back to the static homepage content already in the HTML.
  } finally {
    revealConfigContent(grid);
  }
}

async function initLocations() {
  const grid = document.querySelector('.locations-grid');
  const badgeNum = document.querySelector('.about-badge-num');

  try {
    const { data, error } = await supabase
      .from('business_location')
      .select('branch_tag, name, address, hours_label')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error || !data) return;

    // The circle badge over the Our Story photo always reflects the real,
    // live location count rather than being separately configured.
    if (badgeNum && data.length) badgeNum.textContent = String(data.length);

    if (!grid || !data.length) return;

    grid.innerHTML = data.map(loc => `
      <div class="loc-card">
        ${loc.branch_tag ? `<p class="loc-tag">${escapeHtml(loc.branch_tag)}</p>` : ''}
        <h3 class="loc-name">${escapeHtml(loc.name)}</h3>
        <div class="loc-row">
          <i class="ti ti-map-pin"></i>
          <span>${escapeHtml(loc.address)}</span>
        </div>
        ${loc.hours_label ? `
        <hr class="loc-divider" />
        <div class="loc-hours">
          <span class="badge-open">Open</span>
          <span>${escapeHtml(loc.hours_label)}</span>
        </div>` : ''}
      </div>`).join('');
  } catch (err) {
    // Falls back to the static homepage content already in the HTML.
  }
}

initGallery();
initOurStoryTeaser();
initServices();
initLocations();
