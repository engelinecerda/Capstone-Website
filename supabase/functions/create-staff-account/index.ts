import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ALLOWED_ROLES = ['admin', 'manager', 'staff'];
// Send Supabase's real invite email (type=invite) instead of piggybacking
// on the password-recovery flow. Two reasons this matters:
//  1. The email itself now reads as a welcome/invite, not "reset your
//     password" for an account the recipient never had a password on.
//  2. js/supabase.js's redirect guard tells invite links (type=invite)
//     apart from genuine reset links (type=recovery) and can route each to
//     its own page — set-password.html for first-time activation,
//     reset-password.html for actual resets — rather than overloading one
//     page (and one set of rules, like the staff shared-password block)
//     for both cases.
// Must match an entry on Supabase Auth → URL Configuration → Redirect URLs
// exactly (protocol + www/non-www + path), or GoTrue silently falls back
// to the Site URL and this redirectTo is ignored.
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
  const role = String(body.role || '').trim().toLowerCase();
  const staffRole = body.staff_role ? String(body.staff_role).trim() : null;
  const firstName = body.first_name ? String(body.first_name).trim() : null;
  const lastName = body.last_name ? String(body.last_name).trim() : null;

  if (!email) {
    return jsonResponse({ detail: 'Email is required' }, 400);
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return jsonResponse({ detail: 'Role must be admin, manager, or staff' }, 400);
  }

  const middleName = body.middle_name ? String(body.middle_name).trim() : null;

  // inviteUserByEmail both creates the auth user AND sends the invite email
  // in one call — no more generating a throwaway temp password just to
  // satisfy createUser(). The `data` object becomes raw_user_meta_data,
  // which the existing handle_new_user() trigger (20260401_create_profiles.sql)
  // already reads first_name/middle_name/last_name/role from, so the
  // profiles row is correct the moment the trigger fires.
  const { data: invited, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: INVITE_REDIRECT_TO,
    data: {
      role,
      first_name: firstName,
      middle_name: middleName,
      last_name: lastName,
    },
  });

  if (inviteError || !invited?.user) {
    return jsonResponse({ detail: inviteError?.message || 'Failed to invite account' }, 400);
  }

  // staff_role isn't part of handle_new_user()'s insert column list, so it
  // still needs an explicit follow-up write. protect_privileged_profile_fields()
  // (20260812_protect_privileged_profile_fields.sql) lets this through since
  // it runs under the service-role key, not an authenticated admin session.
  if (staffRole) {
    const { error: staffRoleError } = await supabaseAdmin
      .from('profiles')
      .update({ staff_role: staffRole })
      .eq('user_id', invited.user.id);

    if (staffRoleError) {
      return jsonResponse({ detail: `Account invited but staff role update failed: ${staffRoleError.message}` }, 500);
    }
  }

  return jsonResponse({
    user_id: invited.user.id,
    email,
    role,
    invited: true,
  }, 201);
});