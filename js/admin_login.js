//admin_login.js
import { portalSupabase as supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const adminLoginForm = document.getElementById('adminLoginForm');
const formMsg = document.getElementById('formMsg');
const emailInput = document.getElementById('email');
const roleSelect = document.getElementById('role');
const PORTAL_ROUTES = {
    super_admin: '/admin/dashboard.html',
    admin: '/admin/dashboard.html',
    staff: '/admin/staff/index.html'
};

function normalizeRole(value) {
    return String(value || '').trim().toLowerCase();
}

function getPortalRoute(role) {
    return PORTAL_ROUTES[normalizeRole(role)] || '';
}

function setMessage(message, type = '') {
    if (!formMsg) return;
    formMsg.textContent = message;
    formMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

async function redirectIfPortalSessionExists() {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return;

    const { session, profile } = await verifyPortalSession(supabase, {
        requiredRole: normalizeRole(data.session.user?.user_metadata?.role || '')
    });

    if (session) {
        const route = getPortalRoute(profile?.role);
        if (route) {
            window.location.replace(route);
            return;
        }
    }

    const profileLookup = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', data.session.user.id)
        .maybeSingle();

    const route = getPortalRoute(profileLookup.data?.role);
    if (route) {
        window.location.replace(route);
    }
}

adminLoginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const selectedRole = normalizeRole(roleSelect?.value);
    const email = emailInput?.value.trim().toLowerCase() || '';
    const password = document.getElementById('password')?.value || '';
    const targetRoute = getPortalRoute(selectedRole);

    if (!targetRoute) {
        setMessage('This portal currently supports Super Admin, Admin, and Staff roles only.', 'error');
        roleSelect?.focus();
        return;
    }

    if (!email) {
        setMessage('Enter your email before continuing.', 'error');
        return;
    }

    setMessage('Verifying credentials...');

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        if (error.message.toLowerCase().includes('email not confirmed')) {
            setMessage('Confirm this email first, or manually mark it confirmed in Supabase.', 'error');
            return;
        }

        setMessage('Login failed: ' + error.message, 'error');
        return;
    }

    // CHECK STATUS
    const { data: profileCheck, error: lockError } = await supabase
        .from('profiles')
        .select('is_locked')
        .eq('user_id', data.user.id)
        .maybeSingle();

    if (lockError || !profileCheck) {
        await supabase.auth.signOut();
        setMessage('Unable to verify account status.', 'error');
        return;
    }

    if (profileCheck.is_locked === true) {
        await supabase.auth.signOut();
        setMessage('Your account has been locked by the administrator.', 'error');
        return;
    }
    const { session, profile, message } = await verifyPortalSession(supabase, { requiredRole: selectedRole });
    if (!session) {
        await supabase.auth.signOut();
        setMessage(message || 'This account is not allowed to use this portal role.', 'error');
        return;
    }

    setMessage('Login successful. Redirecting...');
    window.location.replace(getPortalRoute(profile?.role) || targetRoute);
});

redirectIfPortalSessionExists();
