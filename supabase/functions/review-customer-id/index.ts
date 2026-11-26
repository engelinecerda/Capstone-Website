// Staff review of a customer's valid ID (front + back).
//
// Why this exists: the automatic check compares the signature on the ID with
// the one drawn on the contract. Some IDs are genuine but carry no signature,
// so the check can never pass them. A manager needs to SEE the ID and decide.
//
// The `customer-ids` bucket is private with owner-only storage policies, and
// that does not change. Staff never read it directly: they call this function,
// which (1) checks the caller's role, (2) works out whose ID it is from the
// reservation or the customer id (looked up server-side, never a storage path
// from the browser), (3) logs the view, and (4) returns 2-minute signed links.
//
// The decision is about the ID itself (valid_id_review, one row per customer,
// flagged by `check-valid-id` when no signature is found), and it carries over
// to the customer's contracts that are waiting on that same ID.
//
// Two ways in (POST JSON, Authorization: Bearer <staff session token>):
//   * Reservation Details page: { action, reservation_id }
//       approve/reject only while that contract is still pending review.
//   * Customers page:           { action, customer_id }
//       approve/reject only while the ID is flagged (no signature found), so it
//       works for a customer who has no reservation yet.
//
// Actions:
//   view     -> { front_url, back_url, front_uploaded_at, back_uploaded_at,
//                 review: { status, signature_check, note } }
//               Manager or Admin. Every view is logged in valid_id_access_log.
//   approve  -> ID marked 'approved'. Every contract of the customer waiting on
//               the ID is verified (id_check_status = 'manual_approved') and its
//               reservation moves on to 'for_finalization', exactly like an
//               automatic signature match. Later bookings skip the signature
//               comparison until the customer replaces the ID. Manager only.
//   reject   -> note required. ID marked 'rejected' (the customer must upload a
//               new one); waiting contracts stay pending with id_check_status =
//               'id_rejected', attempts reset, customer notified. Manager only.
//
// Deploy with the CLI (imports _shared/):
//   npx supabase functions deploy review-customer-id

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { notifyCustomer, VALID_ID_BUCKET } from '../_shared/id_signature_check.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const SIGNED_URL_SECONDS = 120;
const NOTE_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Contract states that mean "only waiting on a manager's decision about the ID".
const WAITING_ON_ID = ['awaiting_id_review', 'no_id_signature'];

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, error: 'Server is not configured.' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  const { data: callerData, error: callerError } = await supabase.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  }
  const callerId = callerData.user.id;

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', callerId)
    .maybeSingle();
  const callerRole = String(callerProfile?.role ?? '').toLowerCase();
  if (callerRole !== 'manager' && callerRole !== 'admin') {
    return jsonResponse({ success: false, error: 'Only staff can open a customer’s ID.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body.' }, 400);
  }

  const action = String(body.action || '');
  const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id.trim() : '';
  const customerIdParam = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  const note = String(body.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

  if (!['view', 'approve', 'reject'].includes(action)) {
    return jsonResponse({ success: false, error: 'Unknown action.' }, 400);
  }
  // Exactly one of the two: the browser says which page it is on.
  if ((reservationId ? 1 : 0) + (customerIdParam ? 1 : 0) !== 1) {
    return jsonResponse({ success: false, error: 'A reservation or a customer is required.' }, 400);
  }
  if ((reservationId && !UUID_RE.test(reservationId)) || (customerIdParam && !UUID_RE.test(customerIdParam))) {
    return jsonResponse({ success: false, error: 'Invalid reservation or customer.' }, 400);
  }
  // Admins can look; only managers decide.
  if (action !== 'view' && callerRole !== 'manager') {
    return jsonResponse({ success: false, error: 'Only a manager can approve or reject a customer’s ID.' }, 403);
  }

  try {
    // ── Whose ID is it? ────────────────────────────────────────────────
    let customerId: string;
    let fromReservation: { reservation_id: string; reservation_number: string } | null = null;

    if (reservationId) {
      const { data: reservation } = await supabase
        .from('reservations')
        .select('reservation_id, reservation_number, user_id')
        .eq('reservation_id', reservationId)
        .maybeSingle();
      if (!reservation?.user_id) {
        return jsonResponse({ success: false, error: 'Reservation not found.' }, 404);
      }
      customerId = reservation.user_id as string;
      fromReservation = {
        reservation_id: reservation.reservation_id as string,
        reservation_number: reservation.reservation_number as string,
      };
    } else {
      const { data: customer } = await supabase
        .from('profiles')
        .select('user_id, role')
        .eq('user_id', customerIdParam)
        .maybeSingle();
      if (!customer || customer.role !== 'customer') {
        return jsonResponse({ success: false, error: 'Customer not found.' }, 404);
      }
      customerId = customer.user_id as string;
    }

    const { data: review } = await supabase
      .from('valid_id_review')
      .select('status, signature_check, review_note')
      .eq('user_id', customerId)
      .maybeSingle();

    // ── view ────────────────────────────────────────────────────────────
    if (action === 'view') {
      const { data: profile } = await supabase
        .from('profiles')
        .select('valid_id_uploaded_at, valid_id_back_uploaded_at')
        .eq('user_id', customerId)
        .maybeSingle();

      // Log BEFORE handing anything out: if logging fails, nothing is shown.
      const { error: logError } = await supabase.from('valid_id_access_log').insert({
        viewer_id: callerId,
        customer_id: customerId,
        reservation_id: fromReservation?.reservation_id ?? null,
        action: 'view',
      });
      if (logError) throw logError;

      const sign = async (path: string): Promise<string | null> => {
        const { data, error } = await supabase.storage
          .from(VALID_ID_BUCKET)
          .createSignedUrl(path, SIGNED_URL_SECONDS);
        return error ? null : (data?.signedUrl ?? null);
      };
      // Only sign the sides the profile says are on file.
      const [frontUrl, backUrl] = await Promise.all([
        profile?.valid_id_uploaded_at ? sign(`${customerId}/valid-id.jpg`) : Promise.resolve(null),
        profile?.valid_id_back_uploaded_at ? sign(`${customerId}/valid-id-back.jpg`) : Promise.resolve(null),
      ]);

      return jsonResponse({
        success: true,
        front_url: frontUrl,
        back_url: backUrl,
        front_uploaded_at: profile?.valid_id_uploaded_at ?? null,
        back_uploaded_at: profile?.valid_id_back_uploaded_at ?? null,
        review: {
          status: review?.status ?? 'unchecked',
          signature_check: review?.signature_check ?? null,
          note: review?.review_note ?? null,
        },
        can_decide: callerRole === 'manager',
        expires_in: SIGNED_URL_SECONDS,
      });
    }

    // ── approve / reject: is there something to decide? ─────────────────
    if (fromReservation) {
      // Reservation page: only while that contract is still waiting for review.
      const { data: contract } = await supabase
        .from('reservation_contracts')
        .select('review_status')
        .eq('reservation_id', fromReservation.reservation_id)
        .maybeSingle();
      if (!contract) {
        return jsonResponse({ success: false, error: 'No contract found for this reservation.' }, 404);
      }
      if (contract.review_status !== 'pending_review') {
        return jsonResponse({ success: false, error: 'This contract has already been reviewed.' }, 409);
      }
    } else if (review?.status !== 'flagged') {
      // Customers page: only an ID the check flagged (no signature) is waiting.
      return jsonResponse({ success: false, error: 'This ID is not waiting for review.' }, 409);
    }

    const now = new Date().toISOString();

    // Records the decision on the ID. From the Customers page it only applies
    // while the ID is still flagged: if the customer replaced the photo in the
    // meantime (the trigger resets the row to 'unchecked'), nothing is written,
    // so a decision can never land on a photo the manager did not see.
    const recordDecision = async (status: 'approved' | 'rejected'): Promise<boolean> => {
      const decision = {
        status,
        review_note: status === 'rejected' ? note : (note || null),
        reviewed_by: callerId,
        reviewed_at: now,
        updated_at: now,
      };
      if (fromReservation) {
        const { error } = await supabase
          .from('valid_id_review')
          .upsert({ user_id: customerId, ...decision }, { onConflict: 'user_id' });
        if (error) throw error;
        return true;
      }
      const { data, error } = await supabase
        .from('valid_id_review')
        .update(decision)
        .eq('user_id', customerId)
        .eq('status', 'flagged')
        .select('user_id');
      if (error) throw error;
      return (data ?? []).length > 0;
    };
    const changedMeanwhile = () => jsonResponse(
      { success: false, error: 'The customer changed their ID while you were reviewing it. Reload and check again.' },
      409,
    );

    // Contracts of this customer that are only waiting on the same ID.
    const { data: ownReservations } = await supabase
      .from('reservations')
      .select('reservation_id, reservation_number')
      .eq('user_id', customerId);
    const numberById = new Map<string, string>(
      (ownReservations ?? []).map((r: { reservation_id: string; reservation_number: string }) => [r.reservation_id, r.reservation_number]),
    );
    const targets = new Set<string>();
    if (fromReservation) targets.add(fromReservation.reservation_id);
    if (numberById.size) {
      const { data: waiting, error: waitingError } = await supabase
        .from('reservation_contracts')
        .select('reservation_id')
        .in('reservation_id', [...numberById.keys()])
        .eq('review_status', 'pending_review')
        .in('id_check_status', WAITING_ON_ID);
      if (waitingError) throw waitingError;
      (waiting ?? []).forEach((c: { reservation_id: string }) => targets.add(c.reservation_id));
    }
    const targetIds = [...targets];

    if (action === 'approve') {
      // The decision is about the ID. A customer's later bookings reuse it, so
      // they skip the signature comparison (it has no signature to compare).
      if (!(await recordDecision('approved'))) return changedMeanwhile();

      let verifiedIds: string[] = [];
      if (targetIds.length) {
        const { data: verified, error } = await supabase
          .from('reservation_contracts')
          .update({
            review_status: 'verified',
            verified_date: now,
            reviewed_at: now,
            review_notes: `Manually verified by a manager after viewing the customer’s ID.${note ? ` Note: ${note}` : ''}`,
            id_check_status: 'manual_approved',
            id_review_note: note || null,
            id_reviewed_by: callerId,
            id_reviewed_at: now,
          })
          .in('reservation_id', targetIds)
          .eq('review_status', 'pending_review')
          .select('reservation_id');
        if (error) throw error;
        verifiedIds = (verified ?? []).map((c: { reservation_id: string }) => c.reservation_id);
      }

      // Same advance an automatic signature match makes (applyIdCheckResult /
      // verify-contract): the contract is done, so the booking moves on.
      if (verifiedIds.length) {
        const { error: advanceError } = await supabase
          .from('reservations')
          .update({ status: 'for_finalization' })
          .in('reservation_id', verifiedIds)
          .in('status', ['for_contract_signing', 'pending_review']);
        if (advanceError) throw advanceError;
      }

      return jsonResponse({ success: true, decision: 'approved', contracts_updated: verifiedIds.length });
    }

    // reject
    if (!note) {
      return jsonResponse({ success: false, error: 'Please tell the customer what is wrong with the ID.' }, 400);
    }
    if (!(await recordDecision('rejected'))) return changedMeanwhile();

    let rejectedIds: string[] = [];
    if (targetIds.length) {
      const { data: updated, error } = await supabase
        .from('reservation_contracts')
        .update({
          // review_status stays 'pending_review'.
          reviewed_at: now,
          review_notes: `ID rejected by a manager: ${note}`,
          id_check_status: 'id_rejected',
          // A person asked for the replacement, so the customer gets a fresh set
          // of automatic checks rather than being locked out by old attempts.
          id_check_attempts: 0,
          id_review_note: note,
          id_reviewed_by: callerId,
          id_reviewed_at: now,
        })
        .in('reservation_id', targetIds)
        .eq('review_status', 'pending_review')
        .select('reservation_id');
      if (error) throw error;
      rejectedIds = (updated ?? []).map((c: { reservation_id: string }) => c.reservation_id);
    }

    if (rejectedIds.length) {
      for (const id of rejectedIds) {
        await notifyCustomer(
          supabase,
          customerId,
          id,
          'Please Upload Your ID Again',
          `Our team reviewed the ID for reservation ${numberById.get(id) ?? fromReservation?.reservation_number ?? ''}: ${note} ` +
            'Please upload a new photo of the front and back of your valid ID from My Profile or your reservation page.',
        );
      }
    } else {
      // No contract is waiting on this ID (e.g. reviewed from the Customers
      // page before the customer booked): point them at My Profile instead.
      const title = 'Please Upload Your ID Again';
      const message = `Our team reviewed your valid ID: ${note} ` +
        'Please upload a new photo of the front and back of your valid ID from My Profile.';
      const link = '/account?section=profile';
      const { error: notifyError } = await supabase.from('notifications').insert([
        { user_id: customerId, type: 'contract_review', title, body: message, link, channel: 'in_app', status: 'sent' },
        { user_id: customerId, type: 'contract_review', title, body: message, link, channel: 'email', status: 'pending' },
      ]);
      if (notifyError) console.error('id-review notification failed', { error: notifyError.message });
    }
    return jsonResponse({ success: true, decision: 'rejected', contracts_updated: rejectedIds.length });
  } catch (error) {
    console.error('review-customer-id failed', { action, error: String((error as Error).message) });
    return jsonResponse({ success: false, error: 'Something went wrong. Please try again.' }, 500);
  }
});
