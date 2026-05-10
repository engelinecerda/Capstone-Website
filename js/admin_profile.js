import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import {
  formatPortalRoleLabel,
  getPortalDisplayName,
  getPortalInitials,
  populatePortalIdentity
} from './admin_auth.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { logAudit } from './audit_logger.js';

const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const heroAvatar = document.getElementById('heroAvatar');
const heroName = document.getElementById('heroName');
const heroEmail = document.getElementById('heroEmail');
const portalRoleValue = document.getElementById('portalRoleValue');
const detailPortalRole = document.getElementById('detailPortalRole');
const detailDisplayName = document.getElementById('detailDisplayName');
const detailEmail = document.getElementById('detailEmail');
const pageMessage = document.getElementById('pageMessage');
const profileForm = document.getElementById('profileForm');
const profileMessage = document.getElementById('profileMessage');
const passwordForm = document.getElementById('passwordForm');
const passwordMessage = document.getElementById('passwordMessage');

const profileFirstName = document.getElementById('profileFirstName');
const profileMiddleName = document.getElementById('profileMiddleName');
const profileLastName = document.getElementById('profileLastName');
const profileEmail = document.getElementById('profileEmail');
const profilePhone = document.getElementById('profilePhone');
const profileDateRegistered = document.getElementById('profileDateRegistered');

const mfaStatusRow = document.getElementById('mfaStatusRow');
const mfaStatusChip = document.getElementById('mfaStatusChip');
const mfaActionArea = document.getElementById('mfaActionArea');
const mfaMessage = document.getElementById('mfaMessage');
const mfaEnrollPanel = document.getElementById('mfaEnrollPanel');
const mfaQrWrap = document.getElementById('mfaQrWrap');
const mfaEnrollCode = document.getElementById('mfaEnrollCode');
const mfaEnrollMessage = document.getElementById('mfaEnrollMessage');
const mfaVerifyBtn = document.getElementById('mfaVerifyBtn');
const mfaCancelEnrollBtn = document.getElementById('mfaCancelEnrollBtn');

const state = {
  session: null,
  profile: null,
  mfaFactorId: ''
};

function setPageMessage(message, isError = false) {
  if (!pageMessage) return;
  pageMessage.textContent = message;
  pageMessage.classList.toggle('error', isError);
}

function setFormMessage(element, message, tone = '') {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', tone === 'error');
  element.classList.toggle('success', tone === 'success');
}

