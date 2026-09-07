// footer_content.js — wires the site-wide footer (byte-identical markup
// copy-pasted across index/about/faqs/packages/reservations/reviews/menu)
// to Business Profile + Services. Deliberately uses selectors that already
// uniquely identify each target (aria-label, icon class, heading text) so
// no page's footer markup needs to change — only a script tag is added.
import { customerSupabase as supabase } from './supabase.js';
import { optimizedImageUrl } from './cloudinary_optimized_image_delivery.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function loadBusinessContact() {
  try {
    const { data, error } = await supabase.from('business_contact').select('*').eq('id', true).maybeSingle();
    if (error || !data) return;

    const descEl = document.querySelector('.footer-new-brand-desc');
    if (descEl && data.brand_description) descEl.textContent = data.brand_description;

    const fbLink = document.querySelector('.footer-new-social a[aria-label="Facebook"]');
    if (fbLink && data.facebook_url) fbLink.href = data.facebook_url;

    const igLink = document.querySelector('.footer-new-social a[aria-label="Instagram"]');
    if (igLink && data.instagram_url) igLink.href = data.instagram_url;

    const phoneSpan = document.querySelector('.footer-new-contact-row .ti-phone')?.closest('.footer-new-contact-row')?.querySelector('span');
    if (phoneSpan && data.phone) phoneSpan.textContent = data.phone;

    const emailSpan = document.querySelector('.footer-new-contact-row .ti-mail')?.closest('.footer-new-contact-row')?.querySelector('span');
    if (emailSpan && data.email) emailSpan.textContent = data.email;

    // Navbar logo only — the footer keeps its own separate image
    // (.footer-new-logo, a different crop meant for its dark background).
    const navLogoEl = document.querySelector('.logo');
    if (navLogoEl && data.logo_url) navLogoEl.src = optimizedImageUrl(data.logo_url, 480);
    if (navLogoEl && data.brand_name) navLogoEl.alt = `${data.brand_name} Logo`;
  } catch (err) {
    // Falls back to the static footer text already in the HTML.
  }
}

async function loadFooterLocationsSummary() {
  try {
    const { data, error } = await supabase
      .from('business_location')
      .select('name')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error || !data || !data.length) return;

    const addressSpan = document.querySelector('.footer-new-contact-row .ti-map-pin')?.closest('.footer-new-contact-row')?.querySelector('span');
    if (!addressSpan) return;

    // Mirrors the current hardcoded summary style: short place names joined
    // with "&", not full addresses — those live in Find Us / Business
    // Profile's own location list, not repeated in the footer.
    const shortNames = data.map(loc => (loc.name || '').split(',')[0].replace(/^ELI Coffee( Events Cafe)?\s*/i, '').trim() || loc.name);
    addressSpan.textContent = shortNames.join(' & ');
  } catch (err) {
    // Falls back to the static footer text already in the HTML.
  }
}

async function loadFooterServices() {
  try {
    const { data, error } = await supabase
      .from('landing_service')
      .select('title, link_url')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error || !data || !data.length) return;

    const servicesHeading = Array.from(document.querySelectorAll('.footer-new-heading'))
      .find(p => p.textContent.trim() === 'Services');
    const servicesList = servicesHeading?.nextElementSibling;
    if (!servicesList || servicesList.tagName !== 'UL') return;

    servicesList.innerHTML = data.map(s =>
      `<li><a href="${escapeHtml(s.link_url || '/packages.html')}">${escapeHtml(s.title)}</a></li>`
    ).join('');
  } catch (err) {
    // Falls back to the static footer text already in the HTML.
  }
}

loadBusinessContact();
loadFooterLocationsSummary();
loadFooterServices();