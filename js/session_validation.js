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
  redirectTo = '/admin',
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
//
// Some flows (e.g. inactivity timeout) need a different destination than
// this page's default without racing this listener's own navigation —
// e.g. supabase.auth.signOut() fires the SIGNED_OUT event almost
// immediately, so if the caller also runs its own window.location right
// after signOut() resolves, the browser gets two competing redirects
// back-to-back (one to redirectTo, one to the caller's own target),
// which shows up as a slow/janky "double redirect". Setting
// window.__nextSignOutRedirect right before calling signOut() lets a
// caller override the destination for that one sign-out, so only this
// single navigation call ever fires.
export function watchAuthState(redirectTo = '/admin') {
  supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    localStorage.removeItem('profile'); //  clear cache
    const override = window.__nextSignOutRedirect;
    window.__nextSignOutRedirect = null;
    window.location.replace(override || redirectTo);
  }
});
}

// ─── Logout helper ────────────────────────────────────────────────────────────
// Wire this to your logout button.
export function wireLogoutButton(
  buttonId = 'logoutBtn',
  redirectTo = '/admin'
) {
  const btn = document.getElementById(buttonId);

  btn?.addEventListener('click', async () => {
    // Already signing out (also blocked by `disabled`, this is belt-and-braces).
    if (btn.classList.contains('is-loading')) return;

    setLogoutBusy(btn, true);

    try {
      await supabase.auth.signOut();

      //  CLEAR CACHE
      localStorage.removeItem('profile');

      // The spinner stays up until the browser actually leaves the page.
      window.location.replace(redirectTo);
    } catch (err) {
      console.error('Logout failed:', err);
      setLogoutBusy(btn, false);
    }
  });
}

// Shows / clears the "logging out…" state on a sidebar logout button: swaps the
// icon for a spinner (see .sidebar-logout-btn.is-loading in admin_sidebar.css),
// disables the button so it can't be double-clicked, and updates its accessible
// label. signOut() plus the redirect can take a moment on a slow connection, and
// before this the button gave no sign that the click had registered.
export function setLogoutBusy(btn, busy) {
  if (!btn) return;

  if (busy) {
    btn.dataset.idleLabel = btn.getAttribute('aria-label') || 'Logout';
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-label', 'Logging out…');
    btn.title = 'Logging out…';

    // Coming back to this page via the browser's back/forward cache would
    // otherwise restore it frozen mid-logout with the spinner still showing.
    if (!btn.dataset.logoutPageshowBound) {
      btn.dataset.logoutPageshowBound = '1';
      window.addEventListener('pageshow', (event) => {
        if (event.persisted) setLogoutBusy(btn, false);
      });
    }
    return;
  }

  const idleLabel = btn.dataset.idleLabel || 'Logout';
  btn.classList.remove('is-loading');
  btn.disabled = false;
  btn.removeAttribute('aria-busy');
  btn.setAttribute('aria-label', idleLabel);
  btn.title = idleLabel;
}