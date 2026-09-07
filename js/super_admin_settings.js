// super_admin_settings.js — Availability and Scheduling page.
// Five sections on one scrolling page (Operating Hours, Booking Notice
// Window, Per-Event-Type Notice Override, Buffer & Capacity, Per-Scope
// Capacity Override), each addressable via #hash from the sidebar's
// "Availability and scheduling" link (admin_nav_data.js) — same anchor-
// scroll pattern as admin/config/payment-options.html, not hide/show tabs,
// so no tab-switching JS is needed here.
// Map Scope used to live here too (removed along with its tab, since its
// six raw lat/lng number inputs had no live preview and a typo could
// silently break the customer map). Its admin UI now lives on Business
// Profile (admin_business_profile.js) as a draggable-bounds map editor
// instead; the underlying system_settings row (venue_map_scope) is the
// same one both versions of the UI have always read/written.
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Booking notice window (min default + max window + per-event override) ──
// Both fields live inside system_settings.reservation_rules — the same
// object the customer booking page already reads (see loadReservationRules
// in reservations.html) — so saving here only touches those two fields via
// read-merge-write; every other field still stored in that JSON blob
// (min_pax, etc.) is preserved as-is. Those lost their own admin UI when the
// old Reservation Rules tab was removed and are DB-only for now (see the
// comment in js/admin_payment_options.js).
//
// max_advance_days doubles as the ceiling for every per-event-type override
// below (renderEventTypeAdvanceTable/saveEventTypeAdvanceOverrides) — a
// per-event minimum notice longer than the booking window itself would make
// that event type unbookable. Per the manager, the longest lead time needed
// today is ~5 months (weddings), so the default of 180 days leaves headroom
// above that without being so wide it stops catching fat-finger entries.
const DEFAULT_MIN_ADVANCE_DAYS = 14;
const DEFAULT_MAX_ADVANCE_DAYS = 180;

