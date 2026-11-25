// Checks the transport fee rule and, more importantly, that the browser copy
// (js/transport_fee.js) and the edge function copy (_shared/transport_pricing.ts)
// price every distance identically.
// Run with either:
//   node --experimental-strip-types supabase/functions/_shared/transport_pricing_test.ts
//   deno run --allow-read supabase/functions/_shared/transport_pricing_test.ts
import assert from 'node:assert/strict';
import { priceTransportDistance, readTransportRules } from './transport_pricing.ts';
import * as browser from '../../../js/transport_fee.js';

const RANGES = [
  { to_km: 10, fee: 1000 },
  { to_km: 15, fee: 2000 },
  { to_km: 20, fee: 4500 },
  { to_km: 25, fee: 5000 },
];
const base = { transport_fee_enabled: true, transport_free_km: 5, transport_ranges: RANGES };

const price = (raw: Record<string, unknown>, km: number) => priceTransportDistance(readTransportRules(raw), km);

// ── the cafe's rate card ────────────────────────────────────────────────────
assert.equal(price(base, 0).fee, 0);
assert.equal(price(base, 5).fee, 0, 'exactly the free distance is free');
assert.equal(price(base, 5.1).fee, 1000, 'just over the free distance');
assert.equal(price(base, 10).fee, 1000, 'range end is included');
assert.equal(price(base, 10.1).fee, 2000);
assert.equal(price(base, 12.4).fee, 2000);
assert.equal(price(base, 15).fee, 2000);
assert.equal(price(base, 17).fee, 4500);
assert.equal(price(base, 20).fee, 4500);
assert.equal(price(base, 25).fee, 5000);
assert.deepEqual(
  { s: price(base, 12).status, f: price(base, 12).rangeFrom, t: price(base, 12).rangeTo },
  { s: 'range', f: 10, t: 15 },
);

// ── beyond the last range ───────────────────────────────────────────────────
const far = price(base, 25.1);
assert.equal(far.status, 'out_of_range');
assert.equal(far.fee, 0);
assert.equal(far.rangeFrom, 25);
const charged = price({ ...base, transport_beyond: 'last' }, 60);
assert.equal(charged.status, 'beyond_charged');
assert.equal(charged.fee, 5000);

// ── messy saved data is cleaned, never trusted ──────────────────────────────
const messy = readTransportRules({
  ...base,
  transport_ranges: [
    { to_km: 15, fee: 2000 },
    { to_km: 10, fee: 1000 },
    { to_km: 10, fee: 999 },      // duplicate end, dropped
    { to_km: 3, fee: 50 },        // inside the free distance, dropped
    { to_km: 'x', fee: 10 },      // not a number, dropped
    { to_km: 20, fee: -5 },       // negative fee becomes 0
    { to_km: 9999, fee: 1 },      // above the sanity limit, dropped
  ],
});
assert.deepEqual(messy.ranges, [
  { toKm: 10, fee: 1000 },
  { toKm: 15, fee: 2000 },
  { toKm: 20, fee: 0 },
]);

// ── no ranges saved yet: the old per-km rule keeps pricing ──────────────────
const legacy = { transport_fee_enabled: true, transport_free_km: 0, transport_rate_per_km: 30 };
assert.equal(price(legacy, 15).fee, 450);
assert.equal(price(legacy, 15).status, 'per_km');
assert.equal(price({ ...legacy, transport_max_fee: 300 }, 15).fee, 300);
// An empty (but saved) list is a configured state, not the old rule.
assert.equal(price({ ...base, transport_ranges: [] }, 6).status, 'out_of_range');

// ── browser copy and edge function copy must agree ──────────────────────────
const ruleSets: Record<string, unknown>[] = [
  base,
  { ...base, transport_beyond: 'last' },
  { ...base, transport_free_km: 0 },
  { ...base, transport_free_km: 7.5 },
  { ...base, transport_ranges: [{ to_km: 12.5, fee: 800 }] },
  { ...base, transport_ranges: [] },
  { ...base, transport_ranges: [], transport_beyond: 'last' },
  messy as unknown as Record<string, unknown>,
  legacy,
  { ...legacy, transport_max_fee: 300 },
  { transport_fee_enabled: true },
];
let compared = 0;
for (const raw of ruleSets) {
  const serverRules = readTransportRules(raw);
  const browserRules = browser.readTransportRules(raw);
  // messy is already a cleaned object, not a raw blob; skip the raw-only parity for it
  if (raw !== (messy as unknown)) assert.deepEqual(browserRules, serverRules);
  for (let tenths = 0; tenths <= 6000; tenths++) {
    const km = tenths / 10;
    const a = priceTransportDistance(serverRules, km);
    const b = browser.priceTransportDistance(browserRules, km);
    assert.deepEqual(b, a, `browser and server disagree at ${km} km`);
    compared++;
  }
}

// ── bookable-area circles (browser only; drawn on the booking map) ─────────
const branchA = { name: 'ELI Binangonan', latitude: 14.4859, longitude: 121.1863, transport_origin: true };
const branchB = { name: 'ELI Antipolo', latitude: 14.5860, longitude: 121.1760, transport_origin: true };
const unflagged = { name: 'Not a start point', latitude: 14.9, longitude: 121.5, transport_origin: false };
const northKm = (b: { latitude: number; longitude: number }, km: number) => ({ lat: b.latitude + km / 111.19, lng: b.longitude });

const cov = browser.transportCoverage(base, [branchA]);
assert.equal(cov.radiusKm, 25, 'radius is the last range end');
assert.equal(cov.circles.length, 1);
assert.ok(browser.pinInCoverage(northKm(branchA, 24.9), cov), 'just inside');
assert.ok(!browser.pinInCoverage(northKm(branchA, 25.5), cov), 'just outside');
// follows the saved ranges, nothing hardcoded
assert.equal(browser.transportCoverage({ ...base, transport_ranges: [{ to_km: 12, fee: 500 }] }, [branchA]).radiusKm, 12);
// combined circles of several starting points
const both = browser.transportCoverage(base, [branchA, branchB, unflagged]);
assert.equal(both.circles.length, 2, 'unflagged branches are ignored');
assert.ok(browser.pinInCoverage(northKm(branchB, 24), both), 'inside the second circle only');
assert.ok(!browser.pinInCoverage(northKm(branchB, 60), both));
// no limit: fee off, "charge last range", legacy per-km, no usable branch
assert.equal(browser.transportCoverage({ ...base, transport_fee_enabled: false }, [branchA]), null);
assert.equal(browser.transportCoverage({ ...base, transport_beyond: 'last' }, [branchA]), null);
assert.equal(browser.transportCoverage(legacy, [branchA]), null);
assert.equal(browser.transportCoverage(base, [unflagged]), null);
assert.equal(browser.transportCoverage({ ...base, transport_ranges: [] }, [branchA]), null);
assert.ok(browser.pinInCoverage({ lat: 0, lng: 0 }, null), 'no coverage means no limit');

console.log(`transport_pricing_test: all checks passed (${compared} distances compared)`);
