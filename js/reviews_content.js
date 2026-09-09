// reviews_content.js — wires reviews.html's page-hero heading/subheading (and
// optionally its background image) to Page Content (page_key 'reviews'),
// same pattern as js/about_content.js's initHero(). The hardcoded markup in
// reviews.html is never removed, so it doubles as the fallback for the
// "not configured"/error/timeout cases.
import { customerSupabase as supabase } from './supabase.js';
import { fetchPageHeader, revealConfigContent, withConfigTimeout } from './page_content.js';

async function initHero() {
  const headingEl = document.querySelector('.page-hero-title');
  const subEl = document.querySelector('.page-hero-sub');
  const imgEl = document.querySelector('.page-hero-img');
  try {
    const data = await withConfigTimeout(fetchPageHeader(supabase, 'reviews', 1920), null);
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

initHero();
