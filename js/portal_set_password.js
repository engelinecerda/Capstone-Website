import { portalActivationSupabase as supabase } from './supabase.js';
import { initPasswordToggles } from './password_toggle.js';
import { validatePassword } from './password_rules.js';

initPasswordToggles();

const form = document.getElementById('portal-set-password-form');
const message = document.getElementById('portal-set-password-msg');

// Unlike portal_reset_password.js, this page does NOT block staff accounts.
// The "shared staff password is admin-managed" rule applies to later
// self-service resets of an already-active account — it must not apply
// here, since activating a brand-new staff invite for the first time is
// exactly what this page exists to do.
let activationReady = false;

// When the invite token is rejected, Supabase redirects here with the reason
// in the URL (e.g. #error=access_denied&error_code=otp_expired). This page
// used to ignore that and show a generic message. Read it before anything
// below touches the Supabase client, which can rewrite the URL.
function readInviteLinkError() {
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const queryParams = new URLSearchParams(window.location.search || '');
  const code = hashParams.get('error_code') || queryParams.get('error_code') || '';
  const error = hashParams.get('error') || queryParams.get('error') || '';
  if (!code && !error) return null;
  return { code: code || error };
}

const inviteLinkError = readInviteLinkError();

// Newer invite emails link here as /admin/set-password?token_hash=...&type=invite
// instead of going through Supabase's one-click verify URL. That one-click URL
// is consumed the moment anything opens it — including email security
// scanners and link previewers — which is what produced "otp_expired" for
// links nobody had actually used. A token_hash link is NOT touched on page
// load: it is only redeemed (verifyOtp) when the person submits a valid
// password below, which a scanner can't do. Old-style links (tokens in the
// URL hash) still work through the session handling that follows.
function readTokenHashLink() {
  const params = new URLSearchParams(window.location.search || '');
  const tokenHash = params.get('token_hash') || '';
  const type = params.get('type') || '';
  if (!tokenHash || type !== 'invite') return null;
  return { tokenHash, type };
}

const tokenHashLink = inviteLinkError ? null : readTokenHashLink();
let tokenRedeemed = false;

function setMessage(type, text) {
  message.className = `form-msg ${type}`.trim();
  message.innerText = text;
}

function setSubmitDisabled(disabled) {
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = disabled;
}

const {
  data: { subscription }
} = supabase.auth.onAuthStateChange((event) => {
  if (!inviteLinkError && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN')) {
    activationReady = true;
    setMessage('', '');
  }
});

const {
  data: { session }
} = await supabase.auth.getSession();

if (session && !inviteLinkError) {
  activationReady = true;
}

// A token_hash link has no session yet — it gets one when it is redeemed on
// submit — so the form is allowed to proceed.
if (tokenHashLink) {
  activationReady = true;
  setMessage('', '');
}

if (inviteLinkError) {
  // A rejected link must not fall back to whatever session happens to be in
  // this browser (for example an admin already signed in) and let that
  // account's password be changed here.
  setSubmitDisabled(true);
  setMessage('error', `This invite link is invalid, has expired, or was already used (${inviteLinkError.code}). Ask your administrator to resend the invite email.`);
} else if (!activationReady) {
  setMessage('error', 'Open this page using the invite link sent to your email.');
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const newPassword = document.getElementById('portal-new-password')?.value || '';
  const confirmPassword = document.getElementById('portal-confirm-new-password')?.value || '';
  const submitBtn = form.querySelector('button[type="submit"]');

  setMessage('', '');

  if (!activationReady) {
    setMessage('error', 'This invite link is invalid or has expired.');
    return;
  }

  if (newPassword !== confirmPassword) {
    setMessage('error', 'Passwords do not match.');
    return;
  }

  // Same rules as signup/account/Users & Roles (js/password_rules.js) —
  // this page must not accept a weaker password than any other password
  // entry point in the app.
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    setMessage('error', passwordError);
    return;
  }

  setSubmitDisabled(true);
  submitBtn.textContent = 'Activating...';

  // Redeem the invite token only now, after the password has passed
  // validation, so a typo in the form never uses up the one-time link.
  if (tokenHashLink && !tokenRedeemed) {
    const { error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: tokenHashLink.tokenHash,
      type: tokenHashLink.type
    });
    if (verifyError) {
      submitBtn.textContent = 'Activate Account';
      activationReady = false;
      setMessage('error', 'This invite link is invalid, has expired, or was already used. Ask your administrator to resend the invite email.');
      return;
    }
    tokenRedeemed = true;
  }

  const { error } = await supabase.auth.updateUser({
    password: newPassword
  });

  setSubmitDisabled(false);
  submitBtn.textContent = 'Activate Account';

  if (error) {
    setMessage('error', 'Failed to set password: ' + error.message);
    return;
  }

  setMessage('success', 'Account activated. Redirecting to login...');
  form.reset();
  subscription.unsubscribe();
  // End the invite session so the new account has to sign in with the
  // password it just chose, instead of being logged in by the invite link.
  await supabase.auth.signOut().catch(() => {});
  setTimeout(() => window.location.replace('/admin'), 1400);
});