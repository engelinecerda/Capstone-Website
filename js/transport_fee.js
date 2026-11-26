// transport_fee.js — pure helpers (no DOM, no network) for the offsite
// transport fee. Used by the booking form (reservations.js) to price a venue
// pin and by Payment Settings (admin_payment_options.js) for the live "try a
// distance" box, so both always do the same maths.
//
// NOTE: the booking form gets the real road distance from the
// calculate-transport-fee edge function (OpenRouteService). The distance
// maths below is the fallback used when that function can't be reached, and
// powers the Payment Settings test box. The fee rule itself is the same in
// both: it is mirrored in supabase/functions/_shared/transport_pricing.ts, and
// _shared/transport_pricing_test.ts fails if the two ever price differently.
//
// Rule (distance ranges): the distance from the NEAREST transport fee starting
// point (a branch flagged business_location.transport_origin that has a map
// pin) to the venue pin is measured in a straight line, multiplied by a road
// factor (roads are longer than the crow flies), and rounded to 0.1 km. That
// distance is then looked up in the admin's list of ranges. Each range means
// "over the previous end, up to and INCLUDING its own end" and has one flat fee:
//
//   up to freeKm              -> free
//   over freeKm, up to 10 km  -> ranges[0].fee
//   over 10, up to 15 km      -> ranges[1].fee   ... and so on
//   over the last end         -> `beyond`: 'contact' (customer must contact us,
//                                nothing is charged automatically), 'last'
//                                (the last range's fee is charged) or 'quote'
//                                (bookable; Eli quotes the fee afterwards)
//
// The settings live in system_settings.payment_rules (same JSON blob as the
// other fees) under the transport_* keys. Until `transport_ranges` has been
// saved once, the old per-km rule (transport_rate_per_km / transport_max_fee)
// keeps pricing, so nothing changes for customers until an admin saves.

import { formatMoney } from './money.js';

export const MAX_TRANSPORT_KM = 500;

// Suggested starting ranges (the cafe's rate card). Used to pre-fill Payment
// Settings the first time; they only take effect once an admin saves.
export const TRANSPORT_DEFAULT_RANGES = Object.freeze([
  Object.freeze({ toKm: 10, fee: 1000 }),
  Object.freeze({ toKm: 15, fee: 2000 }),
  Object.freeze({ toKm: 20, fee: 4500 }),
  Object.freeze({ toKm: 25, fee: 5000 })
]);

export const TRANSPORT_DEFAULTS = Object.freeze({
  enabled: false,     // safe default: nothing changes until an admin opts in
  freeKm: 5,
  beyond: 'contact',  // 'contact' | 'last'
  roadFactor: 1.3
});

const num = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Cleans a saved list of ranges: sorted, ends strictly increasing and past the
// free distance, fees never negative. Shared by the universal rule and the
// per-package overrides.
function cleanRanges(rawRanges, freeKm) {
  const ranges = [];
  let prev = freeKm;
  const sorted = rawRanges
    .map((x) => ({ toKm: num(x?.to_km, NaN), fee: num(x?.fee, NaN) }))
    .filter((x) => Number.isFinite(x.toKm) && Number.isFinite(x.fee))
    .sort((a, b) => a.toKm - b.toKm);
  for (const x of sorted) {
    const toKm = round1(x.toKm);
    if (toKm <= prev || toKm > MAX_TRANSPORT_KM) continue; // keeps ends strictly increasing
    ranges.push({ toKm, fee: round2(Math.max(0, x.fee)) });
    prev = toKm;
  }
  return ranges;
}

// The saved override for one package, or null. Overrides live under
// transport_package_overrides: { "<package_id>": { free_km, ranges: [{ to_km, fee }] } }.
function packageOverrideFor(r, packageId) {
  if (packageId === null || packageId === undefined || packageId === '') return null;
  const all = r.transport_package_overrides;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  const key = String(packageId);
  if (!Object.prototype.hasOwnProperty.call(all, key)) return null;
  const ov = all[key];
  return ov && typeof ov === 'object' && Array.isArray(ov.ranges) ? ov : null;
}

