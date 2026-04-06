function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

export function formatPortalRoleLabel(role, fallback = 'Portal User') {
  const normalized = normalizeRole(role);
  return normalized
    ? normalized
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ')
    : fallback;
}

export function getPortalDisplayName(profile, fallback = 'Portal User') {
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

export function populatePortalIdentity({ profile, session, nameEl, emailEl, roleEl, fallbackLabel = 'Portal User' }) {
  const displayName = getPortalDisplayName(profile, fallbackLabel);
  const email = profile?.email || session?.user?.email || 'No email on file';
  const roleLabel = formatPortalRoleLabel(profile?.role, fallbackLabel);

  if (nameEl) nameEl.textContent = displayName;
  if (emailEl) emailEl.textContent = email;
  if (roleEl) roleEl.textContent = roleLabel;

  return { displayName, email, roleLabel };
}

export async function verifyPortalSession(supabase, options = {}) {
  const requiredRole = normalizeRole(options.requiredRole || '');
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    return {
      session: null,
      message: 'Unable to verify the current session right now.'
    };
  }

  const session = data.session;
  if (!session) {
    return {
      session: null,
      message: 'This account is not allowed to use the portal right now.'
    };
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role, staff_role, first_name, middle_name, last_name, email, phone_number, date_registered')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (profileError) {
    return {
      session: null,
      message: `Unable to verify portal privileges: ${profileError.message}`
    };
  }

  const actualRole = normalizeRole(profile?.role);
  if (!actualRole) {
    return {
      session: null,
      message: 'This account signed in successfully, but no portal role was found in Supabase yet.'
    };
  }

  if (actualRole !== requiredRole) {
    return {
      session: null,
      message: actualRole
        ? `This account signed in successfully, but its profile role is \`${actualRole}\`, not \`${requiredRole}\`.`
        : `This account signed in successfully, but its profile role is not \`${requiredRole}\` in Supabase yet.`
    };
  }

  return { session, profile };
}

export async function verifyAdminSession(supabase, options = {}) {
  return verifyPortalSession(supabase, {
    ...options,
    requiredRole: 'admin'
  });
}
