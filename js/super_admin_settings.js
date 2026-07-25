// super_admin_settings.js — Operating Hours page.
// Map Scope and Reservation Rules used to live here too (removed along
// with their tabs — see super_admin_settings.html). Their underlying
// system_settings rows (venue_map_scope, reservation_rules) are untouched
// in the database; this file just no longer has UI to edit them.
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { getPortalInitials } from './admin_auth.js';
import { initAdminNav } from './admin_nav.js';
import { logAudit } from './audit_logger.js';

// ── Confirm modal (Operating Hours) ───────────────────────────────────────
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

// ── Operating hours (per-weekday) ───────────────────────────────────────────
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEFAULT_DAY_HOURS = { is_open: true, open_time: '13:00', close_time: '22:00' };

let hoursCache = []; // [{ weekday, is_open, open_time, close_time }]

function setHoursMsg(msg, isError = false) {
  const el = document.getElementById('hours-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function renderHoursTable() {
  const body = document.getElementById('hoursTableBody');
  if (!body) return;
  body.innerHTML = hoursCache.map((day) => `
    <tr data-weekday="${day.weekday}">
      <td>${WEEKDAY_LABELS[day.weekday]}</td>
      <td>
        <label class="pm2-toggle">
          <input type="checkbox" data-field="is_open" ${day.is_open ? 'checked' : ''}>
          <span class="pm2-toggle-track"></span>
        </label>
      </td>
      <td><input type="time" data-field="open_time" value="${day.open_time || ''}" ${day.is_open ? '' : 'disabled'}></td>
      <td><input type="time" data-field="close_time" value="${day.close_time || ''}" ${day.is_open ? '' : 'disabled'}></td>
    </tr>
  `).join('');
}

document.addEventListener('change', (e) => {
  const row = e.target.closest('#hoursTableBody tr[data-weekday]');
  if (!row) return;
  const weekday = Number(row.dataset.weekday);
  const day = hoursCache.find((d) => d.weekday === weekday);
  if (!day) return;

  if (e.target.dataset.field === 'is_open') {
    day.is_open = e.target.checked;
    row.querySelectorAll('input[type="time"]').forEach((el) => { el.disabled = !day.is_open; });
  } else if (e.target.dataset.field === 'open_time') {
    day.open_time = e.target.value;
  } else if (e.target.dataset.field === 'close_time') {
    day.close_time = e.target.value;
  }
});

async function loadOperatingHours() {
  const { data, error } = await supabase
    .from('operating_hours')
    .select('weekday, is_open, open_time, close_time')
    .order('weekday', { ascending: true });

  if (error || !data || !data.length) {
    hoursCache = WEEKDAY_LABELS.map((_, weekday) => ({ weekday, ...DEFAULT_DAY_HOURS }));
  } else {
    hoursCache = data.map((d) => ({
      weekday: d.weekday,
      is_open: d.is_open,
      open_time: (d.open_time || '').slice(0, 5),
      close_time: (d.close_time || '').slice(0, 5),
    }));
  }
  renderHoursTable();
}

async function saveOperatingHours() {
  for (const day of hoursCache) {
    if (day.is_open && (!day.open_time || !day.close_time)) {
      setHoursMsg(`${WEEKDAY_LABELS[day.weekday]}: both opening and closing times are required for an open day.`, true);
      return;
    }
    if (day.is_open && day.open_time >= day.close_time) {
      setHoursMsg(`${WEEKDAY_LABELS[day.weekday]}: closing time must be after opening time.`, true);
      return;
    }
  }

  showSettingsConfirm(
    'Change Operating Hours',
    'Previous per-day hours',
    'Updated per-day hours',
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const rows = hoursCache.map((day) => ({
        weekday: day.weekday,
        is_open: day.is_open,
        open_time: day.is_open ? day.open_time : null,
        close_time: day.is_open ? day.close_time : null,
      }));
      const { error } = await supabase.from('operating_hours').upsert(rows, { onConflict: 'weekday' });

      if (error) { setHoursMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Operating Hours', category: 'scheduling_config', details: JSON.stringify(rows) });
      setHoursMsg('Operating hours saved successfully.');
    }
  );
}

// ── Buffer & capacity (global) ──────────────────────────────────────────────
const DEFAULT_SCHEDULING_SETTINGS = { buffer_minutes: 30, default_slot_capacity: 2 };

function setCapacityMsg(msg, isError = false) {
  const el = document.getElementById('capacity-settings-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadSchedulingSettings() {
  const { data } = await supabase
    .from('scheduling_settings')
    .select('buffer_minutes, default_slot_capacity')
    .eq('id', true)
    .maybeSingle();

  const config = { ...DEFAULT_SCHEDULING_SETTINGS, ...(data || {}) };
  const bufferEl = document.getElementById('field-buffer-minutes');
  const capacityEl = document.getElementById('field-default-capacity');
  if (bufferEl) bufferEl.value = config.buffer_minutes;
  if (capacityEl) capacityEl.value = config.default_slot_capacity;
}

async function saveSchedulingSettings() {
  const bufferMinutes = Number(document.getElementById('field-buffer-minutes')?.value);
  const defaultCapacity = Number(document.getElementById('field-default-capacity')?.value);

  if (!Number.isFinite(bufferMinutes) || bufferMinutes < 0) { setCapacityMsg('Buffer time must be zero or more minutes.', true); return; }
  if (!Number.isFinite(defaultCapacity) || defaultCapacity < 1) { setCapacityMsg('Default slot capacity must be at least 1.', true); return; }

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('scheduling_settings')
    .update({ buffer_minutes: bufferMinutes, default_slot_capacity: defaultCapacity, updated_at: new Date().toISOString(), updated_by: user?.id ?? null })
    .eq('id', true);

  if (error) { setCapacityMsg('Failed to save: ' + error.message, true); return; }
  await logAudit({ action: 'Updated Buffer & Capacity', category: 'scheduling_config', details: `buffer=${bufferMinutes}min, default_capacity=${defaultCapacity}` });
  setCapacityMsg('Buffer & capacity saved successfully.');
  renderScopeCapacityTable(); // refresh "effective" column, which falls back to this default
}

// ── Per-scope capacity override ─────────────────────────────────────────────
const SCOPES = [
  { scope: 'onsite_vip', label: 'Onsite — VIP' },
  { scope: 'onsite_main_hall', label: 'Onsite — Main Hall' },
  { scope: 'offsite', label: 'Offsite' },
];

let scopeCapacityCache = {}; // { scope: capacity|null }
let defaultCapacityForDisplay = DEFAULT_SCHEDULING_SETTINGS.default_slot_capacity;

function setScopeCapacityMsg(msg, isError = false) {
  const el = document.getElementById('scope-capacity-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function renderScopeCapacityTable() {
  const body = document.getElementById('scopeCapacityBody');
  if (!body) return;
  const globalDefaultEl = document.getElementById('field-default-capacity');
  const globalDefault = Number(globalDefaultEl?.value) || defaultCapacityForDisplay;

  body.innerHTML = SCOPES.map(({ scope, label }) => {
    const override = scopeCapacityCache[scope];
    const effective = override ?? globalDefault;
    return `
      <tr data-scope="${scope}">
        <td>${label}</td>
        <td><input type="number" min="1" step="1" data-scope-capacity value="${override ?? ''}" placeholder="Default (${globalDefault})"></td>
        <td>${effective}</td>
      </tr>
    `;
  }).join('');
}

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-scope-capacity]')) {
    const row = e.target.closest('tr[data-scope]');
    if (!row) return;
    const scope = row.dataset.scope;
    const raw = e.target.value.trim();
    scopeCapacityCache[scope] = raw === '' ? null : Number(raw);
    renderScopeCapacityTable();
    // Re-render moves focus off the input that triggered it — restore it.
    document.querySelector(`tr[data-scope="${scope}"] [data-scope-capacity]`)?.focus();
  }
});

