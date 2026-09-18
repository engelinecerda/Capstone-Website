// package_discount_helpers.js — the single "what discount applies right
// now" resolver, shared by the admin Bookable Inventory page and every
// customer-facing page that shows a package price, so they never disagree
// about what a customer would actually see. Modeled on
// announcement_helpers.js's computeAnnouncementStatus/isAnnouncementActive.

// Computed fresh from is_active + the time window against `now` — never a
// stored "is it live" flag, so it can't go stale between visits.
export function computeDiscountStatus(d, now = new Date()) {
  if (!d || !d.is_active) return 'off';
  const starts = d.starts_at ? new Date(d.starts_at) : null;
  const ends = d.ends_at ? new Date(d.ends_at) : null;
  if (starts && now < starts) return 'scheduled';
  if (ends && now >= ends) return 'expired';
  return 'active';
}

export function isDiscountActive(d, now = new Date()) {
  return computeDiscountStatus(d, now) === 'active';
}

// A package can have several historical package_discount rows (expired ones
// are deactivated, not deleted), but at most one with is_active=true at a
// time (enforced by a partial unique index) — so "active" is unambiguous.
// Returns null if none of the given rows is currently active.
export function pickActiveDiscount(discounts, now = new Date()) {
  return (discounts || []).find(d => isDiscountActive(d, now)) || null;
}

// Applies a discount to a list price. discount may be null/undefined (no
// discount row) or an inactive row — both resolve to the "no discount"
// shape so callers don't need to branch twice.
export function applyDiscount(listPrice, discount, now = new Date()) {
  const price = Number(listPrice || 0);
  const active = isDiscountActive(discount, now);
  if (!active) {
    return { listPrice: price, active: false, discountAmount: 0, discountedPrice: price, percentOff: 0, label: '' };
  }
  const percentOff = Number(discount.percent_off || 0);
  const discountAmount = Math.round(price * percentOff) / 100;
  return {
    listPrice: price,
    active: true,
    discountAmount,
    discountedPrice: price - discountAmount,
    percentOff,
    label: discount.label || ''
  };
}
