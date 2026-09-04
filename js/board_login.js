//board_login.js
import { boardSupabase as supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const BOARD_ROUTE = '/board';
const WRONG_PORTAL_MESSAGE = 'This is the staff login. Managers and admins should sign in at the management portal.';

const adminLoginForm = document.getElementById('adminLoginForm');
const loginCard = document.getElementById('loginCard');
const welcomeHeader = document.getElementById('welcomeHeader');
const formMsg = document.getElementById('formMsg');
const emailInput = document.getElementById('email');

const mfaCard = document.getElementById('mfaCard');
const mfaForm = document.getElementById('mfaForm');
const mfaMsg = document.getElementById('mfaMsg');
const mfaBackBtn = document.getElementById('mfaBackBtn');
const mfaCodeInput = document.getElementById('mfaCode');
const mfaSubmitBtn = document.getElementById('mfaSubmitBtn');

const mfaState = {
    factorId: '',
    challengeId: ''
};

function setMessage(message, type = '') {
    if (!formMsg) return;
    formMsg.textContent = message;
    formMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

function formatLockMessage(lockedUntil) {
    const minutesLeft = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
    return `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`;
}

function setMfaMessage(message, type = '') {
    if (!mfaMsg) return;
    mfaMsg.textContent = message;
    mfaMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

function showMfaCard() {
    if (loginCard) loginCard.style.display = 'none';
    if (welcomeHeader) welcomeHeader.style.display = 'none';
    if (mfaCard) mfaCard.style.display = '';
    if (mfaCodeInput) { mfaCodeInput.value = ''; mfaCodeInput.focus(); }
    setMfaMessage('');
}

function hideMfaCard() {
    if (mfaCard) mfaCard.style.display = 'none';
    if (loginCard) loginCard.style.display = '';
    if (welcomeHeader) welcomeHeader.style.display = '';
    if (mfaCodeInput) mfaCodeInput.value = '';
    setMfaMessage('');
}

async function redirectIfStaffSessionExists() {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return;

    const { session } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
    if (session) {
        window.location.replace(BOARD_ROUTE);
    }
}

adminLoginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = emailInput?.value.trim().toLowerCase() || '';
    const password = document.getElementById('password')?.value || '';

    if (!email || !password) {
        setMessage('Enter your email and password to continue.', 'error');
        return;
    }

    // Pre-check only — avoids a wasted Auth call when already locked. The
    // real enforcement is the Password Verification Attempt hook
    // (server-side, cannot be bypassed by skipping this call), which still
    // rejects the sign-in below even if this check is skipped or stale.
    // The shared staff tablet account has a higher failure threshold (10
    // vs 5) before it locks, since many different people type into it.
    let lockCheck = null;
    try {
        const { data } = await supabase.rpc('check_login_lock', { p_email: email });
        lockCheck = data;
    } catch (_) {
        // best-effort only — the hook still enforces the lock either way
    }
    if (lockCheck?.locked) {
        setMessage(formatLockMessage(lockCheck.locked_until), 'error');
        return;
    }

    setMessage('Verifying credentials...');

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        Promise.resolve(supabase.rpc('record_failed_login', { p_email: email })).catch(() => {});
        const isLockMessage = /too many failed attempts/i.test(error.message || '');
        setMessage(isLockMessage ? error.message : 'Invalid email or password.', 'error');
        return;
    }

    try {
        await supabase.rpc('clear_my_login_failures');
    } catch (_) {
        // best-effort only, never block login on this
    }

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

    const { session } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
    if (!session) {
        await supabase.auth.signOut();
        setMessage(WRONG_PORTAL_MESSAGE, 'error');
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
            showMfaCard();
            return;
        }
    }

    localStorage.removeItem('profile');
    setMessage('Login successful. Redirecting...');
    window.location.replace(BOARD_ROUTE);
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
    window.location.replace(BOARD_ROUTE);
});

mfaBackBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    hideMfaCard();
    setMessage('');
});

redirectIfStaffSessionExists();
