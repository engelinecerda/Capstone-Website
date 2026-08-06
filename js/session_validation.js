
//session_validation.js
//
// ─── ROLE VALUES ─────────────────────────────────────────────────────────────
//   DB / code value      UI label shown to user
//   ──────────────────   ───────────────────────
//   role = 'manager'  →  "Manager"  (operational: reservations, reviews, customers)
//   role = 'admin'    →  "Admin"    (system: accounts, settings, backup, audit)
// ──────────────────────────────────────────────────────────────────────────
import { portalSupabase as supabase } from './supabase.js';
import { populatePortalIdentity, verifyMultiRoleSession } from './admin_auth.js';

const ALLOWED_ROLES = ['manager', 'admin'];

// ─── Role visibility ──────────────────────────────────────────────────────────
// Reads .super-admin-only elements and shows/hides them based on role.
// Also updates any sidebar title, badge, and role pill if present.
export function applyRoleVisibility(role) {
  const isSuperAdmin = role === 'admin'; // true → Admin role

   document.body.classList.remove('is-super-admin');
  if (isSuperAdmin) {
    document.body.classList.add('is-super-admin');
  }


  // Empty string reverts to the element's own CSS-defined display (block for
  // cards, flex for .nav-item via its class rule) instead of forcing one
  // display value onto every element the class is used on.
  document.querySelectorAll('.super-admin-only').forEach(el => {
    el.style.display = isSuperAdmin ? '' : 'none';
  });

  document.querySelectorAll('.manager-only').forEach(el => {
    el.style.display = isSuperAdmin ? 'none' : '';
  });

  const pill = document.getElementById('sidebarRolePill');
  const badge = document.getElementById('adminBadge');
  const title = document.getElementById('sidebarTitle');

  if (pill) pill.textContent = isSuperAdmin ? 'Administrator' : 'Manager';
  if (badge) badge.textContent = isSuperAdmin ? 'Admin' : 'Manager';
  if (title) title.textContent = isSuperAdmin ? 'Admin Panel' : 'Manager Panel';

  // Set data-role for CSS targeting
  if (pill) pill.dataset.role = role;
}

// ─── Session validation ───────────────────────────────────────────────────────
// Call this at the top of every manager/admin page.
// Returns { session, profile } on success, null on failure (and redirects).
export async function validateAdminSession({
  redirectTo = '/admin/index.html',
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

  // Always re-fetch the live row — a cached copy goes stale the moment a
  // role changes (promotion/demotion) and was previously trusted forever,
  // which let a stale role get silently resubmitted on unrelated saves
  // (see js/admin_profile.js) and could misfire the last-admin guard.
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

  const profile = fetchedProfile;
  localStorage.setItem('profile', JSON.stringify(profile));

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
export function watchAuthState(redirectTo = '/admin/index.html') {
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
  redirectTo = '/admin/index.html'
) {
  const btn = document.getElementById(buttonId);

  btn?.addEventListener('click', async () => {
    await supabase.auth.signOut();

    //  CLEAR CACHE
    localStorage.removeItem('profile');

    window.location.replace(redirectTo);
  });
}