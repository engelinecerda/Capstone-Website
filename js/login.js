import { customerSupabase as supabase } from './supabase.js';

const form = document.getElementById('login-form');
const btn  = document.getElementById('login-btn');
const msg  = document.getElementById('login-message');

function setMessage(text, type = '') {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'form-msg' + (type ? ' ' + type : '');
}

function setLoading(loading) {
    btn.disabled = loading;
    btn.textContent = loading ? 'Logging in…' : 'Login';
}

form.addEventListener('submit', async function (e) {
    e.preventDefault();
    setMessage('');

    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        setMessage('Please fill in all fields.', 'error');
        return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);

    if (error) {
        const normalized = error.message.toLowerCase();

        if (normalized.includes('email not confirmed')) {
            setMessage('Please confirm your email first. Check your inbox for the confirmation link.', 'error');
            return;
        }
        if (normalized.includes('invalid login credentials') || normalized.includes('invalid credentials')) {
            setMessage('Incorrect email or password. Please try again.', 'error');
            return;
        }
        setMessage(error.message, 'error');
        return;
    }

    // Redirect to homepage on success
    window.location.href = '/';
});