function formatDate(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function populateProfileForm() {
  const profile = state.profile;
  if (!profile) return;

  profileFirstName.value = profile.first_name || '';
  profileMiddleName.value = profile.middle_name || '';
  profileLastName.value = profile.last_name || '';
  profileEmail.value = profile.email || state.session?.user?.email || '';
  profilePhone.value = profile.phone_number || '';
  profileDateRegistered.value = formatDate(profile.date_registered);
}

function renderProfileShell() {
  const profile = state.profile;
  if (!profile) return;

  const identity = populatePortalIdentity({
    profile,
    session: state.session,
    nameEl: sidebarName,
    emailEl: sidebarEmail,
    roleEl: sidebarRolePill,
    fallbackLabel: profile.role === 'super_admin' ? 'Super Admin' : 'Admin'
  });

  if (heroAvatar) heroAvatar.textContent = getPortalInitials(profile, 'A');
  if (heroName) heroName.textContent = identity.displayName;
  if (heroEmail) heroEmail.textContent = identity.email;
  if (portalRoleValue) portalRoleValue.textContent = identity.roleLabel;
  if (detailPortalRole) detailPortalRole.textContent = formatPortalRoleLabel(profile.role, 'Admin');
  if (detailDisplayName) detailDisplayName.textContent = getPortalDisplayName(profile, 'Admin');
  if (detailEmail) detailEmail.textContent = identity.email;
  populateProfileForm();
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  if (!state.session) return;

  const payload = {
    user_id: state.session.user.id,
    first_name: profileFirstName.value.trim(),
    middle_name: profileMiddleName.value.trim() || null,
    last_name: profileLastName.value.trim(),
    email: state.session.user.email || '',
    phone_number: profilePhone.value.trim() || null,
    role: state.profile?.role || 'admin',
    date_registered: state.profile?.date_registered || state.session.user.created_at || new Date().toISOString()
  };

  if (!payload.first_name || !payload.last_name) {
    setFormMessage(profileMessage, 'First name and last name are required.', 'error');
    return;
  }

  setFormMessage(profileMessage, 'Saving profile...');

  try {
    const { error } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'user_id' });

    if (error) throw error;

    state.profile = {
      ...state.profile,
      ...payload
    };

    // Keep the cached profile in sync so other pages see the updated info
    localStorage.setItem('profile', JSON.stringify(state.profile));

    await logAudit({
      action:   'Updated Profile',
      category: 'Account',
      details:  `Profile updated for ${payload.first_name} ${payload.last_name} (${payload.email})`,
      entityId: payload.user_id
    });

    renderProfileShell();
    setFormMessage(profileMessage, 'Profile updated successfully.', 'success');
  } catch (error) {
    setFormMessage(profileMessage, `Failed to update profile: ${error.message}`, 'error');
  }
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  if (!state.session) return;

  const currentPassword = document.getElementById('currentPassword')?.value || '';
  const newPassword = document.getElementById('newPassword')?.value || '';
  const confirmPassword = document.getElementById('confirmPassword')?.value || '';

  if (newPassword.length < 8) {
    setFormMessage(passwordMessage, 'New password must be at least 8 characters long.', 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    setFormMessage(passwordMessage, 'New password and confirmation do not match.', 'error');
    return;
  }

  setFormMessage(passwordMessage, 'Updating password...');

  try {
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: state.session.user.email,
      password: currentPassword
    });

    if (signInError) {
      throw new Error('Current password is incorrect.');
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) throw updateError;

    passwordForm.reset();
    await logAudit({
      action:   'Changed Password',
      category: 'Account',
      details:  `Password changed for ${state.session.user.email}`,
      entityId: state.session.user.id
    });
    setFormMessage(passwordMessage, 'Password updated successfully.', 'success');
  } catch (error) {
    setFormMessage(passwordMessage, `Failed to update password: ${error.message}`, 'error');
  }
}

function bindEvents() {
  profileForm?.addEventListener('submit', handleProfileSubmit);
  passwordForm?.addEventListener('submit', handlePasswordSubmit);
}

// ── MFA ──────────────────────────────────────────────────────────
function setMfaMsg(message, tone = '') {
  if (!mfaMessage) return;
  mfaMessage.textContent = message;
  mfaMessage.className = 'form-message' + (tone ? ` ${tone}` : '');
}

function setMfaEnrollMsg(message, tone = '') {
  if (!mfaEnrollMessage) return;
  mfaEnrollMessage.textContent = message;
  mfaEnrollMessage.className = 'form-message' + (tone ? ` ${tone}` : '');
}

async function loadMfaStatus() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) { setMfaMsg('Could not load 2FA status.', 'error'); return; }

  const totp = data?.totp?.find((f) => f.status === 'verified');

  if (mfaStatusChip) {
    mfaStatusChip.textContent = totp ? '2FA is enabled' : '2FA is not enabled';
    mfaStatusChip.className = `mfa-status-chip ${totp ? 'mfa-chip-on' : 'mfa-chip-off'}`;
  }

  if (mfaActionArea) {
    if (totp) {
      mfaActionArea.innerHTML = `<button type="button" class="secondary-btn mfa-remove-btn" id="mfaRemoveBtn" data-factor-id="${totp.id}">Remove 2FA</button>`;
      document.getElementById('mfaRemoveBtn')?.addEventListener('click', handleUnenrollMfa);
    } else {
      mfaActionArea.innerHTML = `<button type="button" class="primary-btn" id="mfaEnableBtn">Enable 2FA</button>`;
      document.getElementById('mfaEnableBtn')?.addEventListener('click', handleStartEnroll);
    }
  }

  if (mfaStatusRow) mfaStatusRow.style.display = '';
}