// Turns the raw payment_rules blob into clean, always-valid settings.
// `ranges` is null until the ranges have been saved once (old per-km rule).
// With a packageId, a saved override for that package replaces the universal
// free distance and ranges (everything else — on/off, beyond-the-last-range,
// road factor — stays universal); `packageOverride` says whether it did.
export function readTransportRules(rules, packageId = null) {
  const r = rules || {};
  const maxFee = num(r.transport_max_fee, null);
  const hasRanges = Array.isArray(r.transport_ranges);
  // Free distance default: 10 for the old per-km rule, 5 for ranges.
  let freeKm = Math.max(0, num(r.transport_free_km, hasRanges ? TRANSPORT_DEFAULTS.freeKm : 10));
  let ranges = hasRanges ? cleanRanges(r.transport_ranges, freeKm) : null;

  const ov = packageOverrideFor(r, packageId);
  if (ov) {
    freeKm = Math.max(0, num(ov.free_km, TRANSPORT_DEFAULTS.freeKm));
    ranges = cleanRanges(ov.ranges, freeKm);
  }

  return {
    enabled: r.transport_fee_enabled === true,
    freeKm,
    ranges,
    beyond: r.transport_beyond === 'last' ? 'last' : (r.transport_beyond === 'quote' ? 'quote' : 'contact'),
    roadFactor: Math.max(1, num(r.transport_road_factor, TRANSPORT_DEFAULTS.roadFactor)),
    // Old per-km rule, only used while `ranges` is null.
    ratePerKm: Math.max(0, num(r.transport_rate_per_km, 30)),
    maxFee: maxFee === null ? null : Math.max(0, maxFee),
    packageOverride: !!ov
  };
}

// Great-circle distance in km between two lat/lng points.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Only branches that actually have coordinates can be a starting point.
export function branchesWithCoords(branches) {
  return (branches || []).filter((b) => {
    const lat = Number(b?.latitude);
    const lng = Number(b?.longitude);
    return b?.latitude !== null && b?.latitude !== undefined && b?.longitude !== null && b?.longitude !== undefined
      && Number.isFinite(lat) && Number.isFinite(lng);
  });
}

// Only branches an admin has marked as a "transport fee starting point" (and
// that have a map pin) are used to measure the fee. An active, pinned branch
// that is not flagged — e.g. a branch that doesn't serve offsite events — is
// ignored, so pinning it never changes a price.
export function transportOrigins(branches) {
  return branchesWithCoords(branches).filter((b) => b?.transport_origin === true);
}

export function findNearestBranch(pin, branches) {
  const usable = transportOrigins(branches);
  if (!pin || !usable.length) return null;
  let best = null;
  for (const b of usable) {
    const km = haversineKm(Number(pin.lat), Number(pin.lng), Number(b.latitude), Number(b.longitude));
    if (!best || km < best.straightKm) best = { branch: b, straightKm: km };
  }
  return best;
}

// Prices one road distance (km, already rounded to 0.1). Mirrors
// priceTransportDistance() in supabase/functions/_shared/transport_pricing.ts.
// status: 'free' | 'range' | 'beyond_charged' | 'out_of_range' | 'quote' | 'per_km'.
export function priceTransportDistance(rules, distanceKm) {
  const base = { rangeFrom: null, rangeTo: null, billableKm: 0, capped: false };

  // Old per-km rule: fee = min( max(0, km - freeKm) * ratePerKm , maxFee )
  if (rules.ranges === null) {
    const billableKm = Math.max(0, round2(distanceKm - rules.freeKm));
    let fee = round2(billableKm * rules.ratePerKm);
    let capped = false;
    if (rules.maxFee !== null && fee > rules.maxFee) { fee = round2(rules.maxFee); capped = true; }
    return { ...base, fee, status: 'per_km', billableKm, capped };
  }

  if (distanceKm <= rules.freeKm) return { ...base, fee: 0, status: 'free' };

  let from = rules.freeKm;
  for (const range of rules.ranges) {
    if (distanceKm <= range.toKm) {
      return { ...base, fee: range.fee, status: 'range', rangeFrom: from, rangeTo: range.toKm };
    }
    from = range.toKm;
  }

  // Past the last range (or no ranges at all).
  const last = rules.ranges[rules.ranges.length - 1];
  if (rules.beyond === 'last' && last) {
    const prevEnd = rules.ranges.length > 1 ? rules.ranges[rules.ranges.length - 2].toKm : rules.freeKm;
    return { ...base, fee: last.fee, status: 'beyond_charged', rangeFrom: prevEnd, rangeTo: last.toKm };
  }
  // 'quote': the venue can be booked, the fee is not priced automatically; the
  // booking form creates a transport-fee quote request that Eli prices later.
  return { ...base, fee: 0, status: rules.beyond === 'quote' ? 'quote' : 'out_of_range', rangeFrom: last ? last.toKm : rules.freeKm, rangeTo: null };
}

