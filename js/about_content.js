// about_content.js — wires about.html's hero, the Who We Are long-form
// text, and the Our Values icon cards to Page Content. Long-form text uses
// the same parsePolicyBody/renderPolicyBlocks renderer as the admin
// editor's preview, so what an admin previews is exactly what ships here.
// Values are a separate, structured repeatable list (about_value — label +
// description + icon), not free text, so they get their own loader/
// renderer instead of going through that markdown-ish pipeline.
//
// The Our Mission section was removed from about.html (read as visually
// fused with the dark footer below it) — the admin's About Page editor
// still has a Mission row (about_section.section_key='mission') since
// removal wasn't asked for there, it's just unread by this page now.
//
// Render order: every configurable region below (.page-hero-title,
// .page-hero-sub, #aboutWhoWeAreBody, #aboutValuesGrid) carries a
// .cfg-loading class already in about.html's markup (shimmer overlay
// covering the existing hardcoded copy from first paint — see
// css/styles.css), and is revealed here only once its fetch settles —
// success, "not configured", or error/timeout all reveal. The hardcoded
// HTML underneath is never removed, so it doubles as the fallback for the
// "not configured"/error/timeout cases (and as a pure-CSS safety net if
// this script never runs at all). The hero background photo is left out
// of this treatment deliberately, same as index.html's hero.
import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader, loadAboutSections, loadAboutValues, revealConfigContent, withConfigTimeout } from './page_content.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function initHero() {
  const headingEl = document.querySelector('.page-hero-title');
  const subEl = document.querySelector('.page-hero-sub');
  try {
    await withConfigTimeout(
      loadPageHeader(supabase, 'about', {
        imgEl: document.querySelector('.page-hero-img'),
        headingEl,
        subEl
      }),
      undefined
    );
  } finally {
    revealConfigContent(headingEl, subEl);
  }
}

async function initAboutSections() {
  const el = document.getElementById('aboutWhoWeAreBody');
  try {
    const sections = await withConfigTimeout(loadAboutSections(supabase), []);
    if (!sections.length) return; // keep the existing hardcoded copy as fallback

    const targets = { who_we_are: el };
    sections.forEach(section => {
      const target = targets[section.section_key];
      if (!target || !section.body) return;
      target.innerHTML = renderPolicyBlocks(parsePolicyBody(section.body));
    });
  } finally {
    revealConfigContent(el);
  }
}

async function initAboutValues() {
  const grid = document.getElementById('aboutValuesGrid');
  if (!grid) return;

  try {
    const items = await withConfigTimeout(loadAboutValues(supabase), []);
    if (!items.length) return; // keep the existing hardcoded 4-card fallback

    grid.innerHTML = items.map((v) => `
      <div class="value-card">
        <div class="value-card-icon">
          <i class="ti ${escapeHtml(v.icon)}" aria-hidden="true"></i>
        </div>
        <h3>${escapeHtml(v.label)}</h3>
        <p>${escapeHtml(v.description)}</p>
      </div>`
    ).join('');
  } finally {
    revealConfigContent(grid);
  }
}

initHero();
initAboutSections();
initAboutValues();
