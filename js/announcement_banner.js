// announcement_banner.js — injects the single highest-priority active
// announcement as a banner at the top of the page, on the customer-facing
// pages that load this script. Does nothing if no announcement is active,
// so absent pages/states never reserve layout space for it.
import { customerSupabase as supabase } from './supabase.js';
import { pickActiveAnnouncement, renderAnnouncementBannerHtml } from './announcement_helpers.js';

const DISMISS_KEY = 'dismissedAnnouncementId';

async function initAnnouncementBanner() {
  const { data, error } = await supabase.from('announcement').select('*');
  if (error || !data || !data.length) return;

  const active = pickActiveAnnouncement(data);
  if (!active) return;

  if (active.is_dismissible && localStorage.getItem(DISMISS_KEY) === active.id) {
    // Dismissed already — a different (newer) announcement still shows,
    // since this check is keyed to this specific id, not "any dismissal".
    return;
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = renderAnnouncementBannerHtml(active);
  const banner = wrap.firstElementChild;
  document.body.prepend(banner);

  const dismissBtn = banner.querySelector('.ann-banner-dismiss');
  dismissBtn?.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, active.id);
    banner.remove();
  });
}

initAnnouncementBanner();
