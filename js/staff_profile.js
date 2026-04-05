import { supabase } from './supabase.js';
import { verifyPortalSession } from './admin_auth.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarName = document.getElementById('sidebarName');
const sidebarEmail = document.getElementById('sidebarEmail');
const sidebarRolePill = document.getElementById('sidebarRolePill');
const headerRole = document.getElementById('headerRole');
const heroAvatar = document.getElementById('heroAvatar');
const heroName = document.getElementById('heroName');
const heroEmail = document.getElementById('heroEmail');
const portalRoleValue = document.getElementById('portalRoleValue');
const staffRoleValue = document.getElementById('staffRoleValue');
const staffRoleCopy = document.getElementById('staffRoleCopy');
const detailPortalRole = document.getElementById('detailPortalRole');
const detailStaffRole = document.getElementById('detailStaffRole');
const detailDisplayName = document.getElementById('detailDisplayName');
const focusProfileBtn = document.getElementById('focusProfileBtn');
const pageMessage = document.getElementById('pageMessage');
const profileForm = document.getElementById('profileForm');
const profileMessage = document.getElementById('profileMessage');
const passwordForm = document.getElementById('passwordForm');
const passwordMessage = document.getElementById('passwordMessage');
const logoutBtn = document.getElementById('logoutBtn');

const profileFirstName = document.getElementById('profileFirstName');
const profileMiddleName = document.getElementById('profileMiddleName');
const profileLastName = document.getElementById('profileLastName');
const profileEmail = document.getElementById('profileEmail');
const profilePhone = document.getElementById('profilePhone');
const profileDateRegistered = document.getElementById('profileDateRegistered');

const state = {
  session: null,
  profile: null
};

const ROLE_COPY = {
  barista: 'Food and Beverage Team',
  cashier: 'Front Counter Team',
  kitchen: 'Kitchen Team'
};

function normalizeRole(value) {
  return String(value || '').trim().toLowerCase();
}

function redirectLogin() {
  window.location.replace('./admin_login.html');
}

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

function formatStaffRole(staffRole) {
  const normalized = normalizeRole(staffRole);
  if (!normalized) return 'Staff';

  return normalized
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatPortalRole(role) {
  const normalized = normalizeRole(role);
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Staff';
}

function getStaffRoleCopy(staffRole) {
  return ROLE_COPY[normalizeRole(staffRole)] || 'Operations Team';
}

function getDisplayName(profile) {
  const parts = [
    profile?.first_name,
    profile?.middle_name,
    profile?.last_name
  ].filter(Boolean);

  return parts.join(' ') || profile?.email || 'Staff member';
}

function getInitials(profile) {
  const parts = [profile?.first_name, profile?.last_name].filter(Boolean);
  const initials = parts.map((value) => value.trim().charAt(0).toUpperCase()).join('');
  return initials || String(profile?.email || 'S').charAt(0).toUpperCase();
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

function getFallbackProfile(session) {
  const user = session?.user;
  return {
    user_id: user?.id || '',
    first_name: user?.user_metadata?.first_name || '',
    middle_name: user?.user_metadata?.middle_name || '',
    last_name: user?.user_metadata?.last_name || '',
    email: user?.email || '',
    phone_number: user?.user_metadata?.phone_number || '',
    role: 'staff',
    staff_role: user?.user_metadata?.staff_role || '',
    date_registered: user?.created_at || ''
  };
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

  const displayName = getDisplayName(profile);
  const roleLabel = formatStaffRole(profile.staff_role);
  const portalRoleLabel = formatPortalRole(profile.role);
  const initials = getInitials(profile);
  const email = profile.email || state.session?.user?.email || 'No email on file';

  if (sidebarAvatar) sidebarAvatar.textContent = initials;
  if (sidebarName) sidebarName.textContent = displayName;
  if (sidebarEmail) sidebarEmail.textContent = email;
  if (sidebarRolePill) sidebarRolePill.textContent = roleLabel;

  if (heroAvatar) heroAvatar.textContent = initials;
  if (heroName) heroName.textContent = displayName;
  if (heroEmail) heroEmail.textContent = email;

  if (headerRole) headerRole.textContent = roleLabel;
  if (portalRoleValue) portalRoleValue.textContent = portalRoleLabel;
  if (staffRoleValue) staffRoleValue.textContent = roleLabel;
  if (staffRoleCopy) staffRoleCopy.textContent = getStaffRoleCopy(profile.staff_role);
  if (detailPortalRole) detailPortalRole.textContent = portalRoleLabel;
  if (detailStaffRole) detailStaffRole.textContent = roleLabel;
  if (detailDisplayName) detailDisplayName.textContent = displayName;

  populateProfileForm();
}

async function loadStaffProfile() {
  setPageMessage('Loading your profile...');

  try {
    const { session, profile } = await verifyPortalSession(supabase, { requiredRole: 'staff' });
    if (!session) {
      await supabase.auth.signOut();
      redirectLogin();
      return;
    }

    state.session = session;
    state.profile = profile || getFallbackProfile(session);
    renderProfileShell();
    setPageMessage('Your staff profile is ready.');
  } catch (error) {
    setPageMessage(error?.message || 'Unable to load your staff profile right now.', true);
  }
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
    role: state.profile?.role || 'staff',
    staff_role: state.profile?.staff_role || null,
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
    setFormMessage(passwordMessage, 'Password updated successfully.', 'success');
  } catch (error) {
    setFormMessage(passwordMessage, `Failed to update password: ${error.message}`, 'error');
  }
}

function bindEvents() {
  profileForm?.addEventListener('submit', handleProfileSubmit);
  passwordForm?.addEventListener('submit', handlePasswordSubmit);
  focusProfileBtn?.addEventListener('click', () => {
    profileFirstName?.focus();
    profileFirstName?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  logoutBtn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    redirectLogin();
  });

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      redirectLogin();
    }
  });
}

bindEvents();
await loadStaffProfile();
