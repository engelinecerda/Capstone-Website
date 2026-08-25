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
