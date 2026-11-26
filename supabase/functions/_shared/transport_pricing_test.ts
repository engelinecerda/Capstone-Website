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

// ── per-package overrides ───────────────────────────────────────────────────
const PKG_A = '11111111-aaaa-bbbb-cccc-000000000001';
const PKG_B = '11111111-aaaa-bbbb-cccc-000000000002';
const withOverrides = {
  ...base,
  transport_package_overrides: {
    [PKG_A]: { free_km: 5, ranges: [{ to_km: 10, fee: 2500 }, { to_km: 15, fee: 3500 }, { to_km: 20, fee: 8000 }, { to_km: 25, fee: 9000 }] },
    [PKG_B]: { free_km: 0, ranges: [{ to_km: 8, fee: 700 }] },
  },
};
const priceFor = (raw: Record<string, unknown>, pkg: string | null, km: number) =>
  priceTransportDistance(readTransportRules(raw, pkg), km);
assert.equal(priceFor(withOverrides, null, 12).fee, 2000, 'no package: universal');
assert.equal(priceFor(withOverrides, 'some-other-package', 12).fee, 2000, 'package without override: universal');
assert.equal(priceFor(withOverrides, PKG_A, 12).fee, 3500, 'override replaces the universal ranges');
assert.equal(priceFor(withOverrides, PKG_A, 5).fee, 0, 'override free distance');
assert.equal(priceFor(withOverrides, PKG_B, 3).fee, 700, 'override with its own (zero) free distance');
assert.equal(priceFor(withOverrides, PKG_B, 8.1).status, 'out_of_range', 'beyond the override last range follows the universal setting');
assert.equal(priceFor({ ...withOverrides, transport_beyond: 'last' }, PKG_B, 50).fee, 700);
assert.equal(readTransportRules(withOverrides, PKG_A).packageOverride, true);
assert.equal(readTransportRules(withOverrides, PKG_A).enabled, true, 'on/off stays universal');
assert.equal(readTransportRules(withOverrides, null).packageOverride, false);
// bad overrides are ignored, never trusted
for (const bad of [null, 'x', 5, [], {}, { ranges: 'nope' }]) {
  const raw = { ...base, transport_package_overrides: { [PKG_A]: bad } };
  assert.equal(readTransportRules(raw, PKG_A).packageOverride, false);
  assert.equal(priceFor(raw, PKG_A, 12).fee, 2000);
}
assert.equal(readTransportRules({ ...base, transport_package_overrides: [] }, PKG_A).packageOverride, false);
assert.equal(readTransportRules({ ...base, transport_package_overrides: { __proto__: { ranges: [] } } }, 'ranges').packageOverride, false);
// an override applies even while the universal fee has never been saved (legacy per-km)
assert.equal(priceFor({ ...legacy, transport_package_overrides: withOverrides.transport_package_overrides }, PKG_A, 12).fee, 3500);
assert.equal(priceFor(legacy, PKG_A, 15).status, 'per_km');
// browser and server agree on every override rule set, for every distance
for (const pkg of [null, PKG_A, PKG_B, 'other']) {
  for (const raw of [withOverrides, { ...withOverrides, transport_beyond: 'last' }, { ...legacy, transport_package_overrides: withOverrides.transport_package_overrides }]) {
    const sr = readTransportRules(raw, pkg);
    const br = browser.readTransportRules(raw, pkg);
    assert.deepEqual(br, sr);
    for (let tenths = 0; tenths <= 6000; tenths++) {
      assert.deepEqual(browser.priceTransportDistance(br, tenths / 10), priceTransportDistance(sr, tenths / 10));
      compared++;
    }
  }
}
// the bookable-area circle follows the package's own last range
assert.equal(browser.transportCoverage(withOverrides, [{ name: 'A', latitude: 14.4, longitude: 121.1, transport_origin: true }], PKG_B).radiusKm, 8);
assert.equal(browser.transportCoverage(withOverrides, [{ name: 'A', latitude: 14.4, longitude: 121.1, transport_origin: true }], null).radiusKm, 25);

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
