import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// The very first admin account — the only account allowed to hard-delete
// Manager or Staff accounts. Every other admin can still manage accounts
// (edit, deactivate/reactivate, reset passwords, clear lockouts) but not
// remove them. Admin accounts can never be removed by anyone, including
// this one. This is the real enforcement point; the matching check in
// js/super_admin_accounts.js only hides the "Remove" menu item and must
// not be relied on by itself.
const SUPER_ADMIN_EMAIL = 'adminelicoffee@gmail.com';

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
    .select('role, email')
    .eq('user_id', callerData.user.id)
    .maybeSingle();

  if (callerProfileError || callerProfile?.role !== 'admin') {
    return jsonResponse({ error: 'This action requires the Admin role' }, 403);
  }

  // Only the first admin account can remove accounts — this keeps any
  // other admin from removing another admin (or anyone else). Checked by
  // email rather than a flag column since that's how the account is
  // identified elsewhere in this project.
  if ((callerProfile.email || '').trim().toLowerCase() !== SUPER_ADMIN_EMAIL) {
    return jsonResponse({ error: 'Only the primary admin account can remove accounts.' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const userId = String(body.user_id || '').trim();
  if (!userId) {
    return jsonResponse({ error: 'user_id is required' }, 400);
  }

  const { data: target, error: targetError } = await supabaseAdmin
    .from('profiles')
    .select('user_id, role, first_name, last_name, email')
    .eq('user_id', userId)
    .maybeSingle();

  if (targetError || !target) {
    return jsonResponse({ error: 'Account not found' }, 404);
  }

  const targetName = [target.first_name, target.last_name].filter(Boolean).join(' ') || target.email || 'This account';

  // Admin accounts can never be removed — not even by the first admin.
  // Only Manager and Staff accounts are eligible for removal.
  if (target.role === 'admin') {
    return jsonResponse({ error: 'Admin accounts cannot be removed.' }, 403);
  }

  // Reference check: only hard-delete an account nothing else points to.
  // Mirrors delete-payment-method's exact reference-count-then-delete
  // pattern. A referenced account is deactivated instead (is_locked = true),
  // never silently orphaning blackout dates, staff assignments, contract
  // templates, or badge attributions.
  const refChecks: Array<{ label: string; query: Promise<{ count: number | null; error: unknown }> }> = [
    { label: 'blackout date(s)', query: supabaseAdmin.from('calendar_blackouts').select('*', { count: 'exact', head: true }).eq('created_by', userId) },
    { label: 'staff assignment(s)', query: supabaseAdmin.from('reservation_staff_assignments').select('*', { count: 'exact', head: true }).or(`staff_user_id.eq.${userId},assigned_by.eq.${userId}`) },
    { label: 'contract template(s)', query: supabaseAdmin.from('contract_templates').select('template_id', { count: 'exact', head: true }).eq('created_by', userId) },
    { label: 'badge assignment(s)', query: supabaseAdmin.from('package_badge').select('package_badge_id', { count: 'exact', head: true }).eq('assigned_by', userId) },
  ];

  const refResults = await Promise.all(refChecks.map(async (c) => {
    const { count, error } = await c.query;
    return { label: c.label, count: error ? 0 : (count ?? 0) };
  }));

  const referenced = refResults.filter((r) => r.count > 0);
  if (referenced.length) {
    const summary = referenced.map((r) => `${r.count} ${r.label}`).join(', ');
    return jsonResponse({
      error: `${targetName} is tied to ${summary}. Deactivate instead — the account is hidden and can't sign in, but its history stays intact.`,
      referenced: referenced.map((r) => ({ type: r.label, count: r.count })),
    }, 409);
  }

  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return jsonResponse({ error: deleteError.message }, 500);
  }

  return jsonResponse({ deleted: true, user_id: userId, name: targetName });
});