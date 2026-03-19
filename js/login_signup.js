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
const loginTab  = document.getElementById('login-tab');
const signupTab = document.getElementById('signup-tab');
const loginForm  = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');

loginTab.addEventListener('click', () => {
    loginTab.classList.add('active');
    signupTab.classList.remove('active');
    loginForm.classList.add('active');
    signupForm.classList.remove('active');
    hideOtpScreen(); // go back to the form if OTP screen was showing
});

signupTab.addEventListener('click', () => {
    signupTab.classList.add('active');
    loginTab.classList.remove('active');
    signupForm.classList.add('active');
    loginForm.classList.remove('active');
});

// ========================
// OTP Screen (injected dynamically)
// We show this after the signup form is submitted
// ========================

// Stores pending signup data while waiting for OTP
let pendingSignup = null;

function showOtpScreen(email) {
    // Hide the signup form fields but keep the container visible
    document.getElementById('signup-fields').classList.add('hidden');

    // Create OTP screen if it doesn't exist yet
    let otpScreen = document.getElementById('otp-screen');
    if (!otpScreen) {
        otpScreen = document.createElement('div');
        otpScreen.id = 'otp-screen';
        otpScreen.innerHTML = `
            <div style="text-align:center; margin-bottom: 20px;">
                <div style="font-size: 40px; margin-bottom: 12px;">📧</div>
                <h3 style="color: #2A1408; font-size: 20px; font-weight: 700; margin-bottom: 6px;">Check your email</h3>
                <p style="color: #777; font-size: 14px; line-height: 1.6;">
                    We sent a verification code to<br>
                    <strong style="color: #6B3A1F;" id="otp-email-display"></strong>
                </p>
            </div>
            <input
                type="text"
                id="otp-input"
                maxlength="6"
                placeholder="Enter 6-digit code"
                style="
                    width: 100%;
                    padding: 14px;
                    border-radius: 10px;
                    border: 1px solid #ddd;
                    font-size: 22px;
                    letter-spacing: 8px;
                    text-align: center;
                    box-sizing: border-box;
                    font-family: inherit;
                    color: #2A1408;
                    margin-bottom: 14px;
                "
            >
            <button id="verify-otp-btn" style="
                width: 100%;
                padding: 13px;
                background: #6B3A1F;
                color: #fff;
                border: none;
                border-radius: 10px;
                font-size: 15px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;
                margin-bottom: 12px;
                transition: background 0.2s;
            ">Verify & Create Account</button>
            <div style="text-align:center;">
                <span style="font-size:13px; color:#777;">Didn't receive the code? </span>
                <button id="resend-otp-btn" style="
                    background: none;
                    border: none;
                    color: #6B3A1F;
                    font-size: 13px;
                    font-weight: 700;
                    cursor: pointer;
                    font-family: inherit;
                    padding: 0;
                ">Resend</button>
            </div>
            <div id="otp-error" style="
                display: none;
                margin-top: 14px;
                background: #FFF3CD;
                border: 1px solid #FFD966;
                border-radius: 8px;
                padding: 10px 14px;
                font-size: 13px;
                color: #6B4C00;
            "></div>
        `;
        signupForm.appendChild(otpScreen);

        // Verify button
        document.getElementById('verify-otp-btn').addEventListener('click', verifyOtp);

        // Allow pressing Enter in the OTP input
        document.getElementById('otp-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') verifyOtp();
        });

        // Resend button
        document.getElementById('resend-otp-btn').addEventListener('click', async () => {
            const btn = document.getElementById('resend-otp-btn');
            btn.disabled = true;
            btn.textContent = 'Sending...';

            const { error } = await supabase.auth.signInWithOtp({ email: pendingSignup.email });

            if (error) {
                showOtpError('Failed to resend code: ' + error.message);
            } else {
                showOtpError(''); // clear errors
                btn.textContent = 'Sent!';
                setTimeout(() => {
                    btn.textContent = 'Resend';
                    btn.disabled = false;
                }, 5000);
            }
        });
    }

    document.getElementById('otp-email-display').textContent = email;
    otpScreen.style.display = 'block';
}

function hideOtpScreen() {
    const otpScreen = document.getElementById('otp-screen');
    if (otpScreen) otpScreen.style.display = 'none';

    const fields = document.getElementById('signup-fields');
    if (fields) fields.classList.remove('hidden');

    pendingSignup = null;
}

function showOtpError(msg) {
    const el = document.getElementById('otp-error');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; return; }
    el.textContent = msg;
    el.style.display = 'block';
}

// ========================
// Verify OTP → then save profile
// ========================
async function verifyOtp() {
    const otp   = document.getElementById('otp-input').value.trim();
    const btn   = document.getElementById('verify-otp-btn');

    if (!otp || otp.length < 6) {
        showOtpError('Please enter the 6-digit code sent to your email.');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Verifying...';
    showOtpError('');

    // Verify the OTP with Supabase
    const { data, error } = await supabase.auth.verifyOtp({
        email: pendingSignup.email,
        token: otp,
        type:  'email'
    });

    if (error) {
        showOtpError('Invalid or expired code. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Verify & Create Account';
        return;
    }

    // OTP verified — now save the profile
    const userId = data.user.id;

    const { error: profileError } = await supabase
        .from('profiles')
        .insert({
            id:              userId,
            first_name:      pendingSignup.firstName,
            middle_name:     pendingSignup.middleName || null,
            last_name:       pendingSignup.lastName,
            email:           pendingSignup.email,
            phone_number:    pendingSignup.phone,
            role:            'customer',
            date_registered: new Date().toISOString()
        });

    if (profileError) {
        showOtpError('Account verified but profile save failed: ' + profileError.message);
        console.error('Profile insert error:', profileError);
        btn.disabled = false;
        btn.textContent = 'Verify & Create Account';
        return;
    }

    // ✅ All done — switch to login tab
    alert('Account created successfully! You can now log in.');
    hideOtpScreen();
    signupForm.reset();

    signupTab.classList.remove('active');
    loginTab.classList.add('active');
    signupForm.classList.remove('active');
    loginForm.classList.add('active');
}

// ========================
// Login Form Submit
// ========================
loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
        alert('Login failed: ' + error.message);
        return;
    }

    console.log('Login success:', data);
    window.location.href = '../index.html';
});

// ========================
// Sign Up Form Submit
// Step 1: Validate → send OTP → show OTP screen
// Step 2: User enters OTP → verifyOtp() → save profile
// ========================
signupForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const firstName  = document.getElementById('first-name').value.trim();
    const middleName = document.getElementById('middle-name').value.trim();
    const lastName   = document.getElementById('last-name').value.trim();
    const email      = document.getElementById('signup-email').value.trim();
    const phone      = document.getElementById('signup-phone').value.trim();
    const password   = document.getElementById('signup-password').value;
    const confirm    = document.getElementById('confirm-password').value;

    // Validate
    if (password !== confirm) {
        alert('Passwords do not match. Please try again.');
        return;
    }
    if (password.length < 8) {
        alert('Password must be at least 8 characters long.');
        return;
    }

    const submitBtn = signupForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending code...';

    // Save pending data so verifyOtp() can use it
    pendingSignup = { firstName, middleName, lastName, email, phone, password };

    // Send OTP via Supabase (uses your custom Gmail SMTP)
    const { error } = await supabase.auth.signInWithOtp({ email });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign Up';

    if (error) {
        alert('Failed to send verification code: ' + error.message);
        pendingSignup = null;
        return;
    }

    // Show the OTP input screen
    showOtpScreen(email);
});