import { portalSupabase as supabase } from './supabase.js';

const form = document.getElementById('portal-forgot-password-form');
const message = document.getElementById('portal-forgot-password-msg');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();

  const email = document.getElementById('portal-reset-email')?.value.trim() || '';
  const submitBtn = form.querySelector('button[type="submit"]');
  const redirectTo = new URL('/admin/reset-password.html', window.location.href).href;

  message.className = 'form-msg';
  message.innerText = '';

  if (!email) {
    message.className = 'form-msg error';
    message.innerText = 'Please enter your email address.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo
  });

  submitBtn.disabled = false;
  submitBtn.textContent = 'Send Reset Link';

  if (error) {
    message.className = 'form-msg error';
    message.innerText = 'Failed to send reset email: ' + error.message;
    return;
  }

  message.className = 'form-msg success';
  message.innerText = 'If an account exists for that email, a reset link has been sent.';
  form.reset();
});
