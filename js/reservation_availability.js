export const DAILY_BOOKING_LIMIT = 2;

export const BLOCKING_RESERVATION_STATUSES = new Set(['pending', 'approved', 'confirmed', 'rescheduled']);

export const DEFAULT_TIME_OPTIONS = [
    '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
    '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'
];

export const BLACKOUT_DATE_COLUMNS = ['closed_date', 'date'];
export const BLACKOUT_REASON_COLUMNS = ['note', 'reason'];

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
    // supabase/migrations/20260706_package_explicit_booking_scope.sql. Name
    // matching below only runs for packages an admin hasn't configured yet.
    if (explicitScope) return explicitScope;

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
        return 'offsite';
    }
    if (location === 'onsite' && name.includes('main hall')) return 'onsite_main_hall';
    if (location === 'onsite' && name.includes('vip')) return 'onsite_vip';
    return null;
}

export function getScopeLabel(scope) {
    return {
        onsite_vip: 'VIP',
        onsite_main_hall: 'Main Hall',
        offsite: 'Off-site'
    }[scope] || 'Selected package';
}

export function isBlockingReservationStatus(status) {
    return BLOCKING_RESERVATION_STATUSES.has(String(status || '').toLowerCase());
}

export function getOccupiedScopesFromReservations(reservations, dateKey, excludeReservationId = null) {
    const occupiedScopes = new Set();
    (reservations || []).forEach((reservation) => {
        if (!isBlockingReservationStatus(reservation?.status)) return;
        if (formatDateKey(reservation?.event_date) !== formatDateKey(dateKey)) return;
        if (excludeReservationId && String(reservation?.reservation_id) === String(excludeReservationId)) return;

        const scope = getBookingScope(reservation);
        if (scope) occupiedScopes.add(scope);
    });
    return Array.from(occupiedScopes);
}

export function isDateFullyBooked(occupiedScopes) {
    const scopeSet = new Set(occupiedScopes || []);
    return ['onsite_vip', 'onsite_main_hall', 'offsite'].every((scope) => scopeSet.has(scope));
}

export function isScopeOccupied(occupiedScopes, scope) {
    if (!scope) return false;
    return new Set(occupiedScopes || []).has(scope);
}

export function getAvailabilitySummaryMessage(occupiedScopes, scope = '') {
    if ((occupiedScopes || []).length) {
        return 'This date is fully booked.';
    }
    return 'This date is available.';
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

export async function fetchDateAvailability(supabase, { eventDate, scope = '', durationHours = null, excludeReservationId = null } = {}) {
    if (!eventDate) {
        return normalizeAvailabilityPayload({}, '');
    }

    const { data, error } = await supabase.rpc('get_booking_availability', {
        p_event_date: eventDate,
        p_scope: scope || null,
        p_duration_hours: Number.isFinite(Number(durationHours)) ? Number(durationHours) : null,
        p_exclude_reservation_id: excludeReservationId || null
    });

    if (error) throw error;
    return normalizeAvailabilityPayload(data, eventDate);
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

export async function fetchAvailableStartTimes(supabase, { eventDate, scope = '', durationHours = null, excludeReservationId = null } = {}) {
    if (!eventDate) return [];

    const { data, error } = await supabase.rpc('get_available_start_times', {
        p_event_date: eventDate,
        p_scope: scope || null,
        p_duration_hours: Number.isFinite(Number(durationHours)) ? Number(durationHours) : null,
        p_exclude_reservation_id: excludeReservationId || null
    });

    if (error) throw error;
    return (Array.isArray(data) ? data : []).map(normalizeStartTimeRow);
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

    for (const column of BLACKOUT_DATE_COLUMNS) {
        const { error } = await supabase
            .from('calendar_blackouts')
            .select(column)
            .limit(1);

        if (!error) {
            cache.blackoutDateColumn = column;
            return column;
        }
    }

    return null;
}

export async function resolveBlackoutReasonColumn(supabase, cache = {}) {
    if (cache.blackoutReasonColumn) return cache.blackoutReasonColumn;

    for (const column of BLACKOUT_REASON_COLUMNS) {
        const { error } = await supabase
            .from('calendar_blackouts')
            .select(column)
            .limit(1);

        if (!error) {
            cache.blackoutReasonColumn = column;
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
            if (row?.name && Number.isFinite(Number(row.min_advance_days))) {
                rules.eventTypeOverrides.set(row.name, Number(row.min_advance_days));
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
