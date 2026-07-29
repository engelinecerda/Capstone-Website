import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ALLOWED_ROLES = ['manager'];

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
    return jsonResponse({ detail: 'Role must be manager' }, 400);
  }

  const tempPassword = crypto.randomUUID();

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });

  if (createError || !created?.user) {
    return jsonResponse({ detail: createError?.message || 'Failed to create account' }, 400);
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({
      role,
      staff_role: staffRole,
      first_name: firstName,
      last_name: lastName,
    })
    .eq('user_id', created.user.id);

  if (profileError) {
    return jsonResponse({ detail: `Account created but profile update failed: ${profileError.message}` }, 500);
  }

  const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(email);

  return jsonResponse({
    user_id: created.user.id,
    email,
    role,
    password_reset_sent: !resetError,
  }, 201);
});
