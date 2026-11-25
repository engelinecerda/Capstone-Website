// transport_pricing.ts — the transport fee rule, as pure code (no network, no
// Deno APIs), so it can be unit tested and kept identical to the browser copy
// in js/transport_fee.js. _shared/transport_pricing_test.ts feeds both the
// same distances and fails if they ever price differently.
//
// Rule (distance ranges): the road distance (rounded to 0.1 km) is looked up
// in an admin-defined list of ranges. Each range means "over the previous
// end, up to and INCLUDING its own end" and has one flat fee:
//
//   up to freeKm            -> free
//   over freeKm, up to 10   -> ranges[0].fee
//   over 10, up to 15       -> ranges[1].fee ...
//   over the last end       -> 'contact' (customer must contact us, nothing
//                              is charged automatically) or 'last' (the last
//                              range's fee is charged)
//
// The settings live in system_settings.payment_rules (transport_* keys).
// When `transport_ranges` has never been saved, the old per-km rule
// (transport_rate_per_km / transport_max_fee) keeps pricing, so deploying
// this never changes a live price until an admin saves the new screen.

export interface TransportRange { toKm: number; fee: number }

export interface TransportRules {
  enabled: boolean;
  freeKm: number;
  ranges: TransportRange[] | null; // null = ranges never saved (old per-km rule applies)
  beyond: 'contact' | 'last';
  roadFactor: number;
  ratePerKm: number; // old per-km rule, used only while ranges === null
  maxFee: number | null;
}

export type TransportStatus = 'free' | 'range' | 'beyond_charged' | 'out_of_range' | 'per_km';

export interface TransportPrice {
  fee: number;
  status: TransportStatus;
  rangeFrom: number | null;
  rangeTo: number | null;
  billableKm: number; // only meaningful for the old per-km rule
  capped: boolean;
}

export const MAX_TRANSPORT_KM = 500;

const num = (v: unknown, fallback: number | null): number | null => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;

// Turns the raw payment_rules blob into clean, always-valid settings.
export function readTransportRules(raw: Record<string, unknown> | null | undefined): TransportRules {
  const r = raw ?? {};
  const maxFee = num(r.transport_max_fee, null);
  const hasRanges = Array.isArray(r.transport_ranges);
  // Free distance default: 10 for the old per-km rule, 5 for ranges.
  const freeKm = Math.max(0, num(r.transport_free_km, hasRanges ? 5 : 10) as number);

  let ranges: TransportRange[] | null = null;
  if (hasRanges) {
    ranges = [];
    let prev = freeKm;
    const sorted = (r.transport_ranges as unknown[])
      .map((x) => x as Record<string, unknown> | null)
      .map((x) => ({ toKm: num(x?.to_km, NaN) as number, fee: num(x?.fee, NaN) as number }))
      .filter((x) => Number.isFinite(x.toKm) && Number.isFinite(x.fee))
      .sort((a, b) => a.toKm - b.toKm);
    for (const x of sorted) {
      const toKm = round1(x.toKm);
      if (toKm <= prev || toKm > MAX_TRANSPORT_KM) continue; // keeps ends strictly increasing
      ranges.push({ toKm, fee: round2(Math.max(0, x.fee)) });
      prev = toKm;
    }
  }

  return {
    enabled: r.transport_fee_enabled === true,
    freeKm,
    ranges,
    beyond: r.transport_beyond === 'last' ? 'last' : 'contact',
    roadFactor: Math.max(1, num(r.transport_road_factor, 1.3) as number),
    ratePerKm: Math.max(0, num(r.transport_rate_per_km, 30) as number),
    maxFee: maxFee === null ? null : Math.max(0, maxFee),
  };
}

// Prices one road distance (km, already rounded to 0.1).
export function priceTransportDistance(rules: TransportRules, distanceKm: number): TransportPrice {
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
  return { ...base, fee: 0, status: 'out_of_range', rangeFrom: last ? last.toKm : rules.freeKm, rangeTo: null };
}
