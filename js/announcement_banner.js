// announcement_banner.js — injects the single highest-priority active
// announcement as a banner at the top of the page, on the customer-facing
// pages that load this script. Does nothing if no announcement is active,
// so absent pages/states never reserve layout space for it. Re-checks on
// tab focus/visibility and a slow poll (initAutoRefresh, same pattern used
// everywhere else in the app) so a newly-posted announcement appears
// without the customer needing to manually reload the page.
import { customerSupabase as supabase } from './supabase.js';
import { pickActiveAnnouncement, renderAnnouncementBannerHtml } from './announcement_helpers.js';
import { initAutoRefresh } from './auto_refresh.js';

const DISMISS_KEY = 'dismissedAnnouncementId';

// Keeps the navbar (css/styles.css, `top: var(--ann-banner-h, 0px)`) docked
// directly under the banner instead of overlapping it, and reset to 0 when
// there's no banner. Re-measured on resize too, since the banner can wrap
// to a second line on a narrower viewport and change height.
function syncBannerHeightVar() {
  const banner = document.querySelector('body > .ann-banner');
  document.documentElement.style.setProperty('--ann-banner-h', banner ? banner.offsetHeight + 'px' : '0px');
}

function removeBanner() {
  document.querySelector('.ann-banner')?.remove();
  syncBannerHeightVar();
}

async function refreshAnnouncementBanner() {
  const { data, error } = await supabase.from('announcement').select('*');
  if (error || !data || !data.length) {
    removeBanner();
    return;
  }

  const active = pickActiveAnnouncement(data);
  if (!active) {
    removeBanner();
    return;
  }

  const existing = document.querySelector('.ann-banner');
  if (existing && existing.dataset.id === String(active.id)) return; // already showing this one

  if (active.is_dismissible && localStorage.getItem(DISMISS_KEY) === active.id) {
    removeBanner();
    return;
  }

  removeBanner();

  const wrap = document.createElement('div');
  wrap.innerHTML = renderAnnouncementBannerHtml(active);
  const banner = wrap.firstElementChild;
  document.body.prepend(banner);
  syncBannerHeightVar();

  const dismissBtn = banner.querySelector('.ann-banner-dismiss');
  dismissBtn?.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, active.id);
    removeBanner();
  });
}

refreshAnnouncementBanner();
initAutoRefresh(refreshAnnouncementBanner);
window.addEventListener('resize', syncBannerHeightVar);