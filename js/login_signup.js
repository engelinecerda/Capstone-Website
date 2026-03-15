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

loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.classList.add('active');
    signupForm.classList.remove('active');
});

signupTab.addEventListener('click', () => {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    signupForm.classList.add('active');
    loginForm.classList.remove('active');
});

// ========================
// Login Form Submit
// ========================
loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        alert('Login failed: ' + error.message);
        return;
    }

    console.log('Login success:', data);
    window.location.href = '../index.html'; // redirect after login
});

// ========================
// Sign Up Form Submit
// ========================
signupForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    // Get all field values
    const firstName   = document.getElementById('first-name').value.trim();
    const middleName  = document.getElementById('middle-name').value.trim();
    const lastName    = document.getElementById('last-name').value.trim();
    const email       = document.getElementById('signup-email').value.trim();
    const phone       = document.getElementById('signup-phone').value.trim();
    const password    = document.getElementById('signup-password').value;
    const confirm     = document.getElementById('confirm-password').value;

    // Validate passwords match
    if (password !== confirm) {
        alert('Passwords do not match. Please try again.');
        return;
    }

    // Validate password length
    if (password.length < 8) {
        alert('Password must be at least 8 characters long.');
        return;
    }

    // Step 1: Create the auth user in Supabase
    const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password
    });

    if (authError) {
        alert('Sign up failed: ' + authError.message);
        return;
    }

    const userId = authData.user.id;

    // Step 2: Insert the extra details into the profiles table
    const { error: profileError } = await supabase
        .from('profiles')
        .insert({
            id:            userId,
            first_name:    firstName,
            middle_name:   middleName || null,
            last_name:     lastName,
            email:         email,
            phone_number:  phone,
            role:          'customer',
            date_registered: new Date().toISOString()
        });

    if (profileError) {
        alert('Account created but profile save failed: ' + profileError.message);
        console.error('Profile insert error:', profileError);
        return;
    }

    // Success
    alert('Account created successfully! You can now log in.');

    // Switch to login tab after successful signup
    signupTab.classList.remove('active');
    loginTab.classList.add('active');
    signupForm.classList.remove('active');
    loginForm.classList.add('active');

    // Clear the signup form
    signupForm.reset();
});