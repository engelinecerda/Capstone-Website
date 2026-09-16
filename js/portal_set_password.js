import { portalSupabase as supabase } from './supabase.js';
import { initPasswordToggles } from './password_toggle.js';

initPasswordToggles();

const form = document.getElementById('portal-set-password-form');
const message = document.getElementById('portal-set-password-msg');

// Unlike portal_reset_password.js, this page does NOT block staff accounts.
// The "shared staff password is admin-managed" rule applies to later
// self-service resets of an already-active account — it must not apply
// here, since activating a brand-new staff invite for the first time is
// exactly what this page exists to do.
let activationReady = false;

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
  if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
    activationReady = true;
    setMessage('', '');
  }
});

const {
  data: { session }
} = await supabase.auth.getSession();

if (session) {
  activationReady = true;
}

if (!activationReady) {
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

  if (newPassword.length < 8) {
    setMessage('error', 'Password must be at least 8 characters.');
    return;
  }

  setSubmitDisabled(true);
  submitBtn.textContent = 'Activating...';

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
  setTimeout(() => window.location.replace('/admin'), 1400);
});