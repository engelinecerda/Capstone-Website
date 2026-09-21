// js/inquiry.js — powers /inquiry.html, the Phase 1 pre-booking lead-capture
// form. Gated at PAGE LOAD (not at submit) — an unauthenticated visitor only
// ever sees the shared auth-gate modal, never the form itself.
import { customerSupabase as supabase } from '/js/supabase.js';
import { showFeedbackModal } from '/js/feedback_modal.js';
import { attachPhoneMask } from '/js/phone_format.js';

const guestBlock  = document.getElementById('inquiryGuestBlock');
const formWrap    = document.getElementById('inquiryFormWrap');
const successBlock = document.getElementById('inquirySuccess');

const nameInput     = document.getElementById('inquiry-name');
const eventTypeSel  = document.getElementById('inquiry-event-type');
const eventDateInput = document.getElementById('inquiry-event-date');
const guestCountInput = document.getElementById('inquiry-guest-count');
const emailInput    = document.getElementById('inquiry-email');
const mobileInput   = document.getElementById('inquiry-mobile');
attachPhoneMask(mobileInput);
const referralSel   = document.getElementById('inquiry-referral');
const remarksInput  = document.getElementById('inquiry-remarks');
const form          = document.getElementById('inquiryForm');
const submitBtn     = document.getElementById('inquirySubmitBtn');
const formMessage   = document.getElementById('inquiryFormMessage');

function setFormMessage(msg, isError = false) {
    if (!formMessage) return;
    formMessage.textContent = msg;
    formMessage.classList.toggle('error', isError);
}

// Same "only honor a same-site path" rule as reservations.js's
// getSafeRedirectTarget()/login.js — never hand an open redirect to a
// crafted referrer.
function safeGoBackTarget() {
    try {
        const ref = document.referrer;
        if (ref) {
            const refUrl = new URL(ref);
            if (refUrl.origin === window.location.origin && refUrl.pathname !== '/inquiry') {
                return refUrl.pathname + refUrl.search;
            }
        }
    } catch { /* fall through */ }
    return '/packages';
}

async function showInquiryAuthGate() {
    const result = await showFeedbackModal({
        type: 'info',
        icon: 'ti-lock',
        title: 'Sign in to send an inquiry',
        message: 'Create an account or sign in — it only takes a minute, and helps us follow up with you directly.',
        confirmText: 'Sign In',
        tertiaryText: 'Create Account',
        dismissText: 'Go back'
    });
    if (result === true) {
        window.location.href = '/login?redirect=' + encodeURIComponent('/inquiry');
    } else if (result === 'tertiary') {
        window.location.href = '/signup?redirect=' + encodeURIComponent('/inquiry');
    } else {
        // Escape / backdrop / "Go back" — there's no partial form behind the
        // modal to return to, so leave the page entirely.
        window.location.href = safeGoBackTarget();
    }
}

function getContactName(profile, user) {
    return [profile?.first_name, profile?.middle_name, profile?.last_name].filter(Boolean).join(' ').trim() || user?.email || '';
}

async function prefillFromAccount(user) {
    const fallback = {
        first_name: user.user_metadata?.first_name || '',
        middle_name: user.user_metadata?.middle_name || '',
        last_name: user.user_metadata?.last_name || '',
        email: user.email || '',
        phone_number: user.user_metadata?.phone_number || ''
    };
    let profile = fallback;
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('first_name, middle_name, last_name, email, phone_number')
            .eq('user_id', user.id)
            .maybeSingle();
        if (!error && data) profile = data;
    } catch { /* keep fallback */ }

    nameInput.value = getContactName(profile, user);
    emailInput.value = profile.email || user.email || '';
    mobileInput.value = profile.phone_number || '';
}

async function loadEventTypes() {
    const { data, error } = await supabase.from('event_types').select('id, name').order('name', { ascending: true });
    if (error || !data) return;
    data.forEach((row) => {
        const opt = document.createElement('option');
        opt.value = row.id;
        opt.textContent = row.name;
        eventTypeSel.appendChild(opt);
    });
}

async function loadReferralSources() {
    const { data, error } = await supabase.from('referral_sources').select('id, label').order('sort_order', { ascending: true });
    if (error || !data) return;
    data.forEach((row) => {
        const opt = document.createElement('option');
        opt.value = row.id;
        opt.textContent = row.label;
        referralSel.appendChild(opt);
    });
}

form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFormMessage('');

    if (!eventTypeSel.value) {
        setFormMessage('Please select an event type.', true);
        eventTypeSel.focus();
        return;
    }
    const email = emailInput.value.trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        setFormMessage('Please enter a valid email address.', true);
        emailInput.focus();
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            // Session expired mid-fill — send back through the same gate
            // rather than letting an insert attempt fail confusingly.
            await showInquiryAuthGate();
            return;
        }

        const guestCountRaw = guestCountInput.value.trim();
        const { error } = await supabase.from('inquiries').insert({
            user_id: session.user.id,
            full_name: nameInput.value.trim(),
            event_type_id: eventTypeSel.value || null,
            event_date: eventDateInput.value || null,
            target_guest_count: guestCountRaw ? parseInt(guestCountRaw, 10) : null,
            email,
            mobile_number: mobileInput.value.trim() || null,
            referral_source_id: referralSel.value || null,
            remarks: remarksInput.value.trim() || null
        });

        if (error) throw error;

        formWrap.classList.add('hidden');
        successBlock.classList.remove('hidden');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        setFormMessage(err?.message || 'Something went wrong sending your inquiry. Please try again.', true);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Inquiry';
    }
});

(async function init() {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
        guestBlock.classList.remove('hidden');
        await showInquiryAuthGate();
        return;
    }

    formWrap.classList.remove('hidden');
    await Promise.all([
        prefillFromAccount(session.user),
        loadEventTypes(),
        loadReferralSources()
    ]);
}());
