// super_admin_settings.js
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';

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
    .select('setting_value')
    .eq('setting_key', 'venue_map_scope')
    .maybeSingle();

  if (error || !data) {
    populateMapFields(RIZAL_DEFAULTS);
    return;
  }
  populateMapFields({ ...RIZAL_DEFAULTS, ...JSON.parse(data.setting_value) });
}

async function saveMapScope() {
  const config = readMapFields();
  const validationError = validateMapConfig(config);
  if (validationError) { setMapMsg(validationError, true); return; }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'venue_map_scope')
    .maybeSingle();
  const oldConfig = current ? { ...RIZAL_DEFAULTS, ...JSON.parse(current.setting_value) } : RIZAL_DEFAULTS;

  showSettingsConfirm(
    'Change Venue Map Scope',
    `Center ${oldConfig.center_lat}, ${oldConfig.center_lng}`,
    `Center ${config.center_lat}, ${config.center_lng}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'venue_map_scope', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setMapMsg('Failed to save: ' + error.message, true); return; }
      setMapMsg('Map scope saved successfully.');
    }
  );
}

// ── Confirm modal (Map Scope / Operating Hours) ──────────────────────────────
function showSettingsConfirm(title, oldValueLabel, newValueLabel, onConfirm) {
  const modal = document.getElementById('settingsConfirmModal');
  if (!modal) { onConfirm(); return; }

  document.getElementById('settingsConfirmTitle').textContent = title;
  document.getElementById('settingsConfirmCopy').textContent = `${oldValueLabel} → ${newValueLabel}`;

  document.getElementById('settingsConfirmOk').onclick = () => {
    modal.classList.add('hidden');
    onConfirm();
  };
  document.getElementById('settingsConfirmCancel').onclick = () => modal.classList.add('hidden');
  modal.classList.remove('hidden');
}

// ── Vision API usage widget ─────────────────────────────────────────────────
const VISION_FREE_TIER_UNITS = 1000;

async function loadVisionUsage() {
  const badge = document.getElementById('usageBadge');
  const fill = document.getElementById('usageBarFill');
  if (!badge || !fill) return;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('vision_api_usage')
    .select('units_used')
    .eq('month_start', monthStartStr)
    .maybeSingle();

  if (error) {
    badge.textContent = 'Unavailable';
    return;
  }

  const used = data?.units_used ?? 0;
  const pct = Math.min((used / VISION_FREE_TIER_UNITS) * 100, 100);

  let tier = '';
  if (used >= VISION_FREE_TIER_UNITS) tier = 'over';
  else if (pct >= 80) tier = 'warn';

  badge.textContent = `${used.toLocaleString()} / ${VISION_FREE_TIER_UNITS.toLocaleString()} units`;
  badge.className = 'usage-badge' + (tier ? ` ${tier}` : '');
  fill.style.width = `${pct}%`;
  fill.className = 'usage-bar-fill' + (tier ? ` ${tier}` : '');
}

// ── Operating hours ──────────────────────────────────────────────────────────
const DEFAULT_OPERATING_HOURS = { open_time: '13:00', close_time: '22:00' };

function setHoursMsg(msg, isError = false) {
  const el = document.getElementById('hours-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function populateHoursFields(config) {
  const openEl = document.getElementById('field-open-time');
  const closeEl = document.getElementById('field-close-time');
  if (openEl) openEl.value = config.open_time ?? '';
  if (closeEl) closeEl.value = config.close_time ?? '';
}

async function loadOperatingHours() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'booking_operating_hours')
    .maybeSingle();

  if (error || !data) {
    populateHoursFields(DEFAULT_OPERATING_HOURS);
    return;
  }
  populateHoursFields({ ...DEFAULT_OPERATING_HOURS, ...JSON.parse(data.setting_value) });
}

async function saveOperatingHours() {
  const openTime = document.getElementById('field-open-time')?.value;
  const closeTime = document.getElementById('field-close-time')?.value;

  if (!openTime || !closeTime) { setHoursMsg('Both opening and closing times are required.', true); return; }
  if (openTime >= closeTime) { setHoursMsg('Closing time must be after opening time.', true); return; }

  const config = { open_time: openTime, close_time: closeTime };

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'booking_operating_hours')
    .maybeSingle();
  const oldConfig = current ? { ...DEFAULT_OPERATING_HOURS, ...JSON.parse(current.setting_value) } : DEFAULT_OPERATING_HOURS;

  showSettingsConfirm(
    'Change Booking Operating Hours',
    `${oldConfig.open_time} – ${oldConfig.close_time}`,
    `${openTime} – ${closeTime}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'booking_operating_hours', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setHoursMsg('Failed to save: ' + error.message, true); return; }
      setHoursMsg('Operating hours saved successfully.');
    }
  );
}

