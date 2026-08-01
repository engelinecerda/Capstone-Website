export const BUSINESS_TIME_ZONE = 'Asia/Manila';

const LEGACY_STATUS_MAP = {
    pending: 'pending_review',
    approved: 'confirmed',
    rescheduled: 'confirmed',
    resubmission_requested: 'for_contract_signing'
};

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'declined']);
const COMPLETABLE_STATUSES = new Set(['confirmed', 'partially_paid', 'fully_paid']);

export function formatDateKey(value) {
    return String(value || '').split('T')[0];
}

export function getTimeZoneNowParts(timeZone = BUSINESS_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(new Date()).reduce((map, part) => {
        if (part.type !== 'literal') {
            map[part.type] = part.value;
        }
        return map;
    }, {});

    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        hours: Number(parts.hour || 0),
        minutes: Number(parts.minute || 0)
    };
}

export function parseEventTimeToParts(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;

    const meridiemMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (meridiemMatch) {
        let hours = Number(meridiemMatch[1]);
        const minutes = Number(meridiemMatch[2]);
        const meridiem = meridiemMatch[3].toUpperCase();

        if (hours === 12) {
            hours = meridiem === 'AM' ? 0 : 12;
        } else if (meridiem === 'PM') {
            hours += 12;
        }

        return { hours, minutes };
    }

    const directMatch = normalized.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (directMatch) {
        return {
            hours: Number(directMatch[1]),
            minutes: Number(directMatch[2])
        };
    }

    const parsed = new Date(`1970-01-01 ${normalized}`);
    if (Number.isNaN(parsed.getTime())) return null;

    return {
        hours: parsed.getHours(),
        minutes: parsed.getMinutes()
    };
}

export function getReservationEventDateTime(reservation) {
    const dateKey = formatDateKey(reservation?.event_date);
    if (!dateKey) return null;

    const timeParts = parseEventTimeToParts(reservation?.event_time);
    const date = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;

    if (timeParts) {
        date.setHours(timeParts.hours, timeParts.minutes, 0, 0);
    }

    return date;
}

export function normalizeReservationStatus(status) {
    const normalized = String(status || 'pending_review').toLowerCase();
    return LEGACY_STATUS_MAP[normalized] || normalized;
}

export function getReservationStatusMeta(status) {
    const normalizedStatus = normalizeReservationStatus(status);
    const statusMap = {
        pending_review: { key: 'pending', label: 'Pending Review' },
        for_finalization: { key: 'info', label: 'For Finalization' },
        for_contract_signing: { key: 'info', label: 'For Contract Signing' },
        confirmed: { key: 'approved', label: 'Confirmed' },
        partially_paid: { key: 'info', label: 'Partially Paid' },
        fully_paid: { key: 'approved', label: 'Fully Paid' },
        declined: { key: 'rejected', label: 'Declined' },
        cancelled: { key: 'cancelled', label: 'Cancelled' },
        completed: { key: 'approved', label: 'Completed' }
    };

    return statusMap[normalizedStatus] || {
        key: normalizedStatus,
        label: normalizedStatus
            .split('_')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ')
    };
}

export function isReservationEventPast(reservation, timeZone = BUSINESS_TIME_ZONE) {
    const dateKey = formatDateKey(reservation?.event_date);
    if (!dateKey) return false;

    const nowParts = getTimeZoneNowParts(timeZone);
    if (dateKey < nowParts.dateKey) {
        return true;
    }

    if (dateKey > nowParts.dateKey) {
        return false;
    }

    const eventTimeParts = parseEventTimeToParts(reservation?.event_time) || { hours: 0, minutes: 0 };
    const eventMinutes = (eventTimeParts.hours * 60) + eventTimeParts.minutes;
    const currentMinutes = (nowParts.hours * 60) + nowParts.minutes;

    return eventMinutes <= currentMinutes;
}

export function shouldPersistCompletedStatus(reservation, timeZone = BUSINESS_TIME_ZONE) {
    const normalizedStatus = normalizeReservationStatus(reservation?.status);
    if (!COMPLETABLE_STATUSES.has(normalizedStatus)) {
        return false;
    }

    return isReservationEventPast(reservation, timeZone);
}

export function getEffectiveReservationStatus(reservation, timeZone = BUSINESS_TIME_ZONE) {
    const normalizedStatus = normalizeReservationStatus(reservation?.status);
    if (TERMINAL_STATUSES.has(normalizedStatus)) {
        return normalizedStatus;
    }

    if (shouldPersistCompletedStatus(reservation, timeZone)) {
        return 'completed';
    }

    return normalizedStatus;
}

export async function syncCompletedReservations({ supabase, reservations, timeZone = BUSINESS_TIME_ZONE }) {
    const items = Array.isArray(reservations) ? reservations : [];
    if (!supabase || !items.length) {
        return items;
    }

    const candidateIds = items
        .filter((reservation) => shouldPersistCompletedStatus(reservation, timeZone))
        .map((reservation) => reservation?.reservation_id)
        .filter(Boolean);

    if (!candidateIds.length) {
        return items;
    }

    try {
        const { error } = await supabase
            .from('reservations')
            .update({ status: 'completed' })
            .in('reservation_id', candidateIds);

        if (error) {
            return items;
        }

        const completedSet = new Set(candidateIds.map((value) => String(value)));
        return items.map((reservation) => (
            completedSet.has(String(reservation?.reservation_id))
                ? { ...reservation, status: 'completed' }
                : reservation
        ));
    } catch (error) {
        return items;
    }
}
