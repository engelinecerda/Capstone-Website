//admin_auth.js

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

const PORTAL_ROLES = ['manager', 'admin', 'staff'];

// A password-only (aal1) session is not a finished login for an account that
// has 2FA enrolled: Supabase reports nextLevel 'aal2' until the TOTP code has
// been verified. Without this check, anyone holding only the password could
// open a protected page directly (the login page's 2FA screen is not a gate
// by itself). Accounts with no verified factor report nextLevel 'aal1' and are
// let through exactly as before. The assurance level is read from the local
// session, so this is not a network call. If it cannot be read, the session is
// not trusted. Login pages pass skipMfaCheck so their password step can still
// reach the 2FA step. Deliberately not exported (see js/session_validation.js,
// which carries its own copy) so a stale cached copy of one file can never
// break another file's imports.
async function rejectIfMfaIncomplete(supabase) {
  let incomplete = true;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!error && data) {
      incomplete = data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
    }
  } catch (_) {
    incomplete = true;
  }

  if (!incomplete) return null;

  try {
    await supabase.auth.signOut();
  } catch (_) {
    // the caller still treats the session as invalid either way
  }
  localStorage.removeItem('profile');
  return { session: null, message: 'Two-factor verification is required. Please sign in again.' };
}

export function formatPortalRoleLabel(role, fallback = 'User') {
  const normalized = normalizeRole(role);
  return normalized
    ? normalized
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ')
    : fallback;
}

export function getPortalDisplayName(profile, fallback = 'User') {
  const parts = [
    profile?.first_name,
    profile?.middle_name,
    profile?.last_name
  ].filter(Boolean);

  return parts.join(' ') || profile?.email || fallback;
}

export function getPortalInitials(profile, fallback = 'P') {
  const parts = [profile?.first_name, profile?.last_name].filter(Boolean);
  const initials = parts
    .map((value) => value.trim().charAt(0).toUpperCase())
    .join('');

  return initials || String(profile?.email || fallback).charAt(0).toUpperCase();
}

export function populatePortalIdentity({
  profile,
  session,
  nameEl,
  emailEl,
  roleEl,
  avatarEl,
  fallbackLabel = 'User'
}) {
  const displayName = getPortalDisplayName(profile, fallbackLabel);
  const email = profile?.email || session?.user?.email || 'No email on file';
  const roleLabel = formatPortalRoleLabel(profile?.role, fallbackLabel);

  if (nameEl) nameEl.textContent = displayName;
  if (emailEl) emailEl.textContent = email;
  if (roleEl) roleEl.textContent = roleLabel;
  if (avatarEl) avatarEl.textContent = getPortalInitials(profile);

  return { displayName, email, roleLabel };
}

export async function verifyPortalSession(supabase, options = {}) {
  const requiredRole = normalizeRole(options.requiredRole || '');
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    return { session: null, message: 'Unable to verify the current session right now.' };
  }

  const session = data.session;
  if (!session) {
    return { session: null, message: 'This account is not allowed to sign in here right now.' };
  }

  if (!options.skipMfaCheck) {
    const mfaRejection = await rejectIfMfaIncomplete(supabase);
    if (mfaRejection) return mfaRejection;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, staff_role, first_name, middle_name, last_name, email, phone_number, date_registered')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (profileError) {
    return { session: null, message: `Unable to verify account privileges: ${profileError.message}` };
  }

  const actualRole = normalizeRole(profile?.role);
  if (!actualRole) {
    return { session: null, message: 'This account signed in successfully, but no role was found for it in Supabase yet.' };
  }

  if (requiredRole && actualRole !== requiredRole) {
    return {
      session: null,
      message: `This account signed in successfully, but its profile role is \`${actualRole}\`, not \`${requiredRole}\`.`
    };
  }

  if (!requiredRole && !PORTAL_ROLES.includes(actualRole)) {
    return { session: null, message: 'This account is not allowed to sign in here right now.' };
  }

  return { session, profile };
}

export async function verifyAdminSession(supabase, options = {}) {
  return verifyPortalSession(supabase, { ...options, requiredRole: 'manager' });
}

export async function verifySuperAdminSession(supabase, options = {}) {
  return verifyPortalSession(supabase, { ...options, requiredRole: 'admin' });
}

// ADDED: accepts an array of allowed roles instead of one exact role
// Used by pages shared between admin and super_admin
export async function verifyMultiRoleSession(supabase, allowedRoles = []) {
  const { data, error } = await supabase.auth.getSession();

  if (error) {
    return { session: null, message: 'Unable to verify the current session right now.' };
  }

  const session = data.session;
  if (!session) {
    return { session: null, message: 'No active session found.' };
  }

  const mfaRejection = await rejectIfMfaIncomplete(supabase);
  if (mfaRejection) return mfaRejection;

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, staff_role, first_name, middle_name, last_name, email, phone_number, date_registered')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (profileError) {
    return { session: null, message: `Unable to verify account privileges: ${profileError.message}` };
  }

  const actualRole = normalizeRole(profile?.role);
  const normalized = allowedRoles.map(r => normalizeRole(r));

  if (!actualRole || !normalized.includes(actualRole)) {
    return {
      session: null,
      message: actualRole
        ? `This account has role \`${actualRole}\`, which is not permitted here.`
        : 'No role was found for this account.'
    };
  }

  return { session, profile };
}