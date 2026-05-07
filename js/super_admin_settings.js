// super_admin_settings.js
import { portalSupabase as supabase } from '/js/supabase.js';
import { validateAdminSession, watchAuthState, wireLogoutButton } from '/js/session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';

async function init() {
  const result = await validateAdminSession({ fallbackLabel: 'Super Admin' });
  if (!result) return;

  watchAuthState();
  wireLogoutButton();
  setupInactivityLogout();
  initAdminSidebarBadges(supabase);
}

init();
