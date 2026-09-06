// reservation_extensions.js — Package Extension Hours data layer.
// Pure Supabase-calling functions only, no DOM access — mirrors the shape
// of js/reservation_availability.js so callers (reservation_details.js)
// wire it the same way they already wire that module.

// Pre-flight check (spec item 2) — server-authoritative max extendable
// hours, price per hour, and (if capped by another booking) the label to
// show the customer. Never computed client-side: the DB function this
// calls (get_extension_availability(), via the public get_max_extension_
// hours() wrapper) is the same one the INSERT trigger re-validates
// against, so the number shown here can never drift from what the server
// will actually accept.
export async function fetchMaxExtensionHours(supabase, reservationId) {
    const { data, error } = await supabase.rpc('get_max_extension_hours', {
        p_reservation_id: reservationId
    });
    if (error) throw error;
    return {
        maxHours: Number(data?.max_hours || 0),
        pricePerHour: data?.price_per_hour !== null && data?.price_per_hour !== undefined ? Number(data.price_per_hour) : null,
        extendable: Boolean(data?.extendable),
        nextBookingLabel: data?.next_booking_label || null
    };
}

// Submits the request itself — every other field (status, price snapshot,
// total, hold expiry) is computed server-side by
// set_extension_request_defaults() (see the migration), so the client only
// ever sends the one real input: how many hours.
export async function requestExtension(supabase, reservationId, requestedHours) {
    const { data, error } = await supabase
        .from('reservation_extensions')
        .insert({ reservation_id: reservationId, requested_hours: requestedHours })
        .select('extension_id, requested_hours, price_per_hour, total_price, status, hold_expires_at')
        .single();
    if (error) throw error;
    return data;
}
