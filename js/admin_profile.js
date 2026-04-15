import { portalSupabase as supabase } from './supabase.js';
import {
  formatPortalRoleLabel,
  getPortalDisplayName,
  getPortalInitials,
  populatePortalIdentity,
  verifyAdminSession
} from './admin_auth.js';
import { refreshAdminSidebarCounts } from './admin_sidebar_counts.js';

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
const logoutBtn = document.getElementById('logoutBtn');
const navReservationCount = document.getElementById('navReservationCount');
const navContractCount = document.getElementById('navContractCount');
const navPaymentCount = document.getElementById('navPaymentCount');
const navReviewCount = document.getElementById('navReviewCount');

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

function redirectLogin() {
  window.location.replace('/admin');
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
    role: 'admin',
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

  const identity = populatePortalIdentity({
    profile,
    session: state.session,
    nameEl: sidebarName,
    emailEl: sidebarEmail,
    roleEl: sidebarRolePill,
    fallbackLabel: 'Admin'
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

async function loadAdminProfile() {
  setPageMessage('Loading your profile...');

  try {
    const { session, profile } = await verifyAdminSession(supabase);
    if (!session) {
      await supabase.auth.signOut();
      redirectLogin();
      return;
    }

    state.session = session;
    state.profile = profile || getFallbackProfile(session);
    renderProfileShell();
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    });
    setPageMessage('Your admin profile is ready.');
  } catch (error) {
    await refreshAdminSidebarCounts({
      supabase,
      reservationBadgeEl: navReservationCount,
      paymentBadgeEl: navPaymentCount,
      contractBadgeEl: navContractCount,
      reviewBadgeEl: navReviewCount
    }).catch(() => {});
    setPageMessage(error?.message || 'Unable to load your admin profile right now.', true);
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
await loadAdminProfile();
