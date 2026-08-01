// page_content.js — shared customer-side loader for admin-configurable page
// content (page_header, gallery_image, about_section, faq). Every function
// fails silently — a Page Content outage must never break a customer-facing
// page; the page's existing hardcoded markup stays on screen if a fetch
// fails or a row is missing.

export async function loadPageHeader(supabase, pageKey, { imgEl, headingEl, subEl } = {}) {
  try {
    const { data, error } = await supabase
      .from('page_header')
      .select('heading, subheading, image_url, alt_text')
      .eq('page_key', pageKey)
      .maybeSingle();
    if (error || !data) return;

    if (imgEl && data.image_url) {
      imgEl.src = data.image_url;
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
    return data || [];
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
    return data || [];
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
    return data;
  } catch (err) {
    return null;
  }
}
