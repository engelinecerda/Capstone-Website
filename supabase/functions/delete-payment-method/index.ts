import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLOUDINARY_CLOUD_NAME = Deno.env.get('CLOUDINARY_CLOUD_NAME') ?? 'dgneg418t';
const CLOUDINARY_API_KEY = Deno.env.get('CLOUDINARY_API_KEY') ?? '';
const CLOUDINARY_API_SECRET = Deno.env.get('CLOUDINARY_API_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

/**
 * Reconstructs a Cloudinary public_id from a secure_url when no public_id
 * was stored separately (payment_method only stores qr_image, the URL).
 * e.g. https://res.cloudinary.com/dgneg418t/image/upload/v170.../payment-methods/123_foo.png
 *   -> payment-methods/123_foo
 */
function extractPublicId(secureUrl: string): string | null {
  const match = secureUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match ? match[1] : null;
}

async function signParams(params: Record<string, string>): Promise<string> {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  const encoder = new TextEncoder();
  const data = encoder.encode(toSign + CLOUDINARY_API_SECRET);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function destroyCloudinaryAsset(qrImage: string): Promise<{ ok: boolean; reason?: string }> {
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return { ok: false, reason: 'Cloudinary API credentials are not configured on the server.' };
  }

  const publicId = extractPublicId(qrImage);
  if (!publicId) {
    return { ok: false, reason: 'Could not determine the Cloudinary public_id from the stored QR image URL.' };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signParams({ public_id: publicId, timestamp });

  const form = new FormData();
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`, {
    method: 'POST',
    body: form,
  });

  const result = await res.json().catch(() => ({}));
  if (!res.ok || (result.result !== 'ok' && result.result !== 'not found')) {
    return { ok: false, reason: result?.error?.message || `Cloudinary destroy failed (${res.status}).` };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.' }, 500);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonResponse({ error: 'Missing authorization token' }, 401);
  }

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ error: 'Unable to verify the calling account' }, 401);
  }

  const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('user_id', callerData.user.id)
    .maybeSingle();

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return jsonResponse({ error: 'This action requires the Admin role' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const paymentMethodId = String(body.payment_method_id || '').trim();
  if (!paymentMethodId) {
    return jsonResponse({ error: 'payment_method_id is required' }, 400);
  }

  const { data: method, error: methodError } = await supabaseAdmin
    .from('payment_method')
    .select('payment_method_id, label, qr_image')
    .eq('payment_method_id', paymentMethodId)
    .maybeSingle();

  if (methodError || !method) {
    return jsonResponse({ error: 'Payment method not found' }, 404);
  }

  // Defense in depth — the RLS delete policy already blocks this, but a
  // clean error here is friendlier than a raw Postgres RLS violation.
  const { count, error: countError } = await supabaseAdmin
    .from('payment')
    .select('payment_id', { count: 'exact', head: true })
    .eq('payment_method_id', paymentMethodId);

  if (countError) {
    return jsonResponse({ error: `Failed to check payment references: ${countError.message}` }, 500);
  }
  if ((count ?? 0) > 0) {
    return jsonResponse({
      error: `${count} payment${count === 1 ? '' : 's'} used this method. Archive it instead.`,
      referenceCount: count,
    }, 409);
  }

  if (method.qr_image) {
    const destroyResult = await destroyCloudinaryAsset(method.qr_image);
    if (!destroyResult.ok) {
      console.warn('delete-payment-method: Cloudinary destroy failed', { paymentMethodId, reason: destroyResult.reason });
      // Don't block the DB delete on a Cloudinary hiccup — an orphaned
      // Cloudinary asset is a much smaller problem than an admin being
      // unable to remove a duplicate/test method at all.
    }
  }

  const { error: deleteError } = await supabaseAdmin
    .from('payment_method')
    .delete()
    .eq('payment_method_id', paymentMethodId);

  if (deleteError) {
    return jsonResponse({ error: deleteError.message }, 500);
  }

  return jsonResponse({ deleted: true, payment_method_id: paymentMethodId, label: method.label });
});