// ── Reservation rules ─────────────────────────────────────────────────────
// deposit_pct drives the customer payment page's Custom Amount minimum;
// auto_cancel_days drives the overdue grace deadline shown there and used
// by the auto_cancel_overdue_reservations() scheduled job. See
// js/customer_payments.js RESERVATION_RULES_DEFAULTS for the matching
// customer-side fallback (kept in sync manually — this file intentionally
// doesn't import the customer-facing module).
const DEFAULT_RESERVATION_RULES = {
  min_advance_days: 14,
  max_advance_days: 365,
  min_pax: 20,
  max_pax: 150,
  deposit_pct: 30,
  full_payment_days: 7,
  auto_cancel_days: 5,
  contract_resubmission_days: 3
};

const rulesFields = {
  min_advance_days: () => document.getElementById('field-min-advance'),
  max_advance_days: () => document.getElementById('field-max-advance'),
  min_pax: () => document.getElementById('field-min-pax'),
  max_pax: () => document.getElementById('field-max-pax'),
  deposit_pct: () => document.getElementById('field-deposit-pct'),
  full_payment_days: () => document.getElementById('field-full-payment-days'),
  auto_cancel_days: () => document.getElementById('field-auto-cancel-days'),
  contract_resubmission_days: () => document.getElementById('field-contract-days')
};

function setRulesMsg(msg, isError = false) {
  const el = document.getElementById('rules-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function populateRulesFields(config) {
  for (const [key, getEl] of Object.entries(rulesFields)) {
    const el = getEl();
    if (el) el.value = config[key] ?? '';
  }
}

function readRulesFields() {
  const result = {};
  for (const [key, getEl] of Object.entries(rulesFields)) {
    const el = getEl();
    result[key] = el ? Number(el.value) : null;
  }
  return result;
}

function validateReservationRules(config) {
  for (const [key, val] of Object.entries(config)) {
    if (val === null || Number.isNaN(val) || val < 0) return `"${key}" must be a non-negative number.`;
  }
  if (config.min_advance_days >= config.max_advance_days) return 'Minimum advance booking must be less than maximum advance booking.';
  if (config.min_pax >= config.max_pax) return 'Minimum pax must be less than maximum pax.';
  if (config.deposit_pct > 100) return 'Down payment percentage cannot exceed 100.';
  return null;
}

async function loadReservationRulesSettings() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_rules')
    .maybeSingle();

  if (error || !data) {
    populateRulesFields(DEFAULT_RESERVATION_RULES);
    return;
  }
  populateRulesFields({ ...DEFAULT_RESERVATION_RULES, ...JSON.parse(data.setting_value) });
}

// Note: unlike Map Scope / Operating Hours, this panel already has its own
// purpose-built confirm modal (#confirmModal / #confirmSave) wired in the
// inline <script> at the bottom of super_admin_settings.html — that script
// owns the dirty-tracking dots/banner and resets them on confirm. This
// function only adds the actual persistence, invoked from a second listener
// on #confirmSave (see init() below) rather than routing through
// showSettingsConfirm(), which would pop a second, redundant dialog.
async function saveReservationRulesSettings() {
  const config = readRulesFields();
  const validationError = validateReservationRules(config);
  if (validationError) { setRulesMsg(validationError, true); return; }

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'reservation_rules', setting_value: JSON.stringify(config), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) { setRulesMsg('Failed to save: ' + error.message, true); return; }
  setRulesMsg('Reservation rules saved successfully.');
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Super Admin' });
  if (!result) return;

  if (result.profile.role !== 'admin') {
    window.location.replace('/admin/dashboard.html');
    return;
  }

  const avatarEl = document.getElementById('sidebarAvatar');
  if (avatarEl) avatarEl.textContent = getPortalInitials(result.profile);
  const roleBottomEl = document.getElementById('sidebarRoleBottom');
  if (roleBottomEl) roleBottomEl.textContent = 'Super Admin';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });

  await loadMapScope();
  await loadVisionUsage();
  await loadOperatingHours();
  await loadReservationRulesSettings();

  document.getElementById('saveMapScopeBtn')?.addEventListener('click', saveMapScope);

  document.getElementById('resetMapScopeBtn')?.addEventListener('click', () => {
    populateMapFields(RIZAL_DEFAULTS);
    setMapMsg('');
  });

  document.getElementById('saveHoursBtn')?.addEventListener('click', saveOperatingHours);

  document.getElementById('resetHoursBtn')?.addEventListener('click', () => {
    populateHoursFields(DEFAULT_OPERATING_HOURS);
    setHoursMsg('');
  });

  // saveRulesBtn/saveRulesConfirmBtn and discardRulesBtn/discardRulesBtn2
  // already have their dirty-tracking/confirm-modal behavior wired by the
  // inline <script> in super_admin_settings.html — this only adds the
  // actual database write on top of that existing confirm step.
  document.getElementById('confirmSave')?.addEventListener('click', saveReservationRulesSettings);
}

init();
