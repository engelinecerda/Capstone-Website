import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Same redirect target as create-staff-account's initial invite — must
// match an entry on Supabase Auth → URL Configuration → Redirect URLs
// exactly (protocol + www/non-www + path).
const SITE_URL = 'https://www.elicoffee-events.cafe';
const INVITE_REDIRECT_TO = `${SITE_URL}/admin/set-password`;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ detail: 'Method not allowed' }, 405);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return jsonResponse({ detail: 'Missing authorization token' }, 401);
  }

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ detail: 'Unable to verify the calling account' }, 401);
  }

  const { data: callerProfile, error: callerProfileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('user_id', callerData.user.id)
    .maybeSingle();

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return jsonResponse({ detail: 'This action requires the Admin role' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ detail: 'Invalid request body' }, 400);
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    return jsonResponse({ detail: 'Email is required' }, 400);
  }

  // inviteUserByEmail on an email that already has an unconfirmed
  // (never-activated) user resends a fresh invite token to the *same*
  // user — it does not create a duplicate account. If the account has
  // already set a password, Supabase rejects this with "already
  // registered", which the frontend surfaces as an error rather than
  // silently sending the wrong email type.
  const { data: invited, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: INVITE_REDIRECT_TO,
  });

  if (inviteError || !invited?.user) {
    return jsonResponse({ detail: inviteError?.message || 'Failed to resend invite' }, 400);
  }

  return jsonResponse({ user_id: invited.user.id, email, invited: true }, 200);
});