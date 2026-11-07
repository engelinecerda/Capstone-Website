// audit_summary.js — turns the raw `details` text saved with some audit
// entries into a sentence a non-technical admin can read.
//
// Several settings pages save their whole payload as JSON ("[{"weekday":0,
// "is_open":true,...}]") or as key=value pairs ("min_advance_days=3,
// max_advance_days=60"). That is fine as a record but unreadable in the
// Activity Log. This runs at display time, so it also fixes entries that
// are already stored; the saved text itself is never changed, and the
// expanded row still shows it exactly as saved.
//
//   describeAuditDetails(log, { venues, eventTypes, packages })
//     -> readable text, or the original details when they were already
//        readable (or can't be parsed — never throws).
//
// venues / eventTypes / packages are optional { id: name } maps used to turn
// the IDs in the capacity, per-event-type and contract-template entries into
// names.

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SCOPE_LABELS = {
    onsite_vip: 'Onsite — VIP',
    onsite_main_hall: 'Onsite — Main Hall',
    offsite: 'Offsite'
};
const PAYMENT_TYPE_LABELS = {
    reservation_fee: 'Reservation fee',
    down_payment: 'Down payment',
    full_payment: 'Full payment',
    partial_payment: 'Partial payment'
};
const LEGAL_TEXT_LABELS = {
    terms_and_conditions: 'Terms & Conditions',
    data_privacy_policy: 'Data Privacy Policy',
    cancellation_policy: 'Cancellation Policy'
};

function parseJson(text) {
    try { return JSON.parse(text); } catch { return undefined; }
}

function isBlank(value) {
    return value === null || value === undefined || value === '' || value === 'null' || value === 'undefined' || value === 'none';
}

function plural(n, word) {
    return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

function peso(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return '₱' + n.toLocaleString('en-PH', { maximumFractionDigits: 2 });
}

function onOff(flag) {
    return flag ? 'on' : 'off';
}

// "13:05" / "13:05:00" -> "1:05 PM"; "00:00" -> "12:00 AM"
function time12(value) {
    const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/);
    if (!match) return String(value ?? '');
    const hours = Number(match[1]);
    const suffix = hours >= 12 ? 'PM' : 'AM';
    return `${hours % 12 || 12}:${match[2]} ${suffix}`;
}

function formatWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
        + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// [0,1,2,4] -> "Sun–Tue, Thu"; all seven -> "Every day"
function describeDays(weekdays) {
    const days = [...weekdays].sort((a, b) => a - b);
    if (days.length === 7) return 'Every day';
    const parts = [];
    let i = 0;
    while (i < days.length) {
        let j = i;
        while (j + 1 < days.length && days[j + 1] === days[j] + 1) j += 1;
        parts.push(j - i >= 2
            ? `${DAY_SHORT[days[i]]}–${DAY_SHORT[days[j]]}`
            : days.slice(i, j + 1).map((d) => DAY_SHORT[d]).join(', '));
        i = j + 1;
    }
    return parts.join(', ');
}

// ── JSON payloads ────────────────────────────────────────────────────────────

function operatingHours(details) {
    const rows = parseJson(details);
    if (!Array.isArray(rows) || !rows.length) return null;

    // Group days that share the same hours so a normal week reads as one line.
    const groups = new Map();
    rows.forEach((row) => {
        const weekday = Number(row.weekday);
        if (!(weekday >= 0 && weekday <= 6)) return;
        const label = row.is_open
            ? `${time12(row.open_time)} – ${time12(row.close_time)}`
            : 'Closed';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(weekday);
    });
    if (!groups.size) return null;

    const lines = [...groups.entries()].map(([label, days]) => `${describeDays(days)}: ${label}`);
    return `${lines.join('; ')}.`;
}

function scopeCapacity(details) {
    const rows = parseJson(details);
    if (!Array.isArray(rows) || !rows.length) return null;
    const parts = rows.map((row) => {
        const name = SCOPE_LABELS[row.scope] || String(row.scope || 'Unknown').replace(/_/g, ' ');
        return isBlank(row.capacity) ? `${name}: default` : `${name}: ${plural(row.capacity, 'booking')} per day`;
    });
    return `${parts.join('; ')}.`;
}

function venueCapacity(details, lookups) {
    const rows = parseJson(details);
    if (!Array.isArray(rows) || !rows.length) return null;
    const parts = rows.map((row) => {
        const name = lookups.venues?.[row.venue_id] || 'A venue that no longer exists';
        return isBlank(row.capacity) ? `${name}: default` : `${name}: ${plural(row.capacity, 'booking')} per day`;
    });
    return `${parts.join('; ')}.`;
}

function eventTypeNotice(details, lookups) {
    const map = parseJson(details);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const overrides = Object.entries(map).filter(([, days]) => !isBlank(days));
    if (!overrides.length) return 'Every event type now uses the site-wide minimum notice.';
    const parts = overrides.map(([id, days]) => `${lookups.eventTypes?.[id] || 'An event type that no longer exists'}: ${plural(days, 'day')}`);
    return `${parts.join('; ')}. All other event types use the site-wide minimum notice.`;
}

