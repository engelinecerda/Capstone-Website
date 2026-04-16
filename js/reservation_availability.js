export const BOOKING_LIMITS = {
    onsite_vip: 1,
    onsite_main_hall: 1,
    offsite: 1
};

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

export function getBookingScope(locationTypeOrReservation, packageName = '') {
    if (locationTypeOrReservation && typeof locationTypeOrReservation === 'object') {
        return getBookingScope(
            locationTypeOrReservation.location_type,
            locationTypeOrReservation.package?.package_name || locationTypeOrReservation.package_name || ''
        );
    }

    const location = String(locationTypeOrReservation || '').toLowerCase();
    const name = String(packageName || '').toLowerCase();

    if (location === 'offsite') return 'offsite';
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
    return Object.keys(BOOKING_LIMITS).every((scope) => scopeSet.has(scope));
}

export function isScopeOccupied(occupiedScopes, scope) {
    if (!scope) return false;
    return new Set(occupiedScopes || []).has(scope);
}

export function getAvailabilitySummaryMessage(occupiedScopes, scope = '') {
    if (isScopeOccupied(occupiedScopes, scope)) {
        return `${getScopeLabel(scope)} already booked on this date.`;
    }

    if (isDateFullyBooked(occupiedScopes)) {
        return 'This date is fully booked.';
    }

    if ((occupiedScopes || []).length) {
        const labels = (occupiedScopes || []).map((entry) => getScopeLabel(entry));
        return `${labels.join(', ')} already booked on this date.`;
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
