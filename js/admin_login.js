import { supabase } from './supabase.js';

const ADMIN_EMAIL = 'elicoffeeadmin@gmail.com';
const adminLoginForm = document.getElementById('adminLoginForm');
const formMsg = document.getElementById('formMsg');
const emailInput = document.getElementById('email');

function setMessage(message, type = '') {
    if (!formMsg) return;
    formMsg.textContent = message;
    formMsg.className = 'form-msg' + (type ? ' ' + type : '');
}

async function redirectIfAdminSessionExists() {
    const { data, error } = await supabase.auth.getSession();

    if (error) {
        setMessage('Unable to verify the current session right now.', 'error');
        return;
    }

    const sessionEmail = data.session?.user?.email?.toLowerCase();
    if (sessionEmail === ADMIN_EMAIL) {
        window.location.replace('./admin_homepage.html');
    }
}

adminLoginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = emailInput?.value.trim().toLowerCase() || '';
    const password = document.getElementById('password')?.value || '';

    if (email !== ADMIN_EMAIL) {
        setMessage('Only the authorized admin email can access this portal.', 'error');
        return;
    }

    setMessage('Verifying credentials...');

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        if (error.message.toLowerCase().includes('email not confirmed')) {
            setMessage('Confirm the admin email first, or manually mark it confirmed in Supabase.', 'error');
            return;
        }

        setMessage('Login failed: ' + error.message, 'error');
        return;
    }

    const signedInEmail = data.user?.email?.toLowerCase();
    if (signedInEmail !== ADMIN_EMAIL) {
        await supabase.auth.signOut();
        setMessage('This account is not allowed to use the admin portal.', 'error');
        return;
    }

    setMessage('Login successful. Redirecting...');
    window.location.replace('./admin_homepage.html');
});

if (emailInput) {
    emailInput.value = ADMIN_EMAIL;
}

redirectIfAdminSessionExists();
