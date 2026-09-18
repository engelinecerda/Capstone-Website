// BUG-01 fix: a merely-pending (not yet staff-reviewed) reservation is
// provisional, not a hold — it must not read as capacity-blocking here,
// matching the same fix in enforce_reservation_capacity() and
// is_capacity_blocking_reservation_status() (supabase/migrations/
// 20261005_fix_pending_blocks_capacity.sql).
export const BLOCKING_RESERVATION_STATUSES = new Set(['approved', 'confirmed', 'rescheduled']);

// calendar_blackouts was hand-rolled in the Supabase SQL Editor (see
// supabase_setup.md Step 7 and the note at the top of
// 20260802_fix_calendar_blackouts_rls.sql) rather than shipped in a
// migration, so its actual column names aren't guaranteed to match the
// docs — 'closed_date'/'reason' is what's actually live today, ahead of
// the originally-documented 'date'/'note'. Both lists still carry the
// legacy name as a fallback in case an environment was set up from the
// docs verbatim.
export const BLACKOUT_DATE_COLUMNS = ['closed_date', 'date'];
export const BLACKOUT_REASON_COLUMNS = ['reason', 'note'];

// Every candidate past the first in the lists above costs a failed (400)
// request against a column that doesn't exist — harmless (caught below)
// but noisy in the network tab, and it repeats on every page that calls
// resolveBlackout*Column with its own fresh in-memory cache. Once a
// column is confirmed for this browser tab, remember it in sessionStorage
// so later calls — even from a different page/module with no in-memory
// cache of their own — try the right column first instead of re-probing
// from scratch. Session-scoped (not localStorage) so a schema change
// self-heals on the next tab/visit rather than sticking forever.
const BLACKOUT_COLUMN_STORAGE_KEYS = {
    date: 'eli_blackout_date_column',
    reason: 'eli_blackout_reason_column'
};

function readStoredBlackoutColumn(kind) {
    try {
        return sessionStorage.getItem(BLACKOUT_COLUMN_STORAGE_KEYS[kind]) || null;
    } catch {
        return null;
    }
}

function writeStoredBlackoutColumn(kind, value) {
    try {
        sessionStorage.setItem(BLACKOUT_COLUMN_STORAGE_KEYS[kind], value);
    } catch {
        // sessionStorage unavailable (privacy mode, etc.) — in-memory cache still works
    }
}

function orderedBlackoutColumnCandidates(kind, candidates) {
    const remembered = readStoredBlackoutColumn(kind);
    if (!remembered) return candidates;
    return [remembered, ...candidates.filter((column) => column !== remembered)];
}

export function formatDateKey(value) {
    return String(value || '').split('T')[0];
}

export function buildDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

// Always returns an array (or null when no scope could be resolved at
// all) — a "Plus" package that occupies both VIP and Main Hall needs both
// scopes checked/blocked together, not just one. Every caller downstream
// (fetchDateAvailability, fetchAvailableStartTimes, getScopeLabel) is
// array-aware, so a normal single-scope package (the overwhelming
// majority) just flows through as a one-element array.
export function getBookingScope(locationTypeOrReservation, packageName = '', explicitScope = null) {
    if (locationTypeOrReservation && typeof locationTypeOrReservation === 'object') {
        const obj = locationTypeOrReservation;
        return getBookingScope(
            obj.location_type,
            obj.package?.package_name || obj.package_name || '',
            obj.booking_scope || obj.package?.booking_scope || null
        );
    }

    // package.booking_scope (admin-set, explicit) always wins — see
    // supabase/migrations/20260706_package_explicit_booking_scope.sql and
    // 20261010_multi_scope_packages.sql (the array-ification). Name
    // matching below only runs for packages an admin hasn't configured yet.
    if (explicitScope) {
        const scopes = (Array.isArray(explicitScope) ? explicitScope : [explicitScope]).filter(Boolean);
        return scopes.length ? scopes : null;
    }

    const location = String(locationTypeOrReservation || '').toLowerCase();
    const name = String(packageName || '').toLowerCase();

    // Legacy fallback, mirrors public.normalize_booking_scope() — these
    // "all-occasion"/"all in" packages were treated as offsite scope even when
    // their location_type column is 'onsite' (see 20260414_add_event_package_rows.sql
    // and 20260419_reservation_flow_rewrite.sql).
    if (
        location === 'offsite' ||
        name.includes('all-occasion') ||
        name.includes('all occasion') ||
        name.includes('birthday / baptism all in package')
    ) {
        return ['offsite'];
    }
    if (location === 'onsite' && name.includes('main hall')) return ['onsite_main_hall'];
    if (location === 'onsite' && name.includes('vip')) return ['onsite_vip'];
    return null;
}

