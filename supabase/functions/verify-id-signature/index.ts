import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  applyIdCheckResult,
  CUSTOMER_RETRY_STATES,
  decideIdOutcome,
  fetchStoredSignature,
  loadSavedIdBackForUser,
  loadSavedIdForUser,
  MAX_ID_BYTES,
  MAX_ID_CHECK_ATTEMPTS,
  parseDataUrl,
} from '../_shared/id_signature_check.ts';

// "Re-upload my ID" retry for a contract that is still pending because the
// signature on the first ID photo didn't match.
//
// The FIRST check happens inside `generate-signed-contract` when the customer
// submits the reservation (ID photo + e-signature together). If it fails, the
// contract stays `pending_review`, the customer is notified, and their
// reservation page offers two ways forward:
//   1. Re-upload ID  -> this function. The signature already saved on the
//                       contract is re-read server-side and compared with the
//                       new ID photo. Match -> contract verified.
//   2. Re-sign       -> `generate-signed-contract` with `resign: true`, which
//                       compares the new signature with the customer's ID.
//
// Which ID is used: either a photo sent in the request body (the customer just
// chose a new one — the browser has already saved it to their profile), or,
// with `use_saved_id: true`, the ID saved on their profile (private
// `customer-ids` bucket, read here with the service role from the verified
// caller id). It goes to Gemini once; nothing image-related is logged or copied
// anywhere else. Only the verdict is recorded on the contract.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed.' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.' }, 500);
  }

  // The project's anon key is itself a valid JWT, so the platform's JWT check
  // alone would let anyone with it spend Gemini quota here. Require a real
  // signed-in user.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  }
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body.' }, 400);
  }

  const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id : '';
  const useSavedId = body.use_saved_id === true;
  let id = useSavedId
    ? null
    : parseDataUrl(body.id_image_data_url, ['image/jpeg', 'image/png', 'image/webp'], MAX_ID_BYTES);
  // Back of the ID: optional; a photo sent here wins over the saved one.
  const sentBack = body.id_back_image_data_url !== undefined && body.id_back_image_data_url !== null;
  let idBack = sentBack
    ? parseDataUrl(body.id_back_image_data_url, ['image/jpeg', 'image/png', 'image/webp'], MAX_ID_BYTES)
    : null;
  if (sentBack && !idBack) {
    return jsonResponse({ success: false, error: 'A valid image of the back of your ID is required.' }, 400);
  }
  if (!reservationId || (!useSavedId && !id)) {
    return jsonResponse(
      { success: false, error: 'A reservation and a valid ID image are required.' },
      400,
    );
  }

  try {
    if (useSavedId) {
      id = await loadSavedIdForUser(supabase, userId);
      if (!id) {
        return jsonResponse(
          {
            success: false,
            code: 'no_saved_id',
            error: 'We couldn\u2019t find a valid ID saved on your profile. Please choose a photo of your ID.',
          },
          409,
        );
      }
    }

    if (!idBack) {
      try {
        idBack = await loadSavedIdBackForUser(supabase, userId);
      } catch (loadError) {
        console.error('saved id back load failed', { error: String((loadError as Error).message) });
      }
    }

    const { data: reservation } = await supabase
      .from('reservations')
      .select('reservation_id, reservation_number, user_id')
      .eq('reservation_id', reservationId)
      .maybeSingle();

    // Same answer for "not yours" and "doesn't exist".
    if (!reservation || reservation.user_id !== userId) {
      return jsonResponse({ success: false, error: 'Reservation not found.' }, 404);
    }

    const { data: contract } = await supabase
      .from('reservation_contracts')
      .select('review_status, id_check_status, id_check_attempts')
      .eq('reservation_id', reservationId)
      .maybeSingle();

    if (!contract) {
      return jsonResponse({ success: false, error: 'No contract found for this reservation.' }, 404);
    }
    if (contract.review_status !== 'pending_review') {
      return jsonResponse({ success: false, error: 'This contract has already been reviewed.' }, 409);
    }
    const retryable = CUSTOMER_RETRY_STATES;
    if (!contract.id_check_status || !retryable.includes(contract.id_check_status)) {
      return jsonResponse({ success: false, error: 'This contract doesn\u2019t need another ID check.' }, 409);
    }
    if (Number(contract.id_check_attempts ?? 0) >= MAX_ID_CHECK_ATTEMPTS) {
      return jsonResponse(
        {
          success: false,
          error: 'You\u2019ve used all automatic checks. Our team will review your contract by hand.',
          attempts_left: 0,
        },
        429,
      );
    }

    const { data: signatureRow } = await supabase
      .from('contract_signatures')
      .select('signature_image_url')
      .eq('reservation_id', reservationId)
      .eq('signer_role', 'customer')
      .order('signed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const sig = signatureRow?.signature_image_url
      ? await fetchStoredSignature(signatureRow.signature_image_url)
      : null;
    if (!sig) {
      throw new Error('Could not load the signature saved on the contract.');
    }

    console.log('verify-id-signature started', { user_id: userId, reservation_id: reservationId });

    const verdict = await decideIdOutcome(supabase, userId, id!, idBack, sig);
    const result = await applyIdCheckResult(supabase, {
      reservationId,
      reservationNumber: reservation.reservation_number,
      userId,
      verdict,
      notify: false, // the customer is on the page and sees the result there
    });

    console.log('verify-id-signature done', { user_id: userId, verdict, attempts: result.attempts });
    return jsonResponse({
      success: true,
      verdict,
      verified: result.verified,
      attempts_left: result.attemptsLeft,
    });
  } catch (error) {
    // Service-side failure (timeout, quota, malformed output). Deliberately NOT
    // a verdict and NOT counted as an attempt: the browser shows a "couldn't
    // check, try again" message instead of a mismatch.
    console.error('verify-id-signature failed', { error: String((error as Error).message) });
    return jsonResponse({ success: false, error: 'We could not check your ID right now. Please try again.' }, 502);
  }
});
