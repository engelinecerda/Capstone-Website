// reservation_additional_head_requests.js — post-booking Additional Head
// Requests data layer. Pure Supabase-calling functions only, no DOM access
// — mirrors js/reservation_extensions.js's shape exactly (same reasoning:
// callers wire it the same way they already wire that module).

// Pre-flight check — server-authoritative max additional guests, price per
// head, and current cumulative count. Never computed client-side: the DB
// function this calls (get_additional_head_availability(), via the public
// get_max_additional_heads() wrapper) is the same one the INSERT trigger
// re-validates against, so the number shown here can never drift from what
// the server will actually accept.
export async function fetchMaxAdditionalHeads(supabase, reservationId) {
    const { data, error } = await supabase.rpc('get_max_additional_heads', {
        p_reservation_id: reservationId
    });
    if (error) throw error;
    return {
        maxAdditional: Number(data?.max_additional || 0),
        pricePerHead: data?.price_per_head !== null && data?.price_per_head !== undefined ? Number(data.price_per_head) : null,
        extendable: Boolean(data?.extendable),
        currentAdditionalHeads: Number(data?.current_additional_heads || 0)
    };
}

// Submits the request itself — every other field (status, price snapshot,
// total, hold expiry) is computed server-side by
// set_additional_head_request_defaults() (see the migration), so the
// client only ever sends the one real input: how many heads.
export async function requestAdditionalHeads(supabase, reservationId, requestedHeads) {
    const { data, error } = await supabase
        .from('reservation_additional_head_requests')
        .insert({ reservation_id: reservationId, requested_heads: requestedHeads })
        .select('additional_head_request_id, requested_heads, price_per_head, total_price, status, hold_expires_at')
        .single();
    if (error) throw error;
    return data;
}
