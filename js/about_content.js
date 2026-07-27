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
import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader, loadAboutSections, loadAboutValues } from './page_content.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function initAboutSections() {
  const sections = await loadAboutSections(supabase);
  if (!sections.length) return; // keep the existing hardcoded copy as fallback

  const targets = {
    who_we_are: document.getElementById('aboutWhoWeAreBody')
  };

  sections.forEach(section => {
    const el = targets[section.section_key];
    if (!el || !section.body) return;
    el.innerHTML = renderPolicyBlocks(parsePolicyBody(section.body));
  });
}

async function initAboutValues() {
  const items = await loadAboutValues(supabase);
  if (!items.length) return; // keep the existing hardcoded 4-card fallback

  const grid = document.getElementById('aboutValuesGrid');
  if (!grid) return;

  grid.innerHTML = items.map((v) => `
    <div class="value-card">
      <div class="value-card-icon">
        <i class="ti ${escapeHtml(v.icon)}" aria-hidden="true"></i>
      </div>
      <h3>${escapeHtml(v.label)}</h3>
      <p>${escapeHtml(v.description)}</p>
    </div>`
  ).join('');
}

loadPageHeader(supabase, 'about', {
  imgEl: document.querySelector('.page-hero-img'),
  headingEl: document.querySelector('.page-hero-title'),
  subEl: document.querySelector('.page-hero-sub')
});
initAboutSections();
initAboutValues();