const SCOPE_LABELS = {
    onsite_vip: 'VIP',
    onsite_main_hall: 'Main Hall',
    offsite: 'Off-site'
};

// Accepts a single scope or the array getBookingScope() now always returns
// — a combo package reads as "VIP + Main Hall" instead of just one half of
// what it actually occupies.
export function getScopeLabel(scope) {
    const scopes = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
    if (!scopes.length) return 'Selected package';
    return scopes.map((s) => SCOPE_LABELS[s] || 'Selected package').join(' + ');
}

function asScopeArray(scope) {
    return (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
}

export function isBlockingReservationStatus(status) {
    return BLOCKING_RESERVATION_STATUSES.has(String(status || '').toLowerCase());
}

function normalizeAvailabilityPayload(payload, fallbackDate = '') {
    const occupiedScopes = Array.isArray(payload?.occupied_scopes) ? payload.occupied_scopes.filter(Boolean) : [];
    const blockedTimes = Array.isArray(payload?.blocked_times) ? payload.blocked_times.filter(Boolean) : [];
    return {
        eventDate: formatDateKey(payload?.event_date || fallbackDate),
        occupiedScopes,
        isFullyBooked: Boolean(payload?.is_fully_booked),
        scopeTaken: Boolean(payload?.scope_taken),
        blockedTimes
    };
}

// get_booking_availability() itself still only ever answers for one scope
// at a time (that didn't need to change — see the migration's comment on
// why get_available_start_times() kept a single p_scope too) — a combo
// package's real answer is "taken" the moment ANY one of its scopes is
// taken, so this calls it once per scope and ORs scope_taken/is_fully_
// booked together, unioning occupied_scopes/blocked_times for display.
export async function fetchDateAvailability(supabase, { eventDate, scope = '', durationHours = null, excludeReservationId = null } = {}) {
    if (!eventDate) {
        return normalizeAvailabilityPayload({}, '');
    }

    const scopes = asScopeArray(scope);
    const durationParam = Number.isFinite(Number(durationHours)) ? Number(durationHours) : null;

    if (!scopes.length) {
        const { data, error } = await supabase.rpc('get_booking_availability', {
            p_event_date: eventDate,
            p_scope: null,
            p_duration_hours: durationParam,
            p_exclude_reservation_id: excludeReservationId || null
        });
        if (error) throw error;
        return normalizeAvailabilityPayload(data, eventDate);
    }

    const results = await Promise.all(scopes.map(async (singleScope) => {
        const { data, error } = await supabase.rpc('get_booking_availability', {
            p_event_date: eventDate,
            p_scope: singleScope,
            p_duration_hours: durationParam,
            p_exclude_reservation_id: excludeReservationId || null
        });
        if (error) throw error;
        return normalizeAvailabilityPayload(data, eventDate);
    }));

    return results.reduce((merged, r) => ({
        eventDate: merged.eventDate || r.eventDate,
        occupiedScopes: [...new Set([...merged.occupiedScopes, ...r.occupiedScopes])],
        isFullyBooked: merged.isFullyBooked || r.isFullyBooked,
        scopeTaken: merged.scopeTaken || r.scopeTaken,
        blockedTimes: [...new Set([...merged.blockedTimes, ...r.blockedTimes])]
    }), { eventDate: '', occupiedScopes: [], isFullyBooked: false, scopeTaken: false, blockedTimes: [] });
}

function normalizeStartTimeRow(row) {
    return {
        timeLabel: String(row?.time_label || ''),
        startTime: row?.start_time ?? null,
        endTime: row?.end_time ?? null,
        isAvailable: Boolean(row?.is_available),
        reason: row?.reason || ''
    };
}

// get_available_start_times() still only ever answers for one scope at a
// time (see the migration's comment on why that signature stayed as-is) —
// a combo package's slot is only really bookable where EVERY one of its
// scopes reports available, so this calls it once per scope and ANDs
// is_available together per matching time_label, rather than teaching the
// RPC a second, array-typed signature.
export async function fetchAvailableStartTimes(supabase, { eventDate, scope = '', durationHours = null, excludeReservationId = null } = {}) {
    if (!eventDate) return [];

    const scopes = asScopeArray(scope);
    const durationParam = Number.isFinite(Number(durationHours)) ? Number(durationHours) : null;

    if (!scopes.length) {
        const { data, error } = await supabase.rpc('get_available_start_times', {
            p_event_date: eventDate,
            p_scope: null,
            p_duration_hours: durationParam,
            p_exclude_reservation_id: excludeReservationId || null
        });
        if (error) throw error;
        return (Array.isArray(data) ? data : []).map(normalizeStartTimeRow);
    }

    const perScopeRows = await Promise.all(scopes.map(async (singleScope) => {
        const { data, error } = await supabase.rpc('get_available_start_times', {
            p_event_date: eventDate,
            p_scope: singleScope,
            p_duration_hours: durationParam,
            p_exclude_reservation_id: excludeReservationId || null
        });
        if (error) throw error;
        return (Array.isArray(data) ? data : []).map(normalizeStartTimeRow);
    }));

    if (perScopeRows.length === 1) return perScopeRows[0];

    const [firstRows, ...restRows] = perScopeRows;
    return firstRows.map((row, i) => {
        const sameSlotAcrossScopes = restRows.map((rows) => rows[i]);
        const allAvailable = row.isAvailable && sameSlotAcrossScopes.every((r) => r?.isAvailable);
        const blockingReason = !allAvailable
            ? (row.reason || sameSlotAcrossScopes.find((r) => r && !r.isAvailable)?.reason || 'Unavailable due to another reservation.')
            : null;
        return { ...row, isAvailable: allAvailable, reason: blockingReason };
    });
}

export async function fetchCalendarAvailability(supabase, { fromDate, toDate } = {}) {
    if (!fromDate || !toDate) return new Map();

    const { data, error } = await supabase.rpc('get_booking_calendar_availability', {
        p_from_date: fromDate,
        p_to_date: toDate
    });

    if (error) throw error;

    return (Array.isArray(data) ? data : []).reduce((map, row) => {
        const normalized = normalizeAvailabilityPayload(row, row?.event_date || '');
        if (normalized.eventDate) {
            map.set(normalized.eventDate, normalized);
        }
        return map;
    }, new Map());
}

export async function resolveBlackoutDateColumn(supabase, cache = {}) {
    if (cache.blackoutDateColumn) return cache.blackoutDateColumn;

    for (const column of orderedBlackoutColumnCandidates('date', BLACKOUT_DATE_COLUMNS)) {
        const { error } = await supabase
            .from('calendar_blackouts')
            .select(column)
            .limit(1);

        if (!error) {
            cache.blackoutDateColumn = column;
            writeStoredBlackoutColumn('date', column);
            return column;
        }
    }

    return null;
}

export async function resolveBlackoutReasonColumn(supabase, cache = {}) {
    if (cache.blackoutReasonColumn) return cache.blackoutReasonColumn;

    for (const column of orderedBlackoutColumnCandidates('reason', BLACKOUT_REASON_COLUMNS)) {
        const { error } = await supabase
            .from('calendar_blackouts')
            .select(column)
            .limit(1);

        if (!error) {
            cache.blackoutReasonColumn = column;
            writeStoredBlackoutColumn('reason', column);
            return column;
        }
    }

    return null;
}

export async function fetchBlackoutDates(supabase, cache = {}, includeReasons = false) {
    const blackoutDateColumn = await resolveBlackoutDateColumn(supabase, cache);
    if (!blackoutDateColumn) {
        return {
            blackoutDateColumn: null,
            blackoutReasonColumn: null,
            closedDates: new Set(),
            closedDateReasons: new Map()
        };
    }

    const blackoutReasonColumn = includeReasons
        ? await resolveBlackoutReasonColumn(supabase, cache)
        : null;

    const selectColumns = blackoutReasonColumn
        ? `${blackoutDateColumn}, ${blackoutReasonColumn}`
        : blackoutDateColumn;

    const { data, error } = await supabase
        .from('calendar_blackouts')
        .select(selectColumns);

    if (error) throw error;

    const rows = data || [];
    return {
        blackoutDateColumn,
        blackoutReasonColumn,
        closedDates: new Set(rows.map((row) => row[blackoutDateColumn]).filter(Boolean)),
        closedDateReasons: new Map(
            rows
                .map((row) => {
                    const dateKey = row[blackoutDateColumn];
                    if (!dateKey) return null;
                    return [dateKey, blackoutReasonColumn ? String(row[blackoutReasonColumn] || '').trim() : ''];
                })
                .filter(Boolean)
        )
    };
}

// ── Advance-notice window (min/max days from today, incl. per-event-type
// override) ─────────────────────────────────────────────────────────────
// Mirrors the logic reservations.html builds inline for the new-booking
// calendar (loadReservationRules/getEffectiveMinAdvanceDays/
// isOutsideBookingWindow) — extracted here so the reschedule flow
// (js/account.js) can apply the exact same rule instead of not checking it
// at all. reservations.html's own inline copy is intentionally left as-is;
// this is additive, not a refactor of that already-working flow.
const DEFAULT_MIN_ADVANCE_DAYS = 14;
const DEFAULT_MAX_ADVANCE_DAYS = 365;

export async function loadAdvanceNoticeRules(supabase) {
    const rules = {
        minAdvanceDays: DEFAULT_MIN_ADVANCE_DAYS,
        maxAdvanceDays: DEFAULT_MAX_ADVANCE_DAYS,
        eventTypeOverrides: new Map()
    };

    try {
        const [{ data: settingsRow }, { data: eventTypeRows }] = await Promise.all([
            supabase.from('system_settings').select('setting_value').eq('setting_key', 'reservation_rules').maybeSingle(),
            supabase.from('event_types').select('name, min_advance_days')
        ]);

        if (settingsRow?.setting_value) {
            const parsed = JSON.parse(settingsRow.setting_value);
            if (Number.isFinite(Number(parsed.min_advance_days))) rules.minAdvanceDays = Number(parsed.min_advance_days);
            if (Number.isFinite(Number(parsed.max_advance_days))) rules.maxAdvanceDays = Number(parsed.max_advance_days);
        }

        (eventTypeRows || []).forEach((row) => {
            // row.min_advance_days is null for event types that inherit the
            // site-wide default — Number(null) is 0 (not NaN), so a naive
            // Number.isFinite(Number(x)) check was treating "no override" as
            // an explicit 0-day override and silently erasing the notice
            // window for every event type without one configured.
            if (row?.name && row.min_advance_days !== null && row.min_advance_days !== undefined) {
                const override = Number(row.min_advance_days);
                if (Number.isFinite(override)) rules.eventTypeOverrides.set(row.name, override);
            }
        });
    } catch {
        // Fetch/parse failure — the site-wide defaults above stand.
    }

    return rules;
}

export function getEffectiveMinAdvanceDays(rules, eventType) {
    const override = rules?.eventTypeOverrides?.get(eventType);
    return Number.isFinite(override) ? override : (rules?.minAdvanceDays ?? DEFAULT_MIN_ADVANCE_DAYS);
}

export function isOutsideBookingWindow(date, today, rules, eventType) {
    const diffDays = Math.round((date - today) / 86400000);
    const minAdvanceDays = getEffectiveMinAdvanceDays(rules, eventType);
    const maxAdvanceDays = rules?.maxAdvanceDays ?? DEFAULT_MAX_ADVANCE_DAYS;
    return diffDays < minAdvanceDays || diffDays > maxAdvanceDays;
}

export function getCalendarRange(month) {
    const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridStart.getDate() + 41);

    return {
        monthStart,
        gridStart,
        gridEnd,
        fromDate: buildDateKey(gridStart),
        toDate: buildDateKey(gridEnd)
    };
}
