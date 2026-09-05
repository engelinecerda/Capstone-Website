// page_content.js — shared customer-side loader for admin-configurable page
// content (page_header, gallery_image, about_section, faq). Every function
// fails silently — a Page Content outage must never break a customer-facing
// page; the page's existing hardcoded markup stays on screen if a fetch
// fails or a row is missing.
//
// Every image_url returned/applied below is passed through
// optimizedImageUrl() (see cloudinary_delivery.js) — Cloudinary's
// q_auto,f_auto delivery transformation — once here, so every caller
// (home/about/packages/faqs/menu headers, the home gallery, menu sections
// and banner) gets optimized images automatically without needing its own
// import. Board item #47.
import { optimizedImageUrl } from './cloudinary_optimized_image_delivery.js';

// ── Config-loading skeleton helper ──────────────────────────────────────
// Paired with the .cfg-loading CSS class (css/styles.css — see that rule's
// own header comment for the full mechanism). The class itself is baked
// directly into index.html/about.html's markup on every configurable
// element, not added by script — a script-added class would still leave a
// gap between first paint and module execution where the hardcoded text
// is briefly visible, which is exactly the flash this is meant to remove.
// js/home_content.js and js/about_content.js (the "landing/landing-
// adjacent" pages) only need to call this to remove the class once a
// fetch settles; faqs.html/menu.html call the loaders above directly
// without it, so their render order is unchanged.
//
// Must be called on every path (success, "not configured", error) or the
// element shimmers until the CSS-only 8s safety net takes over — callers
// use try/finally to guarantee that.
export function revealConfigContent(...elements) {
  elements.forEach((el) => el?.classList.remove('cfg-loading'));
}

// Races a fetch against a timeout so a slow/cold-cache fetch can't hold a
// skeleton up indefinitely — resolves to the fetch's own result if it
// wins, or `timeoutValue` (shaped like that loader's own "nothing found"
// result, e.g. [] or { data: null, error: null }) if the clock runs out
// first. The fetch itself is not aborted, so if it resolves shortly after
// the timeout it still applies normally — this only bounds how long the
// skeleton is shown, not the underlying request.
export function withConfigTimeout(fetchPromise, timeoutValue, ms = 6000) {
  return Promise.race([
    fetchPromise,
    new Promise((resolve) => setTimeout(() => resolve(timeoutValue), ms)),
  ]);
}

export async function loadPageHeader(supabase, pageKey, { imgEl, headingEl, subEl } = {}) {
  try {
    const { data, error } = await supabase
      .from('page_header')
      .select('heading, subheading, image_url, alt_text')
      .eq('page_key', pageKey)
      .maybeSingle();
    if (error || !data) return;

    if (imgEl && data.image_url) {
      imgEl.src = optimizedImageUrl(data.image_url);
      if (data.alt_text) imgEl.alt = data.alt_text;
    }
    if (headingEl && data.heading) headingEl.textContent = data.heading;
    if (subEl && data.subheading) subEl.textContent = data.subheading;
  } catch (err) {
    // Falls back to the static heading already in the HTML.
  }
}

export async function loadGalleryImages(supabase) {
  try {
    const { data, error } = await supabase
      .from('gallery_image')
      .select('image_url, caption, alt_text')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) return [];
    return (data || []).map((row) => ({ ...row, image_url: optimizedImageUrl(row.image_url) }));
  } catch (err) {
    return [];
  }
}

export async function loadAboutSections(supabase) {
  try {
    const { data, error } = await supabase
      .from('about_section')
      .select('section_key, title, body')
      .order('sort_order', { ascending: true });
    if (error) return [];
    return data || [];
  } catch (err) {
    return [];
  }
}

export async function loadFaqs(supabase) {
  try {
    const { data, error } = await supabase
      .from('faq')
      .select('id, question, answer')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) return [];
    return data || [];
  } catch (err) {
    return [];
  }
}

export async function loadMenuSections(supabase) {
  try {
    const { data, error } = await supabase
      .from('menu_section')
      .select('id, heading, image_url, alt_text')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) return [];
    return (data || []).map((row) => ({ ...row, image_url: optimizedImageUrl(row.image_url) }));
  } catch (err) {
    return [];
  }
}

export async function loadAboutValues(supabase) {
  try {
    const { data, error } = await supabase
      .from('about_value')
      .select('id, label, description, icon')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) return [];
    return data || [];
  } catch (err) {
    return [];
  }
}

export async function loadMenuBanner(supabase) {
  try {
    const { data, error } = await supabase
      .from('menu_banner')
      .select('label, heading, description, image_url, alt_text, is_active')
      .eq('id', true)
      .maybeSingle();
    if (error || !data) return null;
    return { ...data, image_url: optimizedImageUrl(data.image_url) };
  } catch (err) {
    return null;
  }
}