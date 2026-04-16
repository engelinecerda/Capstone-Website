import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyMultiRoleSession } from './admin_auth.js';

const ALLOWED_ROLES = ['admin', 'super_admin'];

// ─── Role visibility ──────────────────────────────────────────────────────────
// Reads .super-admin-only elements and shows/hides them based on role.
// Also updates any sidebar title, badge, and role pill if present.
export function applyRoleVisibility(role) {
  const isSuperAdmin = role === 'super_admin';

  document.querySelectorAll('.super-admin-only').forEach(el => {
    el.style.display = isSuperAdmin ? 'flex' : 'none';
  });

  const pill = document.getElementById('sidebarRolePill');
  const badge = document.getElementById('adminBadge');
  const title = document.getElementById('sidebarTitle');

  if (pill) pill.textContent = isSuperAdmin ? 'Super Admin' : 'Admin';
  if (badge) badge.textContent = isSuperAdmin ? 'Super Admin' : 'Admin';
  if (title) title.textContent = isSuperAdmin ? 'Super Admin Panel' : 'Admin Panel';

  // Set data-role for CSS targeting
  if (pill) pill.dataset.role = role;
}

// ─── Session validation ───────────────────────────────────────────────────────
// Call this at the top of every admin/super_admin page.
// Returns { session, profile } on success, null on failure (and redirects).
export async function validateAdminSession({
  redirectTo = './admin_login.html',
  nameElId = 'sidebarName',
  emailElId = 'sidebarEmail',
  roleElId = 'sidebarRolePill',
  fallbackLabel = 'Admin',
  onSuccess = null
} = {}) {

  const { data } = await supabase.auth.getSession();
  const session = data.session;

  if (!session) {
    window.location.replace(redirectTo);
    return null;
  }

  let profile = null;

  //  CACHE FIRST
  const cached = localStorage.getItem('profile');
  if (cached) {
    profile = JSON.parse(cached);
  } else {
    const { data: fetchedProfile, error } = await supabase
      .from('profiles')
      .select('role, staff_role, first_name, middle_name, last_name, email, phone_number, date_registered')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error || !fetchedProfile || !ALLOWED_ROLES.includes(fetchedProfile.role)) {
      await supabase.auth.signOut();
      localStorage.removeItem('profile');
      window.location.replace(redirectTo);
      return null;
    }

    profile = fetchedProfile;

    //  SAVE CACHE
    localStorage.setItem('profile', JSON.stringify(profile));
  }

  populatePortalIdentity({
    profile,
    session,
    nameEl: document.getElementById(nameElId),
    emailEl: document.getElementById(emailElId),
    roleEl: document.getElementById(roleElId),
    fallbackLabel
  });

  applyRoleVisibility(profile.role);

  if (typeof onSuccess === 'function') {
    onSuccess({ session, profile });
  }

  return { session, profile };
}

// ─── Auth state watcher ───────────────────────────────────────────────────────
// Call once per page. Redirects to login if session is signed out.
export function watchAuthState(redirectTo = './admin_login.html') {
  supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    localStorage.removeItem('profile'); //  clear cache
    window.location.replace(redirectTo);
  }
});
}

// ─── Logout helper ────────────────────────────────────────────────────────────
// Wire this to your logout button.
export function wireLogoutButton(
  buttonId = 'logoutBtn',
  redirectTo = './admin_login.html'
) {
  const btn = document.getElementById(buttonId);

  btn?.addEventListener('click', async () => {
    await supabase.auth.signOut();

    //  CLEAR CACHE
    localStorage.removeItem('profile');

    window.location.replace(redirectTo);
  });
}