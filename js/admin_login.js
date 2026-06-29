//admin_login.js
import { portalSupabase as supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const adminLoginForm = document.getElementById('adminLoginForm');
const loginCard = document.getElementById('loginCard');
const formMsg = document.getElementById('formMsg');
const emailInput = document.getElementById('email');
const roleSelect = document.getElementById('role');

const mfaCard = document.getElementById('mfaCard');
const mfaForm = document.getElementById('mfaForm');
const mfaMsg = document.getElementById('mfaMsg');
const mfaBackBtn = document.getElementById('mfaBackBtn');
const mfaCodeInput = document.getElementById('mfaCode');
const mfaSubmitBtn = document.getElementById('mfaSubmitBtn');

const mfaState = {
    factorId: '',
    challengeId: '',
    redirectTo: ''
};

const PORTAL_ROUTES = {
    manager: '/admin/dashboard.html',
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

function setMfaMessage(message, type = '') {
    if (!mfaMsg) return;
    mfaMsg.textContent = message;
    mfaMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

function showMfaCard() {
    if (loginCard) loginCard.style.display = 'none';
    if (mfaCard) mfaCard.style.display = '';
    if (mfaCodeInput) { mfaCodeInput.value = ''; mfaCodeInput.focus(); }
    setMfaMessage('');
}

function hideMfaCard() {
    if (mfaCard) mfaCard.style.display = 'none';
    if (loginCard) loginCard.style.display = '';
    if (mfaCodeInput) mfaCodeInput.value = '';
    setMfaMessage('');
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
        setMessage('This portal currently supports Manager, Admin, and Staff roles only.', 'error');
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

    if (lockError) {
        // is_locked column may not exist yet — role check below is the security gate
    } else if (!profileCheck) {
        await supabase.auth.signOut();
        setMessage('No account profile found. Contact the administrator to set up your account.', 'error');
        return;
    } else if (profileCheck.is_locked === true) {
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

    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
        const { data: factorsData } = await supabase.auth.mfa.listFactors();
        const totpFactor = factorsData?.totp?.[0];
        if (totpFactor) {
            const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
            if (challengeError) {
                await supabase.auth.signOut();
                setMessage('Could not start MFA challenge. Please try again.', 'error');
                return;
            }
            mfaState.factorId = totpFactor.id;
            mfaState.challengeId = challengeData.id;
            mfaState.redirectTo = getPortalRoute(profile?.role) || targetRoute;
            showMfaCard();
            return;
        }
    }

    localStorage.removeItem('profile');
    setMessage('Login successful. Redirecting...');
    window.location.replace(getPortalRoute(profile?.role) || targetRoute);
});

mfaForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = (mfaCodeInput?.value || '').replace(/\s/g, '');
    if (!code || code.length !== 6) {
        setMfaMessage('Enter your 6-digit authentication code.', 'error');
        return;
    }

    setMfaMessage('Verifying code...');
    if (mfaSubmitBtn) mfaSubmitBtn.disabled = true;

    const { error } = await supabase.auth.mfa.verify({
        factorId: mfaState.factorId,
        challengeId: mfaState.challengeId,
        code
    });

    if (mfaSubmitBtn) mfaSubmitBtn.disabled = false;

    if (error) {
        const msg = error.message?.toLowerCase() || '';
        if (msg.includes('expired')) {
            setMfaMessage('Session expired. Please go back and sign in again.', 'error');
        } else {
            setMfaMessage('Invalid code. Check your authenticator app and try again.', 'error');
        }
        return;
    }

    localStorage.removeItem('profile');
    window.location.replace(mfaState.redirectTo);
});

mfaBackBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    hideMfaCard();
    setMessage('');
});

redirectIfPortalSessionExists();
