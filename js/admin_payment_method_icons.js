// js/admin_payment_method_icons.js
// Inline SVG path bodies for payment-method icons, matching the same
// hand-drawn convention as js/admin_nav_icons.js (24x24 viewBox,
// stroke="currentColor" stroke-width="2"). No external icon library/CDN —
// the admin portal has no Tabler (or other) icon-font dependency anywhere;
// that CDN is only ever loaded on customer-facing pages, for unrelated UI.
export const PAYMENT_METHOD_ICONS = {
  'cash': '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="6" y1="9" x2="6" y2="9.01"/><line x1="18" y1="15" x2="18" y2="15.01"/>',
  'credit-card': '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
  'building-bank': '<path d="M3 21h18"/><path d="M4 21V9l8-5 8 5v12"/><line x1="9" y1="21" x2="9" y2="12"/><line x1="15" y1="21" x2="15" y2="12"/>',
  'wallet': '<path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3"/><path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/><path d="M17 12h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3a2 2 0 0 1 0-4z"/>',
  'receipt': '<path d="M6 2h12v18l-2.5-1.5L13 20l-2-1.5-2 1.5-2.5-1.5L4 20V4a2 2 0 0 1 2-2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/>'
};

export function paymentMethodIconSvg(key) {
  const body = PAYMENT_METHOD_ICONS[key] || PAYMENT_METHOD_ICONS['receipt'];
  return `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}