async function handleStartEnroll() {
  setMfaMsg('');

  // Clean up any leftover unverified factors using data.all (catches every factor type/status)
  const { data: existing } = await supabase.auth.mfa.listFactors();
  const stalePending = (existing?.all ?? existing?.totp ?? []).filter((f) => f.status !== 'verified');
  for (const f of stalePending) {
    const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (unenrollErr) {
      setMfaMsg(`Could not remove previous setup attempt: ${unenrollErr.message}`, 'error');
      return;
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'ELI Coffee Events' });
  if (error) { setMfaMsg('Could not start 2FA setup: ' + error.message, 'error'); return; }

  state.mfaFactorId = data.id;

  if (mfaQrWrap) {
    mfaQrWrap.innerHTML = '';

    const canvasWrap = document.createElement('div');
    mfaQrWrap.appendChild(canvasWrap);

    if (typeof QRCode !== 'undefined') {
      new QRCode(canvasWrap, {
        text: data.totp.uri,
        width: 200,
        height: 200,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      canvasWrap.innerHTML = data.totp.qr_code;
    }

    if (data.totp.secret) {
      const fallback = document.createElement('div');
      fallback.className = 'mfa-manual-secret';
      fallback.innerHTML = `<p class="mfa-manual-label">Can't scan? Enter this key manually in your app:</p><code class="mfa-secret-code">${data.totp.secret}</code>`;
      mfaQrWrap.appendChild(fallback);
    }
  }

  if (mfaEnrollPanel) mfaEnrollPanel.style.display = '';
  if (mfaStatusRow) mfaStatusRow.style.display = 'none';
  if (mfaEnrollCode) { mfaEnrollCode.value = ''; mfaEnrollCode.focus(); }
  setMfaEnrollMsg('');
}

async function handleVerifyEnroll() {
  const code = (mfaEnrollCode?.value || '').replace(/\s/g, '');
  if (!code || code.length !== 6) {
    setMfaEnrollMsg('Enter the 6-digit code from your authenticator app.', 'error');
    return;
  }

  setMfaEnrollMsg('Verifying...');
  if (mfaVerifyBtn) mfaVerifyBtn.disabled = true;

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: state.mfaFactorId, code });

  if (mfaVerifyBtn) mfaVerifyBtn.disabled = false;

  if (error) {
    setMfaEnrollMsg('Invalid code. Check your authenticator app and try again.', 'error');
    return;
  }

  state.mfaFactorId = '';
  if (mfaEnrollPanel) mfaEnrollPanel.style.display = 'none';
  await loadMfaStatus();

  await logAudit({
    action: 'Enabled 2FA',
    category: 'System',
    details: `2FA enabled for ${state.session.user.email}`,
    entityId: state.session.user.id
  });

  setMfaMsg('Two-factor authentication has been enabled.', 'success');
}

async function handleUnenrollMfa(event) {
  const factorId = event.currentTarget.dataset.factorId;
  if (!factorId) return;
  if (!confirm('Remove two-factor authentication? You will no longer need a code to sign in.')) return;

  setMfaMsg('Removing 2FA...');
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) { setMfaMsg('Could not remove 2FA: ' + error.message, 'error'); return; }

  await loadMfaStatus();

  await logAudit({
    action: 'Disabled 2FA',
    category: 'System',
    details: `2FA disabled for ${state.session.user.email}`,
    entityId: state.session.user.id
  });

  setMfaMsg('Two-factor authentication has been removed.', 'success');
}

async function cancelEnroll() {
  if (state.mfaFactorId) {
    await supabase.auth.mfa.unenroll({ factorId: state.mfaFactorId }).catch(() => {});
    state.mfaFactorId = '';
  }
  if (mfaQrWrap) mfaQrWrap.innerHTML = '';
  if (mfaEnrollPanel) mfaEnrollPanel.style.display = 'none';
  await loadMfaStatus();
}

mfaVerifyBtn?.addEventListener('click', handleVerifyEnroll);
mfaCancelEnrollBtn?.addEventListener('click', cancelEnroll);

// ── BOOT ─────────────────────────────────────────────────────────
bindEvents();
wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: ({ session, profile }) => {
    state.session = session;
    state.profile = profile;
    setupInactivityLogout(profile.role);
    initAdminSidebarBadges(supabase);
    renderProfileShell();
    setPageMessage('Your profile is ready.');
    loadMfaStatus();
  }
});