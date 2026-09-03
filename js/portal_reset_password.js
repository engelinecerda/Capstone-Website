import { portalSupabase as supabase } from './supabase.js';
import { initPasswordToggles } from './password_toggle.js';

initPasswordToggles();

const form = document.getElementById('portal-reset-password-form');
const message = document.getElementById('portal-reset-password-msg');

let recoveryReady = false;
let staffResetBlocked = false;

function setMessage(type, text) {
  message.className = `form-msg ${type}`.trim();
  message.innerText = text;
}

function setSubmitDisabled(disabled) {
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = disabled;
}

async function blockIfStaffAccount() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (profile?.role === 'staff') {
    staffResetBlocked = true;
    setSubmitDisabled(true);
    setMessage('error', 'The shared staff password is managed by the admin — contact your administrator to have it reset.');
  }
}

const {
  data: { subscription }
} = supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
    recoveryReady = true;
    setMessage('', '');
    blockIfStaffAccount();
  }
});

const {
  data: { session }
} = await supabase.auth.getSession();

if (session) {
  recoveryReady = true;
  await blockIfStaffAccount();
}

if (!recoveryReady) {
  setMessage('error', 'Open this page using the reset link sent to your email.');
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const newPassword = document.getElementById('portal-new-password')?.value || '';
  const confirmPassword = document.getElementById('portal-confirm-new-password')?.value || '';
  const submitBtn = form.querySelector('button[type="submit"]');

  setMessage('', '');

  if (!recoveryReady) {
    setMessage('error', 'This reset link is invalid or has expired.');
    return;
  }

  if (staffResetBlocked) {
    setMessage('error', 'The shared staff password is managed by the admin — contact your administrator to have it reset.');
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
