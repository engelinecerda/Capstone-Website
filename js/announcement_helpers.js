// announcement_helpers.js — the single "what's active right now" resolver,
// shared by the admin Announcements page and the customer banner so the
// two never disagree about what a customer would actually see.

export const KIND_LABELS = {
  info: 'Info',
  scheduled_maintenance: 'Scheduled Maintenance',
  urgent: 'Urgent'
};

const KIND_PRIORITY = { urgent: 3, scheduled_maintenance: 2, info: 1 };

// Computed fresh from is_enabled + the time window against `now` — never
// read off a stored flag, so it can't go stale between visits.
export function computeAnnouncementStatus(a, now = new Date()) {
  if (!a.is_enabled) return 'disabled';
  const starts = a.starts_at ? new Date(a.starts_at) : null;
  const ends = a.ends_at ? new Date(a.ends_at) : null;
  if (starts && now < starts) return 'scheduled';
  if (ends && now >= ends) return 'expired';
  return 'live';
}

export function isAnnouncementActive(a, now = new Date()) {
  return computeAnnouncementStatus(a, now) === 'live';
}

// Highest priority active announcement wins (urgent > scheduled_maintenance
// > info); ties broken by most recently updated. Returns null if nothing is
// currently active. One banner at a time, by design (see implementation
// notes) — no stacking.
export function pickActiveAnnouncement(announcements, now = new Date()) {
  const active = (announcements || []).filter(a => isAnnouncementActive(a, now));
  if (!active.length) return null;

  active.sort((a, b) => {
    const diff = (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0);
    if (diff !== 0) return diff;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return active[0];
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const KIND_ICONS = {
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12.01" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/>',
  scheduled_maintenance: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>',
  urgent: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
};

// Single source of truth for the banner's markup — used identically by the
// customer-facing banner (js/announcement_banner.js) and the admin editor's
// live preview (js/admin_announcements.js), so what the admin previews is
// exactly what a customer would see, not an approximation.
export function renderAnnouncementBannerHtml(a) {
  const kind = KIND_ICONS[a.kind] ? a.kind : 'info';
  const icon = `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">${KIND_ICONS[kind]}</svg>`;
  const cta = (a.link_url && a.link_label)
    ? `<a class="ann-banner-cta" href="${escapeHtml(a.link_url)}">${escapeHtml(a.link_label)}</a>`
    : '';
  const dismiss = a.is_dismissible
    ? `<button type="button" class="ann-banner-dismiss" aria-label="Dismiss this announcement">
         <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
       </button>`
    : '';

  return `
    <div class="ann-banner ann-banner--${kind}" data-id="${escapeHtml(a.id || '')}" role="status">
      <span class="ann-banner-icon">${icon}</span>
      <p class="ann-banner-text">${escapeHtml(a.message || '')}</p>
      <div class="ann-banner-actions">${cta}${dismiss}</div>
    </div>`;
}