function venueMapScope(details) {
    const b = parseJson(details);
    if (!b || typeof b !== 'object') return null;
    const { sw_lat, sw_lng, ne_lat, ne_lng } = b;
    if (![sw_lat, sw_lng, ne_lat, ne_lng].every((n) => Number.isFinite(Number(n)))) return null;
    const midLat = (Number(sw_lat) + Number(ne_lat)) / 2;
    const heightKm = Math.abs(Number(ne_lat) - Number(sw_lat)) * 111;
    const widthKm = Math.abs(Number(ne_lng) - Number(sw_lng)) * 111 * Math.cos(midLat * Math.PI / 180);
    return `The map area now covers about ${Math.round(widthKm)} km across by ${Math.round(heightKm)} km tall.`;
}

function paymentRules(details) {
    const c = parseJson(details);
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const parts = [];
    if (!isBlank(c.max_installments)) parts.push(`up to ${plural(c.max_installments, 'installment')}`);
    if (!isBlank(c.proof_of_payment_window_days)) parts.push(`proof of payment due within ${plural(c.proof_of_payment_window_days, 'day')}`);
    if (typeof c.auto_hold_enabled === 'boolean') parts.push(`auto-hold ${onOff(c.auto_hold_enabled)}`);
    if (!isBlank(c.cancellation_fee_onsite) || !isBlank(c.cancellation_fee_offsite)) {
        parts.push(`cancellation fee ${peso(c.cancellation_fee_onsite ?? 0)} onsite / ${peso(c.cancellation_fee_offsite ?? 0)} offsite`);
    }
    if (!isBlank(c.reschedule_fee)) parts.push(`reschedule fee ${peso(c.reschedule_fee)}`);
    if (!isBlank(c.service_charge_percent)) {
        parts.push(`service charge ${c.service_charge_percent}%${c.service_charge_applies_offsite ? ' (also applied offsite)' : ' (onsite only)'}`);
    }
    return parts.length ? `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : null;
}

function formFields(details) {
    const r = parseJson(details);
    if (!r || typeof r !== 'object') return null;
    const parts = [];
    if (typeof r.contact_phone_required === 'boolean') parts.push(`phone number ${r.contact_phone_required ? 'required' : 'optional'}`);
    if (typeof r.special_requests_required === 'boolean') parts.push(`special requests ${r.special_requests_required ? 'required' : 'optional'}`);
    return parts.length ? `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.` : null;
}

// "Updated down_payment: {"label":"Down Payment","is_active":true,"percent_of_total":30}"
function paymentType(details) {
    const match = String(details).match(/^Updated (\w+): (\{.*\})$/s);
    if (!match) return null;
    const p = parseJson(match[2]);
    if (!p || typeof p !== 'object') return null;
    const name = PAYMENT_TYPE_LABELS[match[1]] || match[1].replace(/_/g, ' ');
    const parts = [];
    if (p.label) parts.push(`shown to customers as “${p.label}”`);
    if (typeof p.is_active === 'boolean') parts.push(p.is_active ? 'active' : 'turned off');
    if (!isBlank(p.flat_amount)) parts.push(`flat amount ${peso(p.flat_amount)}`);
    if (!isBlank(p.percent_of_total)) parts.push(`${p.percent_of_total}% of the total`);
    if ('min_amount' in p) parts.push(isBlank(p.min_amount) ? 'no minimum amount' : `minimum ${peso(p.min_amount)}`);
    return `${name}: ${parts.join(', ')}.`;
}

// ── key=value text ───────────────────────────────────────────────────────────

function pairs(details) {
    const out = {};
    String(details).split(/,\s*/).forEach((chunk) => {
        const eq = chunk.indexOf('=');
        if (eq > 0) out[chunk.slice(0, eq).trim()] = chunk.slice(eq + 1).trim();
    });
    return out;
}

function days(value, fallback) {
    return isBlank(value) ? fallback : plural(value, 'day');
}

function bookingNotice(details) {
    const p = pairs(details);
    if (isBlank(p.min_advance_days) && isBlank(p.max_advance_days)) return null;
    return `Customers must book at least ${days(p.min_advance_days, '0 days')} ahead and up to ${days(p.max_advance_days, 'no limit')} ahead.`;
}

function cancellationRules(details) {
    const p = pairs(details);
    if (!('min_notice' in p) && !('request_window' in p) && !('grace_period' in p)) return null;
    return `Minimum notice before the event: ${days(p.min_notice, 'none')}; `
        + `cancellation request window: ${days(p.request_window, 'none')}; `
        + `overdue balance grace period: ${days(p.grace_period, 'none')}.`;
}

function reschedulePolicy(details) {
    const p = pairs(details);
    if (!('hold' in p) && !('min_notice' in p) && !('max_count' in p)) return null;
    const hold = String(p.hold || '').replace(/h$/, '');
    return `Date held for ${isBlank(hold) ? 'the default time' : plural(hold, 'hour')} while the fee is unpaid; `
        + `minimum notice before the original event: ${days(p.min_notice, 'none')}; `
        + `maximum reschedules per reservation: ${isBlank(p.max_count) ? 'default' : p.max_count}.`;
}

function extensionRules(details) {
    const p = pairs(details);
    const minutes = String(p.hold || '').replace(/m$/, '');
    if (isBlank(minutes)) return null;
    return `Payment hold of ${plural(minutes, 'minute')}.`;
}

function bufferCapacity(details) {
    const p = pairs(details);
    const buffer = String(p.buffer || '').replace(/min$/, '');
    if (isBlank(buffer) && isBlank(p.default_capacity)) return null;
    return `${isBlank(buffer) ? 'Default buffer' : `${plural(buffer, 'minute')} between bookings`}; `
        + `${isBlank(p.default_capacity) ? 'default' : plural(p.default_capacity, 'booking')} per scope per day.`;
}

function maintenanceSchedule(details) {
    const p = pairs(details);
    if (!('start' in p) && !('end' in p)) return null;
    const start = isBlank(p.start) ? null : formatWhen(p.start);
    const end = isBlank(p.end) ? null : formatWhen(p.end);
    if (!start && !end) return 'Schedule cleared — maintenance mode is switched on and off manually only.';
    return `Turns on ${start || 'manually (no start time)'}; turns off ${end || 'manually (no end time)'}.`;
}

function eliteBanner(details) {
    const p = pairs(details);
    if (!('is_active' in p)) return null;
    return `Banner turned ${p.is_active === 'true' ? 'on' : 'off'}.`;
}

function legalText(details) {
    const match = String(details).match(/^Updated (\w+)$/);
    if (!match) return null;
    return `${LEGAL_TEXT_LABELS[match[1]] || match[1].replace(/_/g, ' ')} shown on the reservation form.`;
}

// Updated "Heading" (internal_key) — applies to ...  ->  drop the internal key
function lockedClause(details) {
    const cleaned = String(details).replace(/\s*\([a-z0-9_]+\)(?=\s*—)/i, '');
    return cleaned === details ? null : cleaned;
}

// "Package 3f2a…" / "4 clause(s) for package 3f2a…" -> the package's name
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function packageById(details, lookups) {
    if (!UUID.test(details)) return null;
    const name = (id) => lookups.packages?.[id] ? `“${lookups.packages[id]}”` : '(deleted package)';
    return String(details).replace(new RegExp(UUID.source, 'gi'), (id) => name(id.toLowerCase()) );
}

function galleryRemoved(details) {
    return /^Removed: https?:\/\//i.test(details) ? 'The image had no caption.' : null;
}

const BY_ACTION = {
    'Updated Operating Hours': operatingHours,
    'Updated Per-Scope Capacity': scopeCapacity,
    'Updated Per-Venue Capacity': venueCapacity,
    'Updated Per-Event-Type Booking Notice': eventTypeNotice,
    'Updated Venue Map Scope': venueMapScope,
    'Updated Payment Rules': paymentRules,
    'Updated Reservation Form Fields': formFields,
    'Updated Payment Type': paymentType,
    'Updated Booking Notice Window': bookingNotice,
    'Updated Cancellation Notice Rules': cancellationRules,
    'Updated Reschedule Policy': reschedulePolicy,
    'Updated Extension Rules': extensionRules,
    'Updated Buffer & Capacity': bufferCapacity,
    'Updated Maintenance Schedule': maintenanceSchedule,
    'Updated Elite Card Banner': eliteBanner,
    'Updated Reservation Form Legal Text': legalText,
    'Updated Locked Contract Clause': lockedClause,
    'Removed Gallery Image': galleryRemoved,
    'Updated Contract Title & Introduction': packageById,
    'Updated Contract Template Clauses': packageById
};

// Anything not listed above that still looks like a data dump: say so plainly
// instead of printing it. Covers settings added later.
function genericFallback(details) {
    const text = String(details).trim();
    if (/^[{[]/.test(text) && parseJson(text) !== undefined) {
        return 'Settings were updated. Open this entry to see the saved values.';
    }
    if (/^[a-z][a-z0-9_]*=[^,]*(,\s*[a-z][a-z0-9_]*=[^,]*)*$/i.test(text)) {
        return text.split(/,\s*/)
            .map((pair) => pair.replace(/^([a-z0-9_]+)=/i, (_, key) => key.replace(/_/g, ' ') + ': '))
            .join('; ');
    }
    return null;
}

export function describeAuditDetails(log, lookups = {}) {
    const details = log?.details;
    if (!details) return '';
    try {
        const formatter = BY_ACTION[String(log.action || '').trim()];
        const result = (formatter ? formatter(String(details), lookups) : null) ?? genericFallback(details);
        return result || String(details);
    } catch {
        return String(details);
    }
}
