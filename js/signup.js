import { customerSupabase as supabase } from './supabase.js';
import { initPasswordToggles } from './password_toggle.js';
import { validatePassword } from './password_rules.js';

initPasswordToggles();

const form = document.getElementById('signup-form');
const btn  = document.getElementById('signup-btn');
const msg  = document.getElementById('signup-message');

function setMessage(text, type = '') {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'form-msg' + (type ? ' ' + type : '');
}

function setLoading(loading) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Creating account…' : 'Create Account';
}

// Carries a same-site ?redirect=... target (e.g. from the guest booking
// gate on /reservations) forward to /login, so it survives the "confirm
// your email, then log in" detour and the customer still lands back where
// they started once they actually sign in.
function getLoginRedirectSuffix() {
    const raw = new URLSearchParams(window.location.search).get('redirect');
    if (raw && raw.startsWith('/') && !raw.startsWith('//')) {
        return '?redirect=' + encodeURIComponent(raw);
    }
    return '';
}

form.addEventListener('submit', async function (e) {
    e.preventDefault();
    setMessage('');

    const firstName  = document.getElementById('first-name').value.trim();
    const middleName = document.getElementById('middle-name').value.trim();
    const lastName   = document.getElementById('last-name').value.trim();
    const email      = document.getElementById('signup-email').value.trim();
    const password   = document.getElementById('signup-password').value;
    const confirm    = document.getElementById('confirm-password').value;
    const terms      = document.getElementById('terms').checked;

    // Client-side validation
    if (!firstName || !lastName) {
        setMessage('Please enter your first and last name.', 'error');
        return;
    }

    if (!email) {
        setMessage('Please enter your email address.', 'error');
        return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
        setMessage(passwordError, 'error');
        return;
    }

    if (password !== confirm) {
        setMessage('Passwords do not match. Please try again.', 'error');
        return;
    }

    if (!terms) {
        setMessage('Please accept the Terms & Conditions to continue.', 'error');
        return;
    }

    setLoading(true);

    const emailRedirectTo = new URL('/email-verified', window.location.href).href;

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            emailRedirectTo,
            data: {
                first_name:  firstName,
                middle_name: middleName || null,
                last_name:   lastName,
                role:        'customer'
            }
        }
    });

    setLoading(false);

    if (error) {
        const normalized = error.message.toLowerCase();
        if (
            normalized.includes('already registered') ||
            normalized.includes('already been registered') ||
            normalized.includes('already in use') ||
            normalized.includes('user already registered')
        ) {
            setMessage('This email is already registered. Please log in or reset your password.', 'error');
            return;
        }
        setMessage(error.message, 'error');
        return;
    }

    // Supabase returns identities: [] for duplicate emails when confirmations are enabled
    const isDuplicate =
        data?.user &&
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0;

    if (isDuplicate) {
        setMessage('This email is already registered. Please log in or reset your password.', 'error');
        return;
    }

    // Success — show message then redirect
    setMessage('Account created! Please check your email and click the confirmation link before logging in.', 'success');
    form.reset();

    setTimeout(() => {
        window.location.href = '/login' + getLoginRedirectSuffix();
    }, 3000);
});