async function loadScopeCapacity() {
  const { data } = await supabase.from('scope_capacity').select('scope, capacity');
  scopeCapacityCache = {};
  (data || []).forEach((row) => { scopeCapacityCache[row.scope] = row.capacity; });
  renderScopeCapacityTable();
}

async function saveScopeCapacity() {
  for (const { scope } of SCOPES) {
    const val = scopeCapacityCache[scope];
    if (val !== null && val !== undefined && (!Number.isFinite(val) || val < 1)) {
      setScopeCapacityMsg('Capacity overrides must be at least 1, or left blank to use the default.', true);
      return;
    }
  }

  const rows = SCOPES.map(({ scope }) => ({
    scope,
    capacity: scopeCapacityCache[scope] ?? null,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('scope_capacity').upsert(rows, { onConflict: 'scope' });

  if (error) { setScopeCapacityMsg('Failed to save: ' + error.message, true); return; }
  await logAudit({ action: 'Updated Per-Scope Capacity', category: 'scheduling_config', details: JSON.stringify(rows) });
  setScopeCapacityMsg('Per-scope overrides saved successfully.');
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

  await loadVisionUsage();
  await loadOperatingHours();
  await loadSchedulingSettings();
  await loadScopeCapacity();

  document.getElementById('saveHoursBtn')?.addEventListener('click', saveOperatingHours);
  document.getElementById('saveCapacityBtn')?.addEventListener('click', saveSchedulingSettings);
  document.getElementById('saveScopeCapacityBtn')?.addEventListener('click', saveScopeCapacity);
}

init();
