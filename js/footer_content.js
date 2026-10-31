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

// ── Footer email: let the visitor choose their email service ─────────────────
// A bare mailto: opens whatever the device has set as its default (often
// Outlook), which is wrong for many visitors. Clicking the footer email now
// opens a small menu: Gmail first, then Outlook, Yahoo Mail, or the device's
// default app. The link keeps its mailto: href as the fallback (no JS,
// middle-click, copy link). Styles are injected here so no CSS file/cache bump
// is needed.
const MAIL_PROVIDERS = [
  { label: 'Gmail',              icon: 'ti-brand-google', url: (to) => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}` },
  { label: 'Outlook',            icon: 'ti-brand-windows', url: (to) => `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(to)}` },
  { label: 'Yahoo Mail',         icon: 'ti-mail',          url: (to) => `https://compose.mail.yahoo.com/?to=${encodeURIComponent(to)}` },
  { label: 'Default email app',  icon: 'ti-mail-forward',  url: (to) => `mailto:${to}`, sameTab: true }
];

let mailMenuEl = null;

function closeMailMenu() {
  if (!mailMenuEl) return;
  mailMenuEl.remove();
  mailMenuEl = null;
  document.removeEventListener('keydown', onMailMenuKey, true);
}

function onMailMenuKey(e) {
  if (e.key === 'Escape') closeMailMenu();
}

function ensureMailMenuStyles() {
  if (document.getElementById('footer-mail-menu-style')) return;
  const style = document.createElement('style');
  style.id = 'footer-mail-menu-style';
  style.textContent = `
    .footer-mail-menu { position: fixed; z-index: 10000; min-width: 210px; max-width: calc(100vw - 24px);
      background: #fff; color: #3D1A0A; border: 1px solid rgba(61,26,10,.14); border-radius: 12px;
      box-shadow: 0 12px 36px rgba(30,12,3,.28); padding: 6px; font-family: inherit; }
    .footer-mail-menu-title { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: #9E7558; padding: 8px 10px 6px; }
    .footer-mail-menu a { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px;
      font-size: 13.5px; color: #3D1A0A !important; text-decoration: none; }
    .footer-mail-menu a:hover, .footer-mail-menu a:focus-visible { background: #F2EBE0; outline: none; }
    .footer-mail-menu a i { font-size: 16px; color: #9E7558; }
  `;
  document.head.appendChild(style);
}

function openMailMenu(anchorEl, address) {
  closeMailMenu();
  ensureMailMenuStyles();

  const menu = document.createElement('div');
  menu.className = 'footer-mail-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = '<div class="footer-mail-menu-title">Open with</div>' + MAIL_PROVIDERS.map((p) =>
    `<a href="${escapeHtml(p.url(address))}" role="menuitem"${p.sameTab ? '' : ' target="_blank" rel="noopener noreferrer"'}>` +
    `<i class="ti ${p.icon}" aria-hidden="true"></i>${escapeHtml(p.label)}</a>`
  ).join('');
  document.body.appendChild(menu);
  mailMenuEl = menu;

  // Place next to the link: above it when there is no room below (the footer
  // sits at the bottom of the page), kept inside the viewport horizontally.
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= menuRect.height + 12 ? rect.bottom + 8 : Math.max(8, rect.top - menuRect.height - 8);
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - menuRect.width - 12);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  menu.addEventListener('click', (e) => { if (e.target.closest('a')) setTimeout(closeMailMenu, 0); });
  document.addEventListener('keydown', onMailMenuKey, true);
  menu.querySelector('a')?.focus();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest?.('.footer-new-contact-row a[href^="mailto:"]');
  if (link) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" etc. behave normally
    e.preventDefault();
    openMailMenu(link, link.getAttribute('href').replace(/^mailto:/i, ''));
    return;
  }
  if (mailMenuEl && !e.target.closest('.footer-mail-menu')) closeMailMenu();
});

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

    await appendExtraSocialLinks();

    const phoneSpan = document.querySelector('.footer-new-contact-row .ti-phone')?.closest('.footer-new-contact-row')?.querySelector('span');
    if (phoneSpan && data.phone) phoneSpan.textContent = data.phone;

    // The email row ships hidden and empty in every page's HTML (nothing hardcoded),
    // so the address always comes from Business Profile > Contact & Social. It is
    // shown as a mailto: link only when an email is saved.
    const emailRow = document.querySelector('.footer-new-contact-row .ti-mail')?.closest('.footer-new-contact-row');
    const emailSpan = emailRow?.querySelector('span');
    if (emailRow && emailSpan && data.email) {
      let emailLink = emailSpan.querySelector('a');
      if (!emailLink) {
        emailLink = document.createElement('a');
        emailSpan.textContent = '';
        emailSpan.appendChild(emailLink);
      }
      emailLink.textContent = data.email;
      emailLink.href = `mailto:${data.email}`;
      emailRow.style.display = '';
    }

    // Navbar logo only — the footer keeps its own separate image
    // (.footer-new-logo, a different crop meant for its dark background).
    const navLogoEl = document.querySelector('.logo');
    if (navLogoEl && data.logo_url) navLogoEl.src = optimizedImageUrl(data.logo_url, 480);
    if (navLogoEl && data.brand_name) navLogoEl.alt = `${data.brand_name} Logo`;
  } catch (err) {
    // Falls back to the static footer text already in the HTML (the email row stays hidden).
  }
}

// Facebook/Instagram keep their own two fixed icon slots (above) — anything
// an admin adds beyond those two (business_social_link, added from the
// Business Profile > Additional Contacts & Social Links list) is appended
// after them with a generic link icon, since we can't guess a brand icon
// for an arbitrary platform label.
async function appendExtraSocialLinks() {
  try {
    const { data, error } = await supabase
      .from('business_social_link')
      .select('label, url')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error || !data || !data.length) return;

    const socialRow = document.querySelector('.footer-new-social');
    if (!socialRow) return;

    data.forEach((link) => {
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.setAttribute('aria-label', link.label);
      a.innerHTML = '<i class="ti ti-external-link"></i>';
      socialRow.appendChild(a);
    });
  } catch (err) {
    // Fixed Facebook/Instagram icons still work — this is additive only.
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
      `<li><a href="${escapeHtml(s.link_url || '/packages')}">${escapeHtml(s.title)}</a></li>`
    ).join('');
  } catch (err) {
    // Falls back to the static footer text already in the HTML.
  }
}

loadBusinessContact();
loadFooterLocationsSummary();
loadFooterServices();