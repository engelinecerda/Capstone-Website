// email_verified.js — landing page after a customer clicks the confirmation
// link in their signup verification email (see emailRedirectTo in
// js/signup.js). Supabase redirects here either with no error params
// (success — the OTP/PKCE code has already been exchanged, or a session was
// established from an access_token in the hash) or with error/error_code/
// error_description params (failure, e.g. an expired or already-used link).
import { customerSupabase as supabase } from './supabase.js';

function parseAuthParams() {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hash);
    const queryParams = new URLSearchParams(window.location.search);
    const get = (key) => hashParams.get(key) || queryParams.get(key);
    return {
        error: get('error'),
        errorCode: get('error_code'),
        errorDescription: get('error_description')
    };
}

function getFailureCopy(errorCode) {
    if (errorCode === 'otp_expired') {
        return {
            heading: 'Verification link expired',
            body: 'This verification link is no longer valid. Request a new one to verify your email.'
        };
    }
    return {
        heading: 'Verification failed',
        body: "We couldn't verify your email with this link. It may have already been used, or it's invalid. Request a new one to verify your email."
    };
}

function renderSuccess() {
    document.getElementById('ev-state-success')?.classList.remove('hidden');
    // window.opener is only set when this tab was opened via script (e.g.
    // window.open()) — the common case is an email client opening a fresh,
    // opener-less tab, so this stays hidden for most customers. Never
    // auto-close; just offer the option.
    if (window.opener) {
        document.getElementById('ev-close-tab-row')?.classList.remove('hidden');
    }
}

function renderFailure(params) {
    const { heading, body } = getFailureCopy(params.errorCode);
    const headingEl = document.getElementById('ev-failure-heading');
    const bodyEl = document.getElementById('ev-failure-body');
    if (headingEl) headingEl.textContent = heading;
    if (bodyEl) bodyEl.textContent = body;
    document.getElementById('ev-state-failure')?.classList.remove('hidden');
}

function init() {
    const params = parseAuthParams();

    // Fire-and-forget: lets the Supabase client finish consuming the
    // tokens in the URL (establishes a session for flows where "session on
    // verify" is enabled). Not awaited — this page's state is decided
    // synchronously from the URL's own error params below, since some
    // verification flows intentionally don't leave the customer signed in
    // from this link alone.
    supabase.auth.getSession().catch(() => { /* ignore */ });

    // Strip the token/error hash from the visible, bookmarkable URL now
    // that it's been read — an access_token has no reason to sit around in
    // the address bar or browser history.
    if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (params.error) {
        renderFailure(params);
    } else {
        renderSuccess();
    }
}

document.getElementById('ev-close-tab-btn')?.addEventListener('click', () => window.close());

init();
