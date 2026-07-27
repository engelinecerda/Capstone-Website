// about_content.js — wires about.html's hero and the 3 About sections
// (Who We Are / Our Values / Our Mission) to Page Content. Uses the same
// parsePolicyBody/renderPolicyBlocks renderer as the admin editor's
// preview, so what an admin previews is exactly what ships here.
import { customerSupabase as supabase } from './supabase.js';
import { loadPageHeader, loadAboutSections } from './page_content.js';
import { parsePolicyBody, renderPolicyBlocks } from './policy_text.js';

async function initAboutSections() {
  const sections = await loadAboutSections(supabase);
  if (!sections.length) return; // keep the existing hardcoded copy as fallback

  const targets = {
    who_we_are: document.getElementById('aboutWhoWeAreBody'),
    values: document.getElementById('aboutValuesGrid'),
    mission: document.getElementById('aboutMissionBody')
  };

  sections.forEach(section => {
    const el = targets[section.section_key];
    if (!el || !section.body) return;
    el.innerHTML = renderPolicyBlocks(parsePolicyBody(section.body));
    if (section.section_key === 'values') el.classList.add('values-grid--freeform');
  });
}

loadPageHeader(supabase, 'about', {
  imgEl: document.querySelector('.page-hero-img'),
  headingEl: document.querySelector('.page-hero-title'),
  subEl: document.querySelector('.page-hero-sub')
});
initAboutSections();