function setMinAdvanceMsg(msg, isError = false) {
  const el = document.getElementById('min-advance-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function getMaxAdvanceDaysFieldValue() {
  const value = Number(document.getElementById('field-max-advance-days')?.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_ADVANCE_DAYS;
}

async function loadMinAdvanceDays() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_rules')
    .maybeSingle();

  const parsed = data ? JSON.parse(data.setting_value) : {};
  const minValue = Number.isFinite(Number(parsed.min_advance_days)) ? Number(parsed.min_advance_days) : DEFAULT_MIN_ADVANCE_DAYS;
  const maxValue = Number.isFinite(Number(parsed.max_advance_days)) ? Number(parsed.max_advance_days) : DEFAULT_MAX_ADVANCE_DAYS;
  const minEl = document.getElementById('field-min-advance-days');
  const maxEl = document.getElementById('field-max-advance-days');
  if (minEl) { minEl.value = minValue; minEl.max = maxValue; }
  if (maxEl) maxEl.value = maxValue;
}

async function saveMinAdvanceDays() {
  const minValue = Number(document.getElementById('field-min-advance-days')?.value);
  const maxValue = Number(document.getElementById('field-max-advance-days')?.value);

  if (!Number.isFinite(minValue) || minValue < 0) { setMinAdvanceMsg('Minimum booking notice must be zero or more days.', true); return; }
  if (!Number.isFinite(maxValue) || maxValue < 1) { setMinAdvanceMsg('Maximum advance booking must be at least 1 day.', true); return; }
  if (minValue > maxValue) { setMinAdvanceMsg('Minimum notice cannot be greater than the maximum advance booking window.', true); return; }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'reservation_rules')
    .maybeSingle();
  const existing = current ? JSON.parse(current.setting_value) : {};
  const merged = { ...existing, min_advance_days: minValue, max_advance_days: maxValue };

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('system_settings')
    .upsert(
      { setting_key: 'reservation_rules', setting_value: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
      { onConflict: 'setting_key' }
    );

  if (error) { setMinAdvanceMsg('Failed to save: ' + error.message, true); return; }
  await logAudit({ action: 'Updated Booking Notice Window', category: 'scheduling_config', details: `min_advance_days=${minValue}, max_advance_days=${maxValue}` });
  setMinAdvanceMsg('Notice window saved successfully.');
  document.getElementById('field-min-advance-days').max = maxValue;
  renderEventTypeAdvanceTable(); // "Effective" column and override cap depend on these
}

let eventTypesForAdvance = [];  // [{ id, name }]
let eventTypeAdvanceCache = {}; // { id: overrideDays|null }

// ── Cancellation Notice Rules ───────────────────────────────────────────────
// Lives in the same system_settings.payment_rules JSON blob as the fee
// fields still edited on Payment Settings (js/admin_payment_options.js) — so
// loads/saves here always merge with whatever else is in that blob instead
// of overwriting it outright, same pattern saveMinAdvanceDays() above uses
// for reservation_rules.
function setCancellationNoticeMsg(msg, isError = false) {
  const el = document.getElementById('cancellation-notice-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadCancellationNoticeRules() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  const parsed = data ? JSON.parse(data.setting_value) : {};
  const minNoticeEnabled = document.getElementById('pr-cancellation-min-notice-enabled');
  const minNoticeInput = document.getElementById('pr-cancellation-min-notice-days');
  const requestWindowEnabled = document.getElementById('pr-cancellation-request-window-enabled');
  const requestWindowInput = document.getElementById('pr-cancellation-request-window-days');
  const graceDaysInput = document.getElementById('pr-cancellation-balance-grace-days');
  const holdHoursInput = document.getElementById('pr-cancellation-hold-hours');

  if (holdHoursInput) holdHoursInput.value = parsed.cancellation_hold_hours ?? 48;

  const hasMinNotice = parsed.cancellation_min_notice_days !== null && parsed.cancellation_min_notice_days !== undefined;
  if (minNoticeEnabled) minNoticeEnabled.checked = hasMinNotice;
  if (minNoticeInput) {
    minNoticeInput.value = hasMinNotice ? parsed.cancellation_min_notice_days : '';
    minNoticeInput.disabled = !hasMinNotice;
  }

  const hasRequestWindow = parsed.cancellation_request_window_days !== null && parsed.cancellation_request_window_days !== undefined;
  if (requestWindowEnabled) requestWindowEnabled.checked = hasRequestWindow;
  if (requestWindowInput) {
    requestWindowInput.value = hasRequestWindow ? parsed.cancellation_request_window_days : '';
    requestWindowInput.disabled = !hasRequestWindow;
  }

  if (graceDaysInput) graceDaysInput.value = parsed.cancellation_balance_grace_days ?? 7;
}

async function saveCancellationNoticeRules() {
  const minNoticeEnabled = !!document.getElementById('pr-cancellation-min-notice-enabled')?.checked;
  const requestWindowEnabled = !!document.getElementById('pr-cancellation-request-window-enabled')?.checked;
  const minNoticeDays = minNoticeEnabled ? Number(document.getElementById('pr-cancellation-min-notice-days')?.value) : null;
  const requestWindowDays = requestWindowEnabled ? Number(document.getElementById('pr-cancellation-request-window-days')?.value) : null;
  const graceDays = Number(document.getElementById('pr-cancellation-balance-grace-days')?.value);
  const holdHours = Number(document.getElementById('pr-cancellation-hold-hours')?.value);

  if (!Number.isFinite(holdHours) || holdHours < 1) {
    setCancellationNoticeMsg('Cancellation fee payment deadline must be at least 1 hour.', true); return;
  }
  if (minNoticeDays !== null && (!Number.isFinite(minNoticeDays) || minNoticeDays < 0)) {
    setCancellationNoticeMsg('Minimum cancellation notice must be zero or more days.', true); return;
  }
  if (requestWindowDays !== null && (!Number.isFinite(requestWindowDays) || requestWindowDays < 1)) {
    setCancellationNoticeMsg('Cancellation request window must be at least 1 day.', true); return;
  }
  if (!Number.isFinite(graceDays) || graceDays < 1) {
    setCancellationNoticeMsg('Overdue balance grace period must be at least 1 day.', true); return;
  }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();
  const existing = current ? JSON.parse(current.setting_value) : {};
  const merged = {
    ...existing,
    cancellation_hold_hours: holdHours,
    cancellation_min_notice_days: minNoticeDays,
    cancellation_request_window_days: requestWindowDays,
    cancellation_balance_grace_days: graceDays
  };

  showSettingsConfirm(
    'Change Cancellation Notice Rules',
    `Payment deadline: ${existing.cancellation_hold_hours ?? 'default'}h, min notice: ${existing.cancellation_min_notice_days ?? 'none'}, request window: ${existing.cancellation_request_window_days ?? 'none'}, grace period: ${existing.cancellation_balance_grace_days ?? 'none'}`,
    `Payment deadline: ${holdHours}h, min notice: ${minNoticeDays ?? 'none'}, request window: ${requestWindowDays ?? 'none'}, grace period: ${graceDays}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'payment_rules', setting_value: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setCancellationNoticeMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Cancellation Notice Rules', category: 'scheduling_config', details: `min_notice=${minNoticeDays}, request_window=${requestWindowDays}, grace_period=${graceDays}` });
      setCancellationNoticeMsg('Cancellation notice rules saved successfully.');
    }
  );
}

// ── Reschedule Policy ────────────────────────────────────────────────────────
// Same system_settings.payment_rules blob, same load/save pattern as
// Cancellation Notice Rules above.
function setReschedulePolicyMsg(msg, isError = false) {
  const el = document.getElementById('reschedule-policy-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadReschedulePolicy() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  const parsed = data ? JSON.parse(data.setting_value) : {};
  const holdHoursInput = document.getElementById('pr-reschedule-hold-hours');
  const minNoticeEnabled = document.getElementById('pr-reschedule-min-notice-enabled');
  const minNoticeInput = document.getElementById('pr-reschedule-min-notice-days');
  const maxCountInput = document.getElementById('pr-max-reschedule-count');

  if (holdHoursInput) holdHoursInput.value = parsed.reschedule_hold_hours ?? 48;

  const hasMinNotice = parsed.reschedule_min_notice_days !== null && parsed.reschedule_min_notice_days !== undefined;
  if (minNoticeEnabled) minNoticeEnabled.checked = hasMinNotice;
  if (minNoticeInput) {
    minNoticeInput.value = hasMinNotice ? parsed.reschedule_min_notice_days : '';
    minNoticeInput.disabled = !hasMinNotice;
  }

  if (maxCountInput) maxCountInput.value = parsed.max_reschedule_count ?? 2;
}

async function saveReschedulePolicy() {
  const holdHours = Number(document.getElementById('pr-reschedule-hold-hours')?.value);
  const minNoticeEnabled = !!document.getElementById('pr-reschedule-min-notice-enabled')?.checked;
  const minNoticeDays = minNoticeEnabled ? Number(document.getElementById('pr-reschedule-min-notice-days')?.value) : null;
  const maxCount = Number(document.getElementById('pr-max-reschedule-count')?.value);

  if (!Number.isFinite(holdHours) || holdHours < 1) {
    setReschedulePolicyMsg('Hold duration must be at least 1 hour.', true); return;
  }
  if (minNoticeDays !== null && (!Number.isFinite(minNoticeDays) || minNoticeDays < 0)) {
    setReschedulePolicyMsg('Minimum reschedule notice must be zero or more days.', true); return;
  }
  if (!Number.isFinite(maxCount) || maxCount < 1) {
    setReschedulePolicyMsg('Maximum reschedules must be at least 1.', true); return;
  }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();
  const existing = current ? JSON.parse(current.setting_value) : {};
  const merged = {
    ...existing,
    reschedule_hold_hours: holdHours,
    reschedule_min_notice_days: minNoticeDays,
    max_reschedule_count: maxCount
  };

  showSettingsConfirm(
    'Change Reschedule Policy',
    `Hold: ${existing.reschedule_hold_hours ?? 'default'}h, min notice: ${existing.reschedule_min_notice_days ?? 'none'}, max reschedules: ${existing.max_reschedule_count ?? 'default'}`,
    `Hold: ${holdHours}h, min notice: ${minNoticeDays ?? 'none'}, max reschedules: ${maxCount}`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'payment_rules', setting_value: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setReschedulePolicyMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Reschedule Policy', category: 'scheduling_config', details: `hold=${holdHours}h, min_notice=${minNoticeDays}, max_count=${maxCount}` });
      setReschedulePolicyMsg('Reschedule policy saved successfully.');
    }
  );
}

// ── Extension Rules ──────────────────────────────────────────────────────────
// Same system_settings.payment_rules blob, same load/save pattern as
// Cancellation Notice Rules / Reschedule Policy above. The fee itself
// (package.extension_price) is per-package and edited on the Packages page
// instead — this only governs the payment hold window
// (set_extension_request_defaults(), 20260920_package_extension_hours.sql).
function setExtensionRulesMsg(msg, isError = false) {
  const el = document.getElementById('extension-rules-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

async function loadExtensionRules() {
  const { data } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();

  const parsed = data ? JSON.parse(data.setting_value) : {};
  const holdMinutesInput = document.getElementById('pr-extension-hold-minutes');
  if (holdMinutesInput) holdMinutesInput.value = parsed.extension_hold_minutes ?? 45;
}

async function saveExtensionRules() {
  const holdMinutes = Number(document.getElementById('pr-extension-hold-minutes')?.value);

  if (!Number.isFinite(holdMinutes) || holdMinutes < 1) {
    setExtensionRulesMsg('Payment hold duration must be at least 1 minute.', true); return;
  }

  const { data: current } = await supabase
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'payment_rules')
    .maybeSingle();
  const existing = current ? JSON.parse(current.setting_value) : {};
  const merged = {
    ...existing,
    extension_hold_minutes: holdMinutes
  };

  showSettingsConfirm(
    'Change Extension Rules',
    `Payment hold: ${existing.extension_hold_minutes ?? 'default'} minutes`,
    `Payment hold: ${holdMinutes} minutes`,
    async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { setting_key: 'payment_rules', setting_value: JSON.stringify(merged), updated_at: new Date().toISOString(), updated_by: user?.id ?? null },
          { onConflict: 'setting_key' }
        );

      if (error) { setExtensionRulesMsg('Failed to save: ' + error.message, true); return; }
      await logAudit({ action: 'Updated Extension Rules', category: 'scheduling_config', details: `hold=${holdMinutes}m` });
      setExtensionRulesMsg('Extension rules saved successfully.');
    }
  );
}

function setEventTypeAdvanceMsg(msg, isError = false) {
  const el = document.getElementById('event-type-advance-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c0392b' : '#27ae60';
}

function renderEventTypeAdvanceTable() {
  const body = document.getElementById('eventTypeAdvanceBody');
  if (!body) return;
  const globalDefault = Number(document.getElementById('field-min-advance-days')?.value) || DEFAULT_MIN_ADVANCE_DAYS;
  const maxAllowed = getMaxAdvanceDaysFieldValue();

  if (!eventTypesForAdvance.length) {
    body.innerHTML = '<tr><td colspan="3">No active event types yet — add one on the Reservation Form page.</td></tr>';
    return;
  }

  body.innerHTML = eventTypesForAdvance.map(({ id, name }) => {
    const override = eventTypeAdvanceCache[id];
    const effective = override ?? globalDefault;
    return `
      <tr data-event-type-id="${id}">
        <td>${escapeHtml(name)}</td>
        <td><input type="number" min="0" max="${maxAllowed}" step="1" data-event-type-advance value="${override ?? ''}" placeholder="Default (${globalDefault})"></td>
        <td>${effective}</td>
      </tr>
    `;
  }).join('');
}

document.addEventListener('input', (e) => {
  if (e.target.matches('[data-event-type-advance]')) {
    const row = e.target.closest('tr[data-event-type-id]');
    if (!row) return;
    const id = row.dataset.eventTypeId;
    const raw = e.target.value.trim();
    eventTypeAdvanceCache[id] = raw === '' ? null : Number(raw);
    // Update just the "Effective" cell in place — rebuilding the whole table
    // (via renderEventTypeAdvanceTable) on every keystroke replaces this
    // input with a new DOM node, which drops the caret back to position 0.
    // The next digit then gets inserted at the start instead of the end, so
    // typing "150" renders as "051" -> "51" once the leading zero is
    // stripped on next render. Leave the input alone; only its sibling cell
    // needs to react live.
    const globalDefault = Number(document.getElementById('field-min-advance-days')?.value) || DEFAULT_MIN_ADVANCE_DAYS;
    const effectiveCell = row.children[2];
    if (effectiveCell) effectiveCell.textContent = eventTypeAdvanceCache[id] ?? globalDefault;
  }
});

async function loadEventTypeAdvanceOverrides() {
  const { data, error } = await supabase
    .from('event_types')
    .select('id, name, min_advance_days')
    .eq('status', 'Active')
    .order('name', { ascending: true });

  if (error || !data) { eventTypesForAdvance = []; renderEventTypeAdvanceTable(); return; }

  eventTypesForAdvance = data.map(({ id, name }) => ({ id, name }));
  eventTypeAdvanceCache = {};
  data.forEach((et) => { eventTypeAdvanceCache[et.id] = et.min_advance_days ?? null; });
  renderEventTypeAdvanceTable();
}

async function saveEventTypeAdvanceOverrides() {
  const maxAllowed = getMaxAdvanceDaysFieldValue();
  for (const { id, name } of eventTypesForAdvance) {
    const val = eventTypeAdvanceCache[id];
    if (val === null || val === undefined) continue;
    if (!Number.isFinite(val) || val < 0) {
      setEventTypeAdvanceMsg('Overrides must be zero or more days, or left blank to use the default.', true);
      return;
    }
    if (val > maxAllowed) {
      setEventTypeAdvanceMsg(`"${name}"'s override (${val} days) exceeds the maximum advance booking window (${maxAllowed} days). Raise the maximum above first if this event type genuinely needs more notice.`, true);
      return;
    }
  }

  try {
    await Promise.all(eventTypesForAdvance.map(({ id }) =>
      supabase.from('event_types').update({ min_advance_days: eventTypeAdvanceCache[id] ?? null }).eq('id', id)
    ));
    await logAudit({
      action: 'Updated Per-Event-Type Booking Notice',
      category: 'scheduling_config',
      details: JSON.stringify(eventTypeAdvanceCache)
    });
    setEventTypeAdvanceMsg('Overrides saved successfully.');
  } catch (err) {
    setEventTypeAdvanceMsg('Failed to save: ' + err.message, true);
  }
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
  const result = await validateAdminSession({ fallbackLabel: 'Admin' });
  if (!result) return;

  if (result.profile.role !== 'admin') {
    window.location.replace('/admin/dashboard.html');
    return;
  }

  const avatarEl = document.getElementById('sidebarAvatar');
  if (avatarEl) avatarEl.textContent = getPortalInitials(result.profile);
  const roleBottomEl = document.getElementById('sidebarRoleBottom');
  if (roleBottomEl) roleBottomEl.textContent = 'Admin';

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
  initAdminNav({ role: result.profile.role });

  await loadVisionUsage();
  await loadOperatingHours();
  await loadMinAdvanceDays();
  await loadEventTypeAdvanceOverrides();
  await loadCancellationNoticeRules();
  await loadReschedulePolicy();
  await loadExtensionRules();
  await loadSchedulingSettings();
  await loadScopeCapacity();

  document.getElementById('saveHoursBtn')?.addEventListener('click', saveOperatingHours);
  document.getElementById('saveMinAdvanceBtn')?.addEventListener('click', saveMinAdvanceDays);
  document.getElementById('saveEventTypeAdvanceBtn')?.addEventListener('click', saveEventTypeAdvanceOverrides);
  document.getElementById('saveCancellationNoticeBtn')?.addEventListener('click', saveCancellationNoticeRules);
  document.getElementById('pr-cancellation-min-notice-enabled')?.addEventListener('change', (e) => {
    const input = document.getElementById('pr-cancellation-min-notice-days');
    if (input) input.disabled = !e.target.checked;
  });
  document.getElementById('pr-cancellation-request-window-enabled')?.addEventListener('change', (e) => {
    const input = document.getElementById('pr-cancellation-request-window-days');
    if (input) input.disabled = !e.target.checked;
  });
  document.getElementById('saveReschedulePolicyBtn')?.addEventListener('click', saveReschedulePolicy);
  document.getElementById('saveExtensionRulesBtn')?.addEventListener('click', saveExtensionRules);
  document.getElementById('pr-reschedule-min-notice-enabled')?.addEventListener('change', (e) => {
    const input = document.getElementById('pr-reschedule-min-notice-days');
    if (input) input.disabled = !e.target.checked;
  });
  document.getElementById('saveCapacityBtn')?.addEventListener('click', saveSchedulingSettings);
  document.getElementById('saveScopeCapacityBtn')?.addEventListener('click', saveScopeCapacity);
}

init();