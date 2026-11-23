// calculate-transport-fee — prices the offsite transport fee on the server.
//
// Input : POST { lat, lng }  (the venue pin the customer dropped)
// Output: { success: true, result: { applies, fee, distanceKm, billableKm,
//           originName, capped, method, rules } }
//
// How it works
//   1. Reads the transport_* settings from system_settings.payment_rules and
//      the active branches that have map coordinates.
//   2. Takes the two branches nearest to the pin (straight line) and asks
//      OpenRouteService for the real driving distance from each. The shorter
//      one wins.
//   3. If OpenRouteService can't be reached (no key, quota used up, pin not
//      near a road, timeout), falls back to straight-line distance x the
//      road distance factor, and says so with method = 'estimate'.
//   4. fee = min( max(0, roadKm - freeKm) * ratePerKm , maxFee )
//
// The maths mirrors js/transport_fee.js (kept in sync by hand, because an
// edge function can't import from the website's /js folder).
//
// Secret required: ORS_API_KEY (supabase secrets set ORS_API_KEY=...).
// JWT verification stays on, so only signed-in customers can call it.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ORS_API_KEY = Deno.env.get('ORS_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/driving-car';
const ORS_TIMEOUT_MS = 8_000;
// How far from the pin / branch ORS may look for the nearest road (metres).
const ORS_SNAP_RADIUS_M = 2000;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

interface TransportRules {
  enabled: boolean;
  freeKm: number;
  ratePerKm: number;
  maxFee: number | null;
  roadFactor: number;
}

interface Branch {
  name: string | null;
  branch_tag: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
}

const num = (v: unknown, fallback: number | null): number | null => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

function readRules(raw: Record<string, unknown>): TransportRules {
  const maxFee = num(raw.transport_max_fee, null);
  return {
    enabled: raw.transport_fee_enabled === true,
    freeKm: Math.max(0, num(raw.transport_free_km, 10) as number),
    ratePerKm: Math.max(0, num(raw.transport_rate_per_km, 30) as number),
    maxFee: maxFee === null ? null : Math.max(0, maxFee),
    roadFactor: Math.max(1, num(raw.transport_road_factor, 1.3) as number),
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Driving distance in km from a branch to the pin, or null if ORS can't give one.
async function orsRoadKm(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<number | null> {
  if (!ORS_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ORS_TIMEOUT_MS);
  try {
    const res = await fetch(ORS_URL, {
      method: 'POST',
      headers: { 'Authorization': ORS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
        radiuses: [ORS_SNAP_RADIUS_M, ORS_SNAP_RADIUS_M],
        instructions: false,
        geometry: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('ORS error', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const json = await res.json();
    const meters = Number(json?.routes?.[0]?.summary?.distance);
    return Number.isFinite(meters) && meters >= 0 ? meters / 1000 : null;
  } catch (err) {
    console.error('ORS request failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed.' }, 405);

  let body: { lat?: unknown; lng?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request.' }, 400);
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return jsonResponse({ success: false, error: 'A valid pin (lat, lng) is required.' }, 400);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: settingRow, error: settingErr } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'payment_rules')
      .maybeSingle();
    if (settingErr) throw settingErr;

    let rawRules: Record<string, unknown> = {};
    const sv = settingRow?.setting_value;
    if (typeof sv === 'string') {
      try { rawRules = JSON.parse(sv) ?? {}; } catch { rawRules = {}; }
    } else if (sv && typeof sv === 'object') {
      rawRules = sv as Record<string, unknown>;
    }
    const rules = readRules(rawRules);

    const none = {
      applies: false, fee: 0, distanceKm: null, billableKm: 0,
      originName: '', capped: false, method: 'none', rules,
    };
    if (!rules.enabled) return jsonResponse({ success: true, result: none });

    const { data: branchRows, error: branchErr } = await supabase
      .from('business_location')
      .select('name, branch_tag, latitude, longitude')
      .eq('is_active', true);
    if (branchErr) throw branchErr;

    const withCoords = ((branchRows ?? []) as Branch[])
      .filter((b) => b.latitude !== null && b.longitude !== null &&
        Number.isFinite(Number(b.latitude)) && Number.isFinite(Number(b.longitude)))
      .map((b) => ({
        name: b.name || b.branch_tag || 'our branch',
        lat: Number(b.latitude),
        lng: Number(b.longitude),
        straightKm: haversineKm(lat, lng, Number(b.latitude), Number(b.longitude)),
      }))
      .sort((a, b) => a.straightKm - b.straightKm);

    if (!withCoords.length) return jsonResponse({ success: true, result: none });

    // Real driving distance from the two nearest branches (usually just one
    // or two exist); the shorter route decides the fee.
    const candidates = withCoords.slice(0, 2);
    const roads = await Promise.all(candidates.map((c) => orsRoadKm({ lat: c.lat, lng: c.lng }, { lat, lng })));

    let originName = candidates[0].name;
    let rawKm: number;
    let method: 'route' | 'estimate';
    const routed = candidates
      .map((c, i) => ({ c, km: roads[i] }))
      .filter((r): r is { c: typeof candidates[number]; km: number } => r.km !== null)
      .sort((a, b) => a.km - b.km);

    if (routed.length) {
      originName = routed[0].c.name;
      rawKm = routed[0].km;
      method = 'route';
    } else {
      rawKm = candidates[0].straightKm * rules.roadFactor;
      method = 'estimate';
    }

    const distanceKm = Math.round(rawKm * 10) / 10;
    const billableKm = Math.max(0, round2(distanceKm - rules.freeKm));
    let fee = round2(billableKm * rules.ratePerKm);
    let capped = false;
    if (rules.maxFee !== null && fee > rules.maxFee) {
      fee = round2(rules.maxFee);
      capped = true;
    }

    return jsonResponse({
      success: true,
      result: { applies: true, fee, distanceKm, billableKm, originName, capped, method, rules },
    });
  } catch (err) {
    console.error('calculate-transport-fee failed', err);
    return jsonResponse({ success: false, error: 'Could not calculate the transport fee.' }, 500);
  }
});
