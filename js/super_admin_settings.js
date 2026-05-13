// super_admin_settings.js
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

const RIZAL_DEFAULTS = {
  center_lat: 14.5794,
  center_lng: 121.1878,
  sw_lat:     14.26,
  sw_lng:     120.95,
  ne_lat:     14.82,
  ne_lng:     121.62,
};

// ── Map scope fields ────────────────────────────────────────────────────────
const mapFields = {
  center_lat: () => document.getElementById('map-center-lat'),
  center_lng: () => document.getElementById('map-center-lng'),
  sw_lat:     () => document.getElementById('map-sw-lat'),
  sw_lng:     () => document.getElementById('map-sw-lng'),
  ne_lat:     () => document.getElementById('map-ne-lat'),
  ne_lng:     () => document.getElementById('map-ne-lng'),
};

function setMapMsg(msg, isError = false) {
  const el = document.getElementById('map-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function populateMapFields(config) {
  for (const [key, getEl] of Object.entries(mapFields)) {
    const el = getEl();
    if (el) el.value = config[key] ?? '';
  }
}

function readMapFields() {
  const result = {};
  for (const [key, getEl] of Object.entries(mapFields)) {
    const el = getEl();
    result[key] = el ? parseFloat(el.value) : null;
  }
  return result;
}

function validateMapConfig(config) {
  for (const [key, val] of Object.entries(config)) {
    if (val === null || isNaN(val)) return `"${key}" is not a valid number.`;
  }
  if (config.sw_lat >= config.ne_lat) return 'SW latitude must be less than NE latitude.';
  if (config.sw_lng >= config.ne_lng) return 'SW longitude must be less than NE longitude.';
  if (config.center_lat < config.sw_lat || config.center_lat > config.ne_lat)
    return 'Center latitude must be within the SW–NE bounds.';
  if (config.center_lng < config.sw_lng || config.center_lng > config.ne_lng)
    return 'Center longitude must be within the SW–NE bounds.';
  return null;
}

async function loadMapScope() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'venue_map_scope')
    .maybeSingle();

  if (error || !data) {
    populateMapFields(RIZAL_DEFAULTS);
    return;
  }
  populateMapFields({ ...RIZAL_DEFAULTS, ...data.value });
}

async function saveMapScope() {
  const config = readMapFields();
  const validationError = validateMapConfig(config);
  if (validationError) { setMapMsg(validationError, true); return; }

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { key: 'venue_map_scope', value: config, updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'key' }
    );

  if (error) { setMapMsg('Failed to save: ' + error.message, true); return; }
  setMapMsg('Map scope saved successfully.');
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Super Admin' });
  if (!result) return;

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);

  await loadMapScope();

  document.getElementById('saveMapScopeBtn')?.addEventListener('click', saveMapScope);

  document.getElementById('resetMapScopeBtn')?.addEventListener('click', () => {
    populateMapFields(RIZAL_DEFAULTS);
    setMapMsg('');
  });
}

init();
