import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

function generatePassword() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
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
    .select('role, first_name, last_name')
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

  const boardUserId = String(body.user_id || '').trim();
  if (!boardUserId) {
    return jsonResponse({ detail: 'user_id is required' }, 400);
  }

  const { data: boardProfile, error: boardProfileError } = await supabaseAdmin
    .from('profiles')
    .select('user_id, is_board_account')
    .eq('user_id', boardUserId)
    .maybeSingle();

  if (boardProfileError || !boardProfile?.is_board_account) {
    return jsonResponse({ detail: 'This endpoint only resets the shared board account password' }, 404);
  }

  const newPassword = generatePassword();

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(boardUserId, {
    password: newPassword,
  });

  if (updateError) {
    return jsonResponse({ detail: updateError.message || 'Failed to reset password' }, 400);
  }

  const performedBy = [callerProfile?.first_name, callerProfile?.last_name].filter(Boolean).join(' ') || callerData.user.email || 'an admin';
  await supabaseAdmin.rpc('notify_admins', {
    p_type: 'admin_board_password_reset',
    p_title: 'Board account password reset',
    p_body: `The shared Operations Board account password was reset by ${performedBy}.`,
    p_link: '/admin/super%20admin/super_admin_accounts.html',
  });

  // Best-effort only: Supabase access tokens are short-lived JWTs that remain
  // valid until they expire (typically ~1hr), so an already-open kiosk
  // session won't drop instantly. A follow-up SECURITY DEFINER function that
  // deletes auth.sessions rows for this user would make this immediate; not
  // done in this pass.

  return jsonResponse({ user_id: boardUserId, password: newPassword }, 200);
});
