import { supabase } from './supabase.js';

// ========================
// Navbar Toggle
// ========================
const menu = document.querySelector('#mobile-menu');
const menuLinks = document.querySelector('.navbar__menu');
menu.addEventListener('click', () => {
    menu.classList.toggle('is-active');
    menuLinks.classList.toggle('active');
});

// ========================
// Tab Switching
// ========================
const loginTab = document.getElementById('login-tab');
const signupTab = document.getElementById('signup-tab');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const signupMessage = document.getElementById('signup-message');

function setSignupMessage(message, type = '') {
    if (!signupMessage) return;
    signupMessage.textContent = message;
    signupMessage.className = 'form-msg' + (type ? ' ' + type : '');
}

function showLoginTab() {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.classList.add('active');
    signupForm.classList.remove('active');
}

function showSignupTab() {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    signupForm.classList.add('active');
    loginForm.classList.remove('active');
    setSignupMessage('');
}

loginTab.addEventListener('click', showLoginTab);
signupTab.addEventListener('click', showSignupTab);

// ========================
// Login Form Submit
// ========================
loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        if (error.message.toLowerCase().includes('email not confirmed')) {
            alert('Please confirm your email first by clicking the link we sent during registration.');
            return;
        }

        alert('Login failed: ' + error.message);
        return;
    }

    console.log('Login success:', data);
    window.location.href = '../index.html';
});

// ========================
// Sign Up Form Submit
// Sends a confirmation link via email
// ========================
signupForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    setSignupMessage('');

    const firstName = document.getElementById('first-name').value.trim();
    const middleName = document.getElementById('middle-name').value.trim();
    const lastName = document.getElementById('last-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('confirm-password').value;

    if (password !== confirm) {
        setSignupMessage('Passwords do not match. Please try again.', 'error');
        return;
    }

    if (password.length < 8) {
        setSignupMessage('Password must be at least 8 characters long.', 'error');
        return;
    }

    const submitBtn = signupForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';

    const emailRedirectTo = new URL('../pages/login_signup.html', window.location.href).href;
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            emailRedirectTo,
            data: {
                first_name: firstName,
                middle_name: middleName || null,
                last_name: lastName,
                phone_number: phone,
                role: 'customer'
            }
        }
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';

    if (error) {
        const normalized = error.message.toLowerCase();
        if (
            normalized.includes('already registered') ||
            normalized.includes('already been registered') ||
            normalized.includes('already in use') ||
            normalized.includes('user already registered')
        ) {
            setSignupMessage('This email is already in use. Please log in or use Forgot password instead.', 'error');
            return;
        }

        setSignupMessage('Sign up failed: ' + error.message, 'error');
        return;
    }

    const looksLikeExistingUser =
        data?.user &&
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0;

    if (looksLikeExistingUser) {
        setSignupMessage('This email is already in use. Please log in or use Forgot password instead.', 'error');
        return;
    }

    alert('Account created. Please check your email and click the confirmation link before logging in.');
    setSignupMessage('');
    signupForm.reset();
    showLoginTab();
});
