// js/admin_inquiry_details.js — Inquiry detail view. Manager can change
// status and add an internal note; Admin sees everything read-only (Model B,
// same pattern as admin_reservation_details.js/admin_contracts.js: render
// the write controls only for Manager, PLUS re-check role again inside the
// save handler as defense-in-depth even though the button shouldn't exist
// for Admin in the first place).
import { portalSupabase as supabase } from './supabase.js';
import { validateAdminSession, wireLogoutButton, watchAuthState } from './session_validation.js';
import { setupInactivityLogout } from './super_admin_inactivity.js';
import { initAdminSidebarBadges } from './admin_sidebar_counts.js';
import { initAdminNav } from './admin_nav.js';
import { getPortalInitials } from './admin_auth.js';
import { initManagerNotificationBell } from './manager_notification_bell.js';

const sidebarAvatar = document.getElementById('sidebarAvatar');
const sidebarRoleBottom = document.getElementById('sidebarRoleBottom');
const viewOnlyPill = document.getElementById('inquiryViewOnlyPill');
const loadMessage = document.getElementById('inquiryLoadMessage');
const detailCard = document.getElementById('inquiryDetailCard');
const headerName = document.getElementById('inquiryHeaderName');
const headerSub = document.getElementById('inquiryHeaderSub');
const managerPanel = document.getElementById('inquiryManagerPanel');
const readOnlyPanel = document.getElementById('inquiryReadOnlyPanel');
const statusSelect = document.getElementById('inquiryStatusSelect');
const noteInput = document.getElementById('inquiryInternalNote');
const saveBtn = document.getElementById('inquirySaveBtn');
const saveMsg = document.getElementById('inquirySaveMsg');

let currentRole = null;
let currentInquiryId = null;

const STATUS_LABEL = { new: 'New', contacted: 'Contacted', converted: 'Converted', closed: 'Closed' };

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {})
  });
}

function setSaveMsg(text, isError = false) {
  saveMsg.textContent = text;
  saveMsg.classList.toggle('error', isError);
}

async function loadInquiry(id) {
  const { data, error } = await supabase
    .from('inquiries')
    .select('id, full_name, email, mobile_number, event_date, target_guest_count, inquiry_date, status, remarks, internal_note, event_types(name), referral_sources(label)')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    loadMessage.textContent = 'This inquiry could not be found.';
    return null;
  }
  return data;
}

function renderInquiry(inq) {
  headerName.childNodes[0].textContent = inq.full_name + ' ';
  headerSub.textContent = `Submitted ${formatDate(inq.inquiry_date, true)}`;

  document.getElementById('fv-name').textContent = inq.full_name || '—';
  document.getElementById('fv-status').textContent = STATUS_LABEL[inq.status] || inq.status;
  document.getElementById('fv-event-type').textContent = inq.event_types?.name || 'TBD';
  document.getElementById('fv-event-date').textContent = formatDate(inq.event_date);
  document.getElementById('fv-guest-count').textContent = inq.target_guest_count ?? '—';
  document.getElementById('fv-submitted').textContent = formatDate(inq.inquiry_date, true);
  document.getElementById('fv-email').textContent = inq.email || '—';
  document.getElementById('fv-mobile').textContent = inq.mobile_number || '—';
  document.getElementById('fv-referral').textContent = inq.referral_sources?.label || '—';
  document.getElementById('fv-remarks').textContent = inq.remarks || '—';
  document.getElementById('fv-internal-note').textContent = inq.internal_note || '—';

  statusSelect.value = inq.status || 'new';
  noteInput.value = inq.internal_note || '';
}

function applyRoleGating() {
  if (currentRole === 'admin') {
    viewOnlyPill?.classList.remove('hidden');
    managerPanel.classList.add('hidden');
    readOnlyPanel.classList.remove('hidden');
  } else {
    managerPanel.classList.remove('hidden');
    readOnlyPanel.classList.add('hidden');
  }
}

saveBtn.addEventListener('click', async () => {
  // Defense-in-depth — applyRoleGating() already hides this whole panel for
  // Admin, so this should be unreachable, but never trust that alone.
  if (currentRole === 'admin' || !currentInquiryId) return;

  saveBtn.disabled = true;
  setSaveMsg('Saving…');

  const { error } = await supabase
    .from('inquiries')
    .update({
      status: statusSelect.value,
      internal_note: noteInput.value.trim() || null
    })
    .eq('id', currentInquiryId);

  saveBtn.disabled = false;

  if (error) {
    setSaveMsg('Could not save changes. Please try again.', true);
    return;
  }

  document.getElementById('fv-status').textContent = STATUS_LABEL[statusSelect.value] || statusSelect.value;
  document.getElementById('fv-internal-note').textContent = noteInput.value.trim() || '—';
  setSaveMsg('Saved.');
});

wireLogoutButton();
watchAuthState();

validateAdminSession({
  onSuccess: async ({ profile }) => {
    currentRole = profile.role;
    setupInactivityLogout(profile.role);
    if (sidebarAvatar) sidebarAvatar.textContent = getPortalInitials(profile);
    if (sidebarRoleBottom) sidebarRoleBottom.textContent = profile.role === 'admin' ? 'Admin' : 'Manager';
    initAdminSidebarBadges(supabase);
    initManagerNotificationBell(supabase, profile.user_id);
    initAdminNav({ role: profile.role });
    applyRoleGating();

    const params = new URLSearchParams(window.location.search);
    currentInquiryId = params.get('id');
    if (!currentInquiryId) {
      loadMessage.textContent = 'No inquiry specified.';
      return;
    }

    const inq = await loadInquiry(currentInquiryId);
    if (!inq) return;

    loadMessage.hidden = true;
    detailCard.hidden = false;
    renderInquiry(inq);
  }
});
