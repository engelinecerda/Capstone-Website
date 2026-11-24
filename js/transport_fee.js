// transport_fee.js — pure helpers (no DOM, no network) for the offsite
// transport fee. Used by the booking form (reservations.js) to price a venue
// pin and by Payment Settings (admin_payment_options.js) for the live example,
// so both always do the same maths.
//
// NOTE: the booking form gets the real road distance from the
// calculate-transport-fee edge function (OpenRouteService). The distance
// maths below is the fallback used when that function can't be reached, and
// powers the Payment Settings example; the fee rule itself is the same in both.
//
// Rule (per-km): the distance from the NEAREST transport fee starting point
// (a branch flagged business_location.transport_origin that has a map pin) to
// the venue pin is
// measured in a straight line, multiplied by a road factor (roads are longer
// than the crow flies), and rounded to 0.1 km. The first `freeKm` are free;
// every km after that costs `ratePerKm`, optionally capped at `maxFee`.
//
//   fee = min( max(0, roadKm - freeKm) * ratePerKm , maxFee )
//
// The settings live in system_settings.payment_rules (same JSON blob as the
// other fees) under the transport_* keys below.

import { formatMoney } from './money.js';

export const TRANSPORT_DEFAULTS = Object.freeze({
  enabled: false,     // safe default: nothing changes until an admin opts in
  freeKm: 10,
  ratePerKm: 30,
  maxFee: null,       // null = no cap
  roadFactor: 1.3
});

const num = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Turns the raw payment_rules blob into clean, always-valid settings.
export function readTransportRules(rules) {
  const r = rules || {};
  const maxFee = num(r.transport_max_fee, null);
  return {
    enabled: r.transport_fee_enabled === true,
    freeKm: Math.max(0, num(r.transport_free_km, TRANSPORT_DEFAULTS.freeKm)),
    ratePerKm: Math.max(0, num(r.transport_rate_per_km, TRANSPORT_DEFAULTS.ratePerKm)),
    maxFee: maxFee === null ? null : Math.max(0, maxFee),
    roadFactor: Math.max(1, num(r.transport_road_factor, TRANSPORT_DEFAULTS.roadFactor))
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

const round2 = (n) => Math.round(n * 100) / 100;

// Prices a single pin. `applies` is false when the fee is switched off, there
// is no pin yet, or no branch is a transport fee starting point with a pin — callers then charge nothing.
export function computeTransportFee(rawRules, pin, branches) {
  const rules = readTransportRules(rawRules);
  const none = { applies: false, fee: 0, distanceKm: null, billableKm: 0, originName: '', capped: false, rules };
  if (!rules.enabled) return none;
  const nearest = findNearestBranch(pin, branches);
  if (!nearest) return none;

  const distanceKm = Math.round(nearest.straightKm * rules.roadFactor * 10) / 10;
  const billableKm = Math.max(0, round2(distanceKm - rules.freeKm));
  let fee = round2(billableKm * rules.ratePerKm);
  let capped = false;
  if (rules.maxFee !== null && fee > rules.maxFee) { fee = round2(rules.maxFee); capped = true; }
  return {
    applies: true,
    fee,
    distanceKm,
    billableKm,
    originName: nearest.branch.name || nearest.branch.branch_tag || 'our branch',
    capped,
    rules
  };
}

// One-line plain-English breakdown, e.g.
// "12.4 km from ELI Coffee Antipolo (first 10 km free): 2.4 km × ₱30.00"
export function describeTransportFee(result) {
  if (!result?.applies) return '';
  const { distanceKm, billableKm, originName, rules, capped } = result;
  if (billableKm <= 0) return `${distanceKm} km from ${originName} (within the ${rules.freeKm} km free distance)`;
  return `${distanceKm} km from ${originName} (first ${rules.freeKm} km free): ${billableKm} km × ${formatMoney(rules.ratePerKm)}${capped ? ', capped' : ''}`;
}
