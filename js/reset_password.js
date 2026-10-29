import { customerSupabase as supabase } from './supabase.js';
import { initPasswordToggles } from './password_toggle.js';
import { validatePassword } from './password_rules.js';

initPasswordToggles();

const form = document.getElementById('reset-password-form');
const message = document.getElementById('reset-password-msg');

let recoveryReady = false;

function setMessage(type, text) {
    message.className = `form-msg ${type}`;
    message.innerText = text;
}

const {
    data: { subscription }
} = supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        recoveryReady = true;
        setMessage('', '');
    }
});

const {
    data: { session }
} = await supabase.auth.getSession();

if (session) {
    recoveryReady = true;
}

if (!recoveryReady) {
    setMessage('error', 'Open this page using the reset link sent to your email.');
}

form?.addEventListener('submit', async function (e) {
    e.preventDefault();

    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-new-password').value;
    const submitBtn = form.querySelector('button[type="submit"]');

    setMessage('', '');

    if (!recoveryReady) {
        setMessage('error', 'This reset link is invalid or has expired.');
        return;
    }

    if (newPassword !== confirmPassword) {
        setMessage('error', 'Passwords do not match.');
        return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
        setMessage('error', passwordError);
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Updating...';

    const { error } = await supabase.auth.updateUser({
        password: newPassword
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Update Password';

    if (error) {
        setMessage('error', 'Failed to update password: ' + error.message);
        return;
    }

    form.reset();
    subscription.unsubscribe();

    // The recovery session exists only so this password could be set. End it
    // now (this browser only, other devices stay signed in) so the customer
    // has to log in with the new password. js/supabase.js clears its recovery
    // flag on the resulting SIGNED_OUT; if the sign-out call fails the flag
    // stays set, and the next customer page discards the session instead.
    await supabase.auth.signOut({ scope: 'local' });

    setMessage('success', 'Password updated successfully. Redirecting to login...');
    setTimeout(() => window.location.replace('/login'), 1500);
});
