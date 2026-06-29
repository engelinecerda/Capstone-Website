import { customerSupabase as supabase } from './supabase.js';

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

    if (newPassword.length < 8) {
        setMessage('error', 'Password must be at least 8 characters.');
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

    setMessage('success', 'Password updated successfully. You can now log in.');
    form.reset();
    subscription.unsubscribe();
});