// Prices a single pin. `applies` is false when the fee is switched off, there
// is no pin yet, or no branch is a transport fee starting point with a pin —
// callers then charge nothing. `outOfRange` is true when the venue is past the
// last range and the admin chose "customer must contact us": the fee is 0 but
// the booking form must not let the customer continue.
export function computeTransportFee(rawRules, pin, branches, packageId = null) {
  const rules = readTransportRules(rawRules, packageId);
  const none = { applies: false, fee: 0, distanceKm: null, status: 'none', rangeFrom: null, rangeTo: null, billableKm: 0, outOfRange: false, originName: '', capped: false, rules };
  if (!rules.enabled) return none;
  const nearest = findNearestBranch(pin, branches);
  if (!nearest) return none;

  const distanceKm = round1(nearest.straightKm * rules.roadFactor);
  const priced = priceTransportDistance(rules, distanceKm);
  return {
    applies: true,
    ...priced,
    outOfRange: priced.status === 'out_of_range',
    distanceKm,
    originName: nearest.branch.name || nearest.branch.branch_tag || 'our branch',
    rules
  };
}

// The area customers can book online. Only exists when the fee is on, ranges
// have been saved, the admin chose "customer must contact us" past the last
// range, and at least one starting point has a pin: one circle per starting
// point, as wide as the last range's end. It is a straight-line circle and a
// road is never shorter than a straight line, so a pin OUTSIDE it is always
// too far; a pin inside can still be too far by road (the exact road check
// stays the final decision). Returns null when there is no limit to show.
export function transportCoverage(rawRules, branches, packageId = null) {
  const rules = readTransportRules(rawRules, packageId);
  if (!rules.enabled || rules.ranges === null || rules.beyond !== 'contact' || !rules.ranges.length) return null;
  const origins = transportOrigins(branches);
  if (!origins.length) return null;
  return {
    radiusKm: rules.ranges[rules.ranges.length - 1].toKm,
    circles: origins.map((b) => ({ lat: Number(b.latitude), lng: Number(b.longitude), name: b.name || b.branch_tag || 'our branch' }))
  };
}

// True when the pin is inside the combined circles (or there is no limit).
export function pinInCoverage(pin, coverage) {
  if (!coverage) return true;
  if (!pin) return false;
  return coverage.circles.some((c) => haversineKm(Number(pin.lat), Number(pin.lng), c.lat, c.lng) <= coverage.radiusKm);
}

const kmText = (n) => `${Number(n)} km`;

// One-line plain-English breakdown, e.g.
// "12.4 km from ELI Coffee Binangonan: 10 to 15 km range"
export function describeTransportFee(result) {
  if (!result?.applies) return '';
  const { distanceKm, originName, rules, status, rangeFrom, rangeTo, billableKm, capped } = result;
  const lead = `${distanceKm} km from ${originName}`;
  switch (status) {
    case 'free': return `${lead} (within the ${kmText(rules.freeKm)} free distance)`;
    case 'range': return `${lead}: ${rangeFrom} to ${kmText(rangeTo)} range`;
    case 'beyond_charged': return `${lead}: beyond ${kmText(rangeTo)}, charged at the last range's fee`;
    case 'out_of_range': return `${lead}: beyond our ${kmText(rangeFrom)} transport range`;
    case 'quote': return `${lead}: beyond our ${kmText(rangeFrom)} range, so we\u2019ll quote the transport fee`;
    default: // 'per_km' — the old rule, until the ranges are saved
      if (billableKm <= 0) return `${lead} (within the ${kmText(rules.freeKm)} free distance)`;
      return `${lead} (first ${kmText(rules.freeKm)} free): ${billableKm} km × ${formatMoney(rules.ratePerKm)}${capped ? ', capped' : ''}`;
  }
}
