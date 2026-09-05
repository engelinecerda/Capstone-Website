// home_content.js — wires index.html's hero, gallery, Our Story teaser,
// What We Offer services, and Find Us locations to Page Content /
// Business Profile.
//
// Render order: every configurable text/grid region below carries a
// .cfg-loading class already in index.html's markup (shimmer overlay
// covering the existing hardcoded copy from first paint — see
// css/styles.css), and is revealed here only once its fetch settles —
// success, "not configured", or error/timeout all reveal. This guarantees
// the admin-configured value is what customers see on the
// real render path; the hardcoded HTML underneath is never removed, so it
// still serves as the fallback for the "not configured"/error/timeout
// cases (and as a pure-CSS safety net if this script never runs at all).
// The hero background photo is left out of this treatment deliberately —
// a photo swap isn't the "flashing wrong information" problem this fixes,
// and .hero-section's fixed-height/overflow:hidden layout is a higher-risk
// touchpoint for the one prize above-the-fold element on the page.
import { customerSupabase as supabase } from './supabase.js';
import { fetchPageHeader, loadGalleryImages, loadAboutSections, revealConfigContent, withConfigTimeout } from './page_content.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';
import { optimizedImageUrl } from './cloudinary_optimized_image_delivery.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function initHero() {
  const headingEl = document.querySelector('.hero-title');
  const subEl = document.querySelector('.hero-sub');
  const imgEl = document.querySelector('.hero-bg');
  try {
    // fetchPageHeader() only returns data — it never touches the DOM — so
    // if the timeout wins this race, a slow fetch that resolves later has
    // nothing left to apply and simply gets discarded. That's what stops
    // the fallback (revealed below) from being silently overwritten a
    // moment after the customer already sees it.
    const data = await withConfigTimeout(fetchPageHeader(supabase, 'home'), null);
    if (!data) return; // keep the existing hardcoded fallback

    if (imgEl && data.image_url) {
      imgEl.src = data.image_url;
      if (data.alt_text) imgEl.alt = data.alt_text;
    }
    if (headingEl && data.heading) headingEl.textContent = data.heading;
    if (subEl && data.subheading) subEl.textContent = data.subheading;
  } finally {
    revealConfigContent(headingEl, subEl);
  }
}

async function initGallery() {
  const grid = document.querySelector('.gallery-grid');
  if (!grid) return;

  try {
    const images = await withConfigTimeout(loadGalleryImages(supabase), []);
    if (!images.length) return; // keep the existing hardcoded 6 images as fallback

    // The mosaic layout (css/home.css .gi1-.gi6) is a fixed 6-tile grid — show
    // up to the 6 highest-priority active photos in that same mosaic shape.
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

  // Only the 2 <p class="about-body"> paragraphs are dynamic — the eyebrow,
  // headline, and pull-quote stay fixed page chrome (same boundary as
  // About's own section headlines), so only they get the skeleton.
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
    // The skeleton-classed paragraphs are removed here, not revealed — the
    // fresh (unclassed) wrapper that replaces them needs no reveal step.
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
        ${s.image_url ? `<img class="service-card-img" src="${escapeHtml(optimizedImageUrl(s.image_url))}" alt="${escapeHtml(s.title)}" />` : ''}
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
    const { data, error } = await withConfigTimeout(
      supabase
        .from('business_location')
        .select('branch_tag, name, address, hours_label')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      { data: null, error: null }
    );
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
  } finally {
    if (grid) revealConfigContent(grid);
  }
}

initHero();
initGallery();
initOurStoryTeaser();
initServices();
initLocations();