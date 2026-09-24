// reservations.js — powers the /reservations.html booking flow (public
// reservation form: Event Information → Your Details → Review → Contract).
//
// Extracted from an inline <script type="module"> in reservations.html for
// consistency with the rest of the codebase (every other page loads its
// logic as an external module) and so it benefits from browser caching
// across visits instead of being re-downloaded with every HTML change.
//
// Cross-script bridge: the venue map (initVenueMap/searchAddress, wired in a
// separate inline <script> after leaflet.js loads) communicates with this
// file exclusively via window.* globals (window.venueMapConfig,
// window.initVenueMap, window.venueMap) — nothing here relies on shared
// module scope with that script, so extraction doesn't change behavior.
import { customerSupabase as supabase } from '/js/supabase.js';
import { lockBodyScroll, unlockBodyScroll } from '/js/modal_scroll_lock.js';
import { CATERING_SECTION_META } from '/js/catering_section_hints.js';
import {
    fetchAvailableStartTimes,
    fetchBlackoutDates,
    fetchCalendarAvailability,
    fetchDateAvailability,
    getBookingScope as getSharedBookingScope,
    getCalendarRange,
    getScopeLabel,
    loadAdvanceNoticeRules,
    getEffectiveMinAdvanceDays as getSharedEffectiveMinAdvanceDays,
    isOutsideBookingWindow as sharedIsOutsideBookingWindow,
} from '/js/reservation_availability.js';
import { loadReservationFormConfig } from '/js/reservation_form_config.js';
import { buildCustomerPaymentUrl } from '/js/customer_payments.js';
import { showFeedbackModal, showConfirmModal } from '/js/feedback_modal.js';
import { pickActiveDiscount, applyDiscount } from '/js/package_discount_helpers.js';
import { fetchContractTemplateData, fetchContractFeeTermsTokens } from '/js/contract_render.js';
import { optimizedImageUrl } from '/js/cloudinary_optimized_image_delivery.js';
import { attachPhoneMask } from '/js/phone_format.js';

const { data: { session } } = await supabase.auth.getSession();
const isLoggedIn = !!session;

if (!isLoggedIn) {
    document.getElementById('resGuestNotice').classList.remove('hidden');
    document.getElementById('guestPkgReminder')?.classList.remove('hidden');
}

// Booking block — a customer with an overdue balance or unpaid
// cancellation fee on another reservation can't start a new one. This is
// UX only: block_booking_with_overdue_balance() and block_booking_with_
// unresolved_cancellation_debt() (supabase/migrations/20260914_.../20260909_...)
// enforce the same two conditions server-side regardless of this check, so
// a blocked customer finds out here instead of only at the final submit,
// but nothing relies on this call succeeding for actual enforcement.
function showBookingBlockNotice(blockInfo) {
    const notice = document.getElementById('resBookingBlockNotice');
    const messageEl = document.getElementById('resBookingBlockMessage');
    const linkEl = document.getElementById('resBookingBlockLink');
    if (!notice || !messageEl || !linkEl) return;

    const amount = fmtPeso(blockInfo.balance_due);
    const label = blockInfo.reservation_number || 'a previous reservation';
    messageEl.textContent = blockInfo.reason === 'unpaid_cancellation_fee'
        ? `You have an unpaid cancellation fee of ${amount} on reservation ${label}. Settle it before booking another event.`
        : `You have an overdue balance of ${amount} on reservation ${label}${blockInfo.due_date ? ` (due ${formatDisplayDate(blockInfo.due_date)})` : ''}. Settle it before booking another event.`;
    linkEl.href = buildCustomerPaymentUrl(blockInfo.reservation_id);

    notice.classList.remove('hidden');

    // Hard stop — hide the entire booking flow, not just show a banner
    // above it, so a blocked customer can't fill out the form at all.
    document.querySelector('.progress-container')?.classList.add('hidden');
    document.querySelectorAll('.res-step').forEach((el) => el.classList.add('hidden'));
    document.querySelector('.reservation-buttons')?.classList.add('hidden');
}

if (isLoggedIn) {
    try {
        const { data: blockInfo } = await supabase.rpc('get_booking_block_reason');
        if (blockInfo?.blocked) showBookingBlockNotice(blockInfo);
    } catch { /* fail open — the DB triggers still enforce this at submit */ }
}

// Fetched and awaited here, before anything else runs, so it's always
// resolved by the time showStep(cur) below can reach the offsite venue
// picker — a restored draft that already has offsite selected calls
// buildAddonOrVenueStep() (and schedules initVenueMap() 150ms later)
// immediately on this very first showStep(), which previously beat a
// fetch that didn't even start until several statements after it.
try {
    const { data: mapSetting } = await supabase.from('system_settings').select('setting_value').eq('setting_key', 'venue_map_scope').maybeSingle();
    if (mapSetting?.setting_value) window.venueMapConfig = JSON.parse(mapSetting.setting_value);
} catch { /* non-critical — initVenueMap()'s own fallback defaults stand */ }

// ── State ──────────────────────────────────────────────────────────────
const S = {
    locationType: '',
    categoryId: '',
    miniPackage: null,
    // Onsite room selection (supabase/migrations/20261016_venue_capacity_and_selection.sql).
    // venueOptions is the current package's active mapped venues (package_venue
    // join venue); venueId is null until exactly resolved — either auto (one
    // option) or by the customer via the picker (more than one option).
    venueOptions: [],
    venueId: null,
    // Additional Per-Head (supabase/migrations/20261018_additional_per_head.sql)
    // — guests booked beyond the selected package's Max Guests, at that
    // package's configured per-head price. Only ever nonzero when the
    // package allows it; reset to 0 whenever the package/venue selection
    // changes (see resetAdditionalHeads()).
    additionalHeads: 0,
    snackAddon: null,
    offsitePackage: null,
    cateringCart: [],
    cateringActiveMain: null,
    cateringOpenSection: null,
    cateringGlobalPax: null,
    cateringPaxCustomizeOpen: {},
    guestCount: '',
    eventType: '',
    eventTypeOther: '',
    venueLocation: '',
    eventDate: '',
    time: '',
    name: '', phone: '', email: '', requests: '',
    // Contract step (rs7) progress — mirrors signatureState + the two consent
    // checkboxes so a refresh (or navigating back to Review and forward to
    // Contract again) doesn't force a re-scroll/re-sign/re-check. See
    // applyOrResetContractProgress() and refreshContractGatingUI().
    contractAgreementViewMethod: '',   // '' | 'scrolled_inline' | 'opened_full_view'
    contractSignatureMode: 'draw',     // 'draw' | 'type'
    contractSignatureDrawData: null,   // SignaturePad.toData() output (vector strokes, JSON-safe)
    contractSignatureTypedText: '',
    contractAgreementTermsChecked: false,
    contractAgreementEsignChecked: false
};

// Guest count is validated against the selected package's min_guests/max_guests.
const GUEST_COUNT_VALIDATION_ENABLED = true;

// ── Event types cache (populated by loadEventTypes) ────────────────────
let eventTypesCache = [];

// ── Package + category data (populated by loadPackages) ────────────────
// Categories now come from the real package_category table (via the
// embedded relation in the package select below) instead of the old
// hardcoded OFFSITE_CATS array / name-substring bucketing. MINI/OFFSITE_ALL
// stay as flat lists (applyUrlParams needs to search across all packages
// regardless of category); the *_BY_CAT maps group them per category id
// for the grids.
let MINI            = [];
let SNACK           = [];
let OFFSITE_ALL     = [];
let MINI_BY_CAT     = {};
let OFFSITE_BY_CAT  = {};
let ONSITE_CATEGORIES  = []; // [{ id, name, count }]
let OFFSITE_CATEGORIES = []; // [{ id, name, count }]

// ── Service charge (populated by loadServiceChargeSettings + loadPackages) ──
// Resolution: offsite bookings are 0% UNLESS the admin has turned on
// SERVICE_CHARGE_APPLIES_OFFSITE (Payment Settings), in which case offsite
// resolves exactly like onsite — coalesce(category override, global
// default). Categories don't map to location (onsite/offsite/both packages
// share categories), so location is checked first, not derived from
// category structure. Applies to basePrice only (package + add-ons) — there
// is no separate travel-fee amount computed anywhere in this app to include
// or exclude, so nothing is carved out on that basis. See
// resolveServiceCharge() below.
let GLOBAL_SERVICE_CHARGE_PCT = 10;
let SERVICE_CHARGE_APPLIES_OFFSITE = false; // safe default: unchanged current behaviour until the admin opts in
let CATEGORY_SERVICE_CHARGE_PCT = {}; // categoryId -> percent or null (null = inherit)

function resolveServiceCharge(basePrice, locationType, categoryId) {
    const pct = (locationType === 'offsite' && !SERVICE_CHARGE_APPLIES_OFFSITE)
        ? 0
        : (CATEGORY_SERVICE_CHARGE_PCT[categoryId] ?? GLOBAL_SERVICE_CHARGE_PCT);
    const amount = Math.round(basePrice * pct) / 100;
    return { pct, amount, total: basePrice + amount };
}

// Re-evaluated against the current clock every time it's called (not
// cached from page-load) — a promo's window could open or close mid-session
// between Step 1 selection and final submit. Only ever applies to a real
// package/tier price, never add-ons, travel fee, or the catering cart.
function getPkgDiscount(pkg) {
    return applyDiscount(pkg?.price, pickActiveDiscount(pkg?.discountRows));
}

// Category name → icon (mirrors js/packages.js's getCategoryIcon so the
// category chip here matches the public Packages page visually).
function getCategoryIcon(name) {
    const n = (name || '').toLowerCase();
    if (/coffee.*bar|coffee/i.test(n)) return 'ti-coffee';
    if (/snack.*bar|snack/i.test(n))   return 'ti-cookie';
    if (/gather|private/i.test(n))     return 'ti-users';
    if (/cater/i.test(n))              return 'ti-tools-kitchen-2';
    if (/all.?in/i.test(n))            return 'ti-stars';
    if (/grazing/i.test(n))            return 'ti-grape';
    return 'ti-package';
}

// Whether a package drives the customer-facing dish-builder wizard is a
// standalone per-package flag (uses_catering_menu, set in Bookable
// Inventory) — independent of the package's category name or location
// type. This intentionally does NOT mirror the enforce_reservation_
// capacity() DB trigger, which still detects catering by package *name*
// server-side; that's a separate, unrelated concern this front-end fix
// doesn't touch.
function isCateringPackage(pkg) {
    return !!pkg?.usesCateringMenu;
}

// The package currently selected for whichever location type is active —
// S.miniPackage for onsite, S.offsitePackage for offsite. The catering
// wizard is driven off this (not off S.offsitePackage alone) so a
// catering-flagged package shows its dish builder regardless of whether
// it's booked onsite or offsite, per isCateringPackage()'s own "location
// type" independence above.
function getActivePackage() {
    return S.locationType === 'onsite' ? S.miniPackage : S.offsitePackage;
}

// ── Step order ─────────────────────────────────────────────────────────
// rs1 = single Event Information page (Location → Category → Package →
// Guests+Type → Add-ons/Venue → Date → Time). NOTE: this entire flow —
// now 7 conceptual sub-sections — still renders under one "Step 1 of 4".
// Flagging for a future revisit (splitting rs1 into multiple real steps)
// per product review; no functional change made here.
const STEP_IDS = ['rs1', 'rs4', 'rs6', 'rs7'];
const STEP_LABELS = ['Event Information', 'Your Details', 'Review', 'Contract'];
let cur = 1;
function total() { return STEP_IDS.length; }
function sid(n)  { return STEP_IDS[n - 1]; }

// ── Draft ──────────────────────────────────────────────────────────────
// localStorage (not sessionStorage) so a draft survives the customer
// fully closing the tab/browser, not just an accidental refresh.
//
// Scoped per logged-in user (not a single shared key) so that on a shared
// or public device, one account's in-progress reservation can never surface
// as a "resume?" prompt for a different account that later opens this page.
// Guests get no DRAFT_KEY at all (null) — anonymous browsing has no stable
// identity to scope a key to, so a guest either would leak someone else's
// draft or have their own draft picked up by the next guest on the same
// browser. Every draft read/write below is a no-op when DRAFT_KEY is null,
// which means: guests never get offered "resume", full stop.
const DRAFT_KEY = session?.user?.id ? `eli_reservation_draft_${session.user.id}` : null;
const DRAFT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days 

// Set the instant submission succeeds (see the reservation-submit handler).
// window.addEventListener('pagehide', saveDraft) below fires unconditionally
// on tab close/navigation — including the moment right after a successful
// submit, since this page shows its "Reservation Submitted!" message in
// place rather than navigating away. Without this flag, that pagehide would
// silently re-write S (still fully populated in memory) back into
// localStorage a few ms after clearDraft() ran, undoing it — a customer who
// just submitted successfully would still get the resume prompt next visit.
let submissionLocked = false;

function saveDraft() {
    if (submissionLocked || !DRAFT_KEY) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ state: S, step: cur, savedAt: Date.now() })); } catch { /* ignore */ }
}

function clearDraft() {
    if (!DRAFT_KEY) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// A draft is only worth offering to "resume" if the customer actually made
// progress — otherwise saveDraft()'s unconditional pagehide/visibilitychange
// save (see below) would trigger the resume prompt for someone who opened
// the page, selected nothing, and immediately left.
// A draft is only worth offering to "resume" if the customer actually made
// progress — otherwise saveDraft()'s unconditional pagehide/visibilitychange
// save (see below) would trigger the resume prompt for someone who opened
// the page, selected nothing, and immediately left. name/phone/email are
// deliberately excluded: prefillReservationContactDetails() auto-fills all
// three from the logged-in customer's profile on every visit with zero
// action from them, so their mere presence proves nothing about whether
// the booking flow itself was touched — counting them made the prompt fire
// for a customer who never chose anything. requests has no such
// auto-fill and stays a valid signal.
function draftHasMeaningfulProgress(saved, step) {
    if (typeof step === 'number' && step > 1) return true;
    const s = saved || {};
    return Boolean(
        s.locationType ||
        s.categoryId ||
        s.miniPackage ||
        s.snackAddon ||
        s.offsitePackage ||
        (Array.isArray(s.cateringCart) && s.cateringCart.length) ||
        s.guestCount ||
        s.eventType ||
        s.eventTypeOther ||
        s.venueLocation ||
        s.eventDate ||
        s.time ||
        s.requests
    );
}

// Reads the saved draft without applying it, so the resume-prompt modal
// can decide whether to appear before anything is mutated. Returns null
// if there's no draft, it's malformed, it's past DRAFT_MAX_AGE_MS, or
// nothing meaningful was actually filled in.
function peekDraft() {
    if (!DRAFT_KEY) return null;
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.state || typeof parsed.step !== 'number') return null;
        if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS) return null;
        if (!draftHasMeaningfulProgress(parsed.state, parsed.step)) return null;
        return parsed;
    } catch { return null; }
}

function restoreDraft() {
    if (!DRAFT_KEY) return false;
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return false;
        const { state: saved, step: savedStep } = JSON.parse(raw);
        if (!saved || typeof savedStep !== 'number') return false;

        Object.assign(S, saved);
        // Clamp to valid range; any step > total() resets to 1
        cur = (typeof savedStep === 'number' && savedStep >= 1 && savedStep <= total()) ? savedStep : 1;

        const gcEl = document.getElementById('guest-count');
        if (gcEl && S.guestCount) gcEl.value = S.guestCount;

        const nameEl = document.getElementById('name');
        if (nameEl && S.name) nameEl.value = S.name;
        const phoneEl = document.getElementById('phone');
        if (phoneEl && S.phone) phoneEl.value = S.phone;
        const emailEl = document.getElementById('email');
        if (emailEl && S.email) emailEl.value = S.email;
        const reqEl = document.getElementById('requests');
        if (reqEl && S.requests) reqEl.value = S.requests;

        if (S.locationType) {
            document.querySelectorAll('.location-card').forEach(c => {
                c.classList.toggle('active', c.dataset.val === S.locationType);
            });
        }

        if (S.eventDate) syncSelectedDate(S.eventDate);

        if (S.eventTypeOther) {
            const otherInput = document.getElementById('event-type-other');
            if (otherInput) otherInput.value = S.eventTypeOther;
        }

        return true;
    } catch { return false; }
}

// ── DOM refs ───────────────────────────────────────────────────────────
const eventDateInput          = document.getElementById('event-date');
const eventDateDisplayInput   = document.getElementById('event-date-display');
const nameInput               = document.getElementById('name');
const phoneInput              = document.getElementById('phone');
attachPhoneMask(phoneInput);
const emailInput              = document.getElementById('email');
const availabilityGrid        = document.getElementById('availabilityGrid');
const availabilityMonthLabel  = document.getElementById('availabilityMonthLabel');
const availabilityMessage     = document.getElementById('availabilityMessage');
const availabilityClosureNote = document.getElementById('availabilityClosureNote');
const availabilityClosureLabel = document.getElementById('availabilityClosureLabel');
const availabilityClosureCopy = document.getElementById('availabilityClosureCopy');
const availabilityPrevMonthBtn = document.getElementById('availabilityPrevMonth');
const availabilityNextMonthBtn = document.getElementById('availabilityNextMonth');
const timeStatusNote          = document.getElementById('time-status-note');
const timeEndReadout          = document.getElementById('time-end-readout');
const contractViewer          = document.getElementById('contract-viewer');
const contractAgreementTerms  = document.getElementById('contract-agreement-terms');
const contractAgreementEsign  = document.getElementById('contract-agreement-esign');
const contractPolicyMessage   = document.getElementById('contract-policy-message');
const signatureStatus         = document.getElementById('signature-status');
const signatureCanvas         = document.getElementById('signature-canvas');
const signatureClearBtn       = document.getElementById('signature-clear-btn');
const signatureDrawPanel      = document.getElementById('signature-draw-panel');
const signatureTypePanel      = document.getElementById('signature-type-panel');
const signatureTypeInput      = document.getElementById('signature-type-input');
const signatureTypePreview    = document.getElementById('signature-type-preview');
const sigModeDrawBtn          = document.getElementById('sig-mode-draw');
const sigModeTypeBtn          = document.getElementById('sig-mode-type');
const signatureCapturedBadge  = document.getElementById('signature-captured-badge');
const signatureGuidePlaceholder = document.getElementById('signature-guide-placeholder');
const policyModalBackdrop     = document.getElementById('policy-modal-backdrop');
const draftResumeModalBackdrop = document.getElementById('draft-resume-modal-backdrop');
const draftResumeContinueBtn   = document.getElementById('draft-resume-continue-btn');
const draftResumeStartNewBtn   = document.getElementById('draft-resume-start-new-btn');
const policyModalTitle        = document.getElementById('policy-modal-title');
const policyModalContent      = document.getElementById('policy-modal-content');
const policyModalClose        = document.getElementById('policy-modal-close');
const policyModalDismiss      = document.getElementById('policy-modal-dismiss');
const policyModalAgree        = document.getElementById('policy-modal-agree');
const policyButtons           = document.querySelectorAll('[data-policy]');
const contractViewFullBtn     = document.getElementById('contract-view-full-btn');
const contractStep1Status     = document.getElementById('contract-step1-status');
const contractStep2Status     = document.getElementById('contract-step2-status');
const contractStep3Status     = document.getElementById('contract-step3-status');
const contractSectionConsent  = document.getElementById('contract-section-consent');
const contactConsolidatedNote = document.getElementById('contact-consolidated-note');
const agreementModalBackdrop  = document.getElementById('agreement-modal-backdrop');
const agreementModalTitle     = document.getElementById('agreement-modal-title');
const agreementModalBody      = document.getElementById('agreement-modal-body');
const agreementReadingColumn  = document.getElementById('agreement-reading-column');
const agreementModalCloseBtn        = document.getElementById('agreement-modal-close-btn');
const agreementModalFooterCloseBtn  = document.getElementById('agreement-modal-footer-close-btn');
const agreementModalFinishBtn       = document.getElementById('agreement-modal-finish-btn');

// ── Contact fields (Step 8 "Your details") ─────────────────────────────
// Name is locked to the logged-in account's name — there's no path within
// this booking flow to change it (that lives on the My Account / Profile
// page). Guests get none of this: no account to lock the name to, so it
// stays a plain, freely-editable field exactly as before.
if (isLoggedIn && nameInput) {
    nameInput.readOnly = true;
    nameInput.setAttribute('aria-readonly', 'true');
    contactConsolidatedNote?.classList.remove('hidden');
}

// Brief loading state for Name/Phone/Email while the account fetch is in
// flight, so these never sit blank or show a placeholder value in the
// meantime.
function setContactFieldsLoading(isLoading) {
    [nameInput, phoneInput, emailInput].forEach(el => el?.classList.toggle('res-field-loading', isLoading));
}

// ── Signature state ────────────────────────────────────────────────────
const signatureState = {
    mode: 'draw',          // 'draw' | 'type'
    pad: null,             // SignaturePad instance
    contractLoaded: false,
    activeTemplateContractType: 'package_contract',
    agreementText: '',           // merged agreement text currently shown (also feeds the modal + PDF)
    agreementViewMethod: '',     // '' | 'scrolled_inline' | 'opened_full_view'
    agreementViewedAt: '',       // ISO timestamp once the gate is satisfied
    agreementModalLastFocus: null
};

// ── Availability state ─────────────────────────────────────────────────
const availabilityState = {
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    calendarAvailability: new Map(),
    closedDates: new Set(),
    blackoutDateColumn: null,
    blackoutReasonColumn: null,
    closedDateReasons: new Map(),
    selectedDateAvailability: null,
    timeStatusOverride: '',
    availableStartTimes: [],
};

// Booking window (min/max days from today, plus per-event-type overrides)
// — loaded via the same reservation_availability.js module the reschedule
// calendar (account.js) uses, so this page can never silently drift from
// it. Populated by loadReservationRules() below.
let advanceNoticeRules = null;

async function loadReservationRules() {
    advanceNoticeRules = await loadAdvanceNoticeRules(supabase);
}

async function loadServiceChargeSettings() {
    try {
        const { data, error } = await supabase
            .from('system_settings')
            .select('setting_value')
            .eq('setting_key', 'payment_rules')
            .maybeSingle();
        if (error || !data) return;
        const parsed = JSON.parse(data.setting_value);
        if (Number.isFinite(Number(parsed.service_charge_percent))) {
            GLOBAL_SERVICE_CHARGE_PCT = Number(parsed.service_charge_percent);
        }
        SERVICE_CHARGE_APPLIES_OFFSITE = !!parsed.service_charge_applies_offsite;
    } catch {
        // Keep the 10% / offsite-off fallback.
    }
}

// A selected event type can require more (or less) notice than the
// site-wide default (system_settings.reservation_rules.min_advance_days) —
// configured per event type in event_types.min_advance_days, null means
// "use the site-wide default." "Other" and no-selection-yet both fall
// back to the site-wide default.
function getEffectiveMinAdvanceDays() {
    return getSharedEffectiveMinAdvanceDays(advanceNoticeRules, S.eventType);
}

function isOutsideBookingWindow(date, today) {
    return sharedIsOutsideBookingWindow(date, today, advanceNoticeRules, S.eventType);
}

// Keeps the notice-period banner above the calendar in sync with the
// currently selected event type — generic until one is chosen, then states
// the actual applicable minimum so it isn't a vague, one-size-fits-all
// message. Called whenever the event-type select is (re)built, which
// covers the initial render, every change of event type, and a restored
// draft that already had one selected.
function updateMinNoticeBanner() {
    const textEl = document.getElementById('minNoticeBannerText');
    if (!textEl) return;
    if (!S.eventType) {
        textEl.textContent = 'Your event type sets its own minimum notice period — select one above to see the exact requirement. Dates shown here can change once you pick one.';
        return;
    }
    const label = S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType;
    const days = getEffectiveMinAdvanceDays();
    textEl.textContent = `${label} bookings require at least ${days} day${days === 1 ? '' : 's'}' notice. Dates within that window won't show as available below.`;
}

// Landing a customer on a calendar page that's entirely grey (every date
// either past or inside the minimum-advance-notice window — e.g. today
// is the 26th with a 14-day minimum, so the rest of this month can never
// have a bookable date) reads as broken, even though it's working as
// designed. Called on initial load AND every time the notice window can
// change (event type / location / package) — not on manual Prev/Next, so
// a customer who deliberately pages back can still see why a month is
// empty. Always restarts the scan from today's month rather than wherever
// the calendar currently sits: this function only ever pages FORWARD, so
// re-running it without resetting first would leave the calendar stuck on
// a later month forever once some earlier selection (e.g. an event type
// with a longer notice requirement) had paged it forward — even after the
// customer picks a shorter-notice event type that would make an earlier
// month bookable again. Bounded to 24 months so a misconfigured
// max_advance_days (e.g. 0) can't spin this forever.
function advanceToFirstBookableMonth() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    availabilityState.month = new Date(today.getFullYear(), today.getMonth(), 1);
    for (let guard = 0; guard < 24; guard++) {
        const monthStart = new Date(availabilityState.month.getFullYear(), availabilityState.month.getMonth(), 1);
        const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
        let hasBookableDay = false;
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(monthStart.getFullYear(), monthStart.getMonth(), d);
            if (!(date < today || isOutsideBookingWindow(date, today))) { hasBookableDay = true; break; }
        }
        if (hasBookableDay) return;
        availabilityState.month = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
    }
}

// ── Default contract body (used when a package has no active template) ─
// Mirrors the fallback text in supabase/functions/generate-signed-contract —
// this is just for the in-page preview; the edge function's copy is
// authoritative for the generated PDF.
const DEFAULT_CONTRACT_TEMPLATE_BODY =
`RESERVATION SERVICE AGREEMENT

This Reservation Service Agreement ("Agreement") is entered into between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client") for the event and package described below.

Reservation Number: {{reservation_number}}
Package: {{package_name}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Venue: {{venue}}
Guest Count: {{guest_count}}
Total Package Price: {{total_price}}

1. Booking Confirmation. This reservation is confirmed upon submission of this signed Agreement and payment of the applicable reservation fee or down payment as described in the Venue's Reservation Rules.

2. Cancellation and Rescheduling. Cancellation fees and rescheduling terms follow the Venue's published Cancellation and Rescheduling policies, which the Client has reviewed and agrees to as part of accepting the Terms and Conditions.

3. Client Responsibilities. The Client agrees to provide accurate event details, guest counts, and contact information, and to notify the Venue promptly of any changes to the reservation.

4. Electronic Signature. The Client acknowledges that this Agreement is being signed electronically, and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.`;

// ── Policy content ─────────────────────────────────────────────────────
const POLICY_CONTENT = {
    terms: {
        title: 'Terms & Conditions',
        sections: [
            { heading: '1. Reservation Agreement', paragraphs: ['By submitting a reservation, the customer confirms that all provided information is accurate and agrees to comply with the policies stated in this system. A reservation is considered pending until reviewed and approved by the administrator.'] },
            { heading: '2. Package and Services', paragraphs: ['The selected package includes the agreed services such as catering setup, food and beverage inclusions, event setup, and assigned staff. Specific inclusions depend on the chosen package and are displayed during the reservation process.', 'Additional costs such as crew meals and transportation fees may apply depending on the event location and requirements.'] },
            { heading: '3. Payment Terms', paragraphs: ['Reservations may be confirmed through any of the following:'], bullets: ['Full Payment', '50% Down Payment', 'Reservation Fee'], trailingParagraphs: ['Any reservation fee paid will be deducted from the total package amount. The remaining balance must be settled before the specified payment deadline.', 'All submitted payments are subject to verification by the administrator. Customers must provide accurate payment details and valid proof of payment.'] },
            { heading: '4. Non-Refundable Policy', paragraphs: ['All payments made are strictly non-refundable. Once a payment is submitted and verified, it cannot be reversed or refunded under any circumstances.'] },
            { heading: '5. Rescheduling Policy', paragraphs: ['Customers may request to reschedule their reservation depending on availability. A rescheduling fee of P3,000 will be required. The requested date must be available and is subject to approval by the administrator.'] },
            { heading: '6. Cancellation Policy', paragraphs: ['In the event of cancellation, all payments made will remain non-refundable. Cancellation requests may still be recorded in the system for documentation and administrative purposes.'] },
            { heading: '7. Contract Submission', paragraphs: ['Customers are required to submit a signed contract as part of the reservation process. The system may allow resubmission of contracts if revisions are requested by the administrator. Submitted contracts are subject to review and approval.'] },
            { heading: '8. Electronic Transactions and Signatures', paragraphs: ['This system complies with Republic Act No. 8792, also known as the Electronic Commerce Act of 2000, which recognizes the legal validity of electronic data messages, electronic documents, and electronic signatures.', 'All electronic records, including reservation details, submitted contracts, and uploaded documents, are considered legally binding and equivalent to their paper-based counterparts.', 'By submitting a reservation and signing the contract electronically, the customer acknowledges and agrees that their electronic signature represents their identity and intent to enter into a binding agreement with ELI Coffee Events.'] },
            { heading: '9. System Usage', paragraphs: ['By using this system, the customer agrees not to provide false information, misuse the platform, or submit invalid or fraudulent payment records. The administrator reserves the right to reject, cancel, or take appropriate action on reservations that violate system policies.'] },
            { heading: '10. Data Privacy', paragraphs: ['Customer information such as name, contact details, and uploaded documents will be securely stored and used solely for reservation processing, communication, and administrative purposes in accordance with applicable data privacy regulations.'] },
            { heading: '11. Agreement', paragraphs: ['By checking the agreement box and submitting the reservation, the customer confirms that they have read, understood, and agreed to all the terms and conditions stated above.'] }
        ]
    },
    privacy: {
        title: 'Data Privacy Policy',
        sections: [
            { heading: 'Policy Statement', paragraphs: ['ELI Coffee Events is committed to protecting the privacy and personal data of its users in accordance with Republic Act No. 10173, also known as the Data Privacy Act of 2012.'] },
            { heading: '1. Collection of Personal Data', paragraphs: ['The system collects personal information such as name, email address, phone number, and other relevant details provided during account registration, reservation, and payment submission. Uploaded files such as proof of payment and signed contracts are also collected as part of the reservation process.'] },
            { heading: '2. Purpose of Data Collection', paragraphs: ['Personal data is collected and used solely for the following purposes:'], bullets: ['Processing and managing reservations', 'Verifying payment submissions', 'Reviewing and validating contracts', 'Communicating with customers regarding their reservations', 'Maintaining records for administrative and operational purposes'] },
            { heading: '3. Data Storage and Security', paragraphs: ['All personal data and uploaded documents are securely stored using trusted third-party services. Reasonable organizational, physical, and technical security measures are implemented to protect data against unauthorized access, alteration, disclosure, or destruction.'] },
            { heading: '4. Data Sharing and Disclosure', paragraphs: ['Personal data will not be sold, shared, or disclosed to unauthorized third parties. Data may only be accessed by authorized personnel of ELI Coffee Events for operational and administrative purposes.'] },
            { heading: '5. Data Retention', paragraphs: ['Personal data will be retained only for as long as necessary to fulfill the purposes stated above or as required by applicable laws and regulations. Records related to reservations, payments, and contracts may be retained for documentation and audit purposes.'] },
            { heading: '6. User Rights', paragraphs: ['Users have the right to access, review, and request correction of their personal data stored in the system. Requests may be subject to verification and system limitations.'] },
            { heading: '7. Use of System', paragraphs: ['By using this system and submitting personal information, the user consents to the collection, use, and processing of their data in accordance with this policy.'] },
            { heading: '8. Contact and Inquiries', paragraphs: ['For any questions or concerns regarding data privacy, users may contact ELI Coffee Events through the provided contact channels.'] },
            { heading: '9. Policy Updates', paragraphs: ['This Data Privacy Policy may be updated from time to time. Continued use of the system constitutes acceptance of any changes made.'] }
        ]
    }
};

// Admin-editable overrides from admin/config/form.html — only replaces
// the hardcoded copy above when a non-empty saved body exists; on any
// fetch/parse failure this resolves to {} and POLICY_CONTENT above (the
// fallback) is left untouched.
const FORM_CONFIG = await loadReservationFormConfig(supabase);
if (FORM_CONFIG.policyOverrides.terms) POLICY_CONTENT.terms = FORM_CONFIG.policyOverrides.terms;
if (FORM_CONFIG.policyOverrides.privacy) POLICY_CONTENT.privacy = FORM_CONFIG.policyOverrides.privacy;

if (!FORM_CONFIG.fieldRules.contact_phone_required) {
    const phoneEl = document.getElementById('phone');
    if (phoneEl) phoneEl.placeholder = 'Phone Number (Optional)';
}
if (FORM_CONFIG.fieldRules.special_requests_required) {
    const requestsEl = document.getElementById('requests');
    if (requestsEl) requestsEl.placeholder = 'Notes & Special Requests';
}

let activePolicyKey = 'terms';

// ── Catering dish data ─────────────────────────────────────────────────
// Admin-editable via Bookable Inventory > Catering Menu (super_admin_packages.js),
// backed by public.catering_dish_category + public.catering_dish. Falls
// back to the old hardcoded menu only if that fetch fails, so the form
// never breaks outright on a DB hiccup.
const FALLBACK_DISHES = [
    { cat:'Chicken',    icon:'&#127831;', tag:'main',    required:true,  items:['Chicken ala King','Chicken Fillet w/ White Sauce','Garlic Butter Chicken'] },
    { cat:'Pork',       icon:'&#129385;', tag:'main',    required:true,  items:['Pork with Mushroom','Crunchy Pork','Pork Caldereta'] },
    { cat:'Beef',       icon:'&#129385;', tag:'main',    required:true,  items:['Beef Teriyaki','Beef Salpicao','Beef and Broccoli'] },
    { cat:'Fish',       icon:'&#128031;', tag:'main',      required:true,  items:['Fish Fillet with Tartar Sauce','Sweet and Sour Fish Fillet'] },
    { cat:'Vegetables', icon:'&#129382;', tag:'vegetable', required:true,  items:['Mixed Vegetables in Butter Corn and Carrots','Potato Marble'] },
    { cat:'Pasta',      icon:'&#127837;', tag:'pasta',     required:true,  items:['Spaghetti','Carbonara','Baked Macaroni','Tuna Pesto','Pancit Canton'] },
    { cat:'Dessert',    icon:'&#127854;', tag:'dessert',   required:true,  items:['Coffee Jelly','Buko Pandan','Mango Sago','Chocolate Mousse'] },
    { cat:'Rice',       icon:'&#127834;', tag:'rice',      required:false, items:['Steamed Rice'] }
];

const FALLBACK_PRICES = {
    Chicken:    {20:2700, 30:3800, 40:4800, 50:5900},
    Pork:       {20:2700, 30:3800, 40:4800, 50:5900},
    Beef:       {20:2700, 30:3800, 40:4800, 50:5900},
    Fish:       {20:2400, 30:3400, 40:4500, 50:5600},
    Vegetables: {20:2400, 30:3400, 40:4500, 50:5600},
    Pasta:      {20:2000, 30:2900, 40:3800, 50:4600},
    Dessert:    {20:1400, 30:2900, 40:2600, 50:3200},
    Rice:       {20:600,  30:900,  40:1200, 50:1500}
};

// Fallback cap on how many main-dish (protein) selections the buffet
// builder allows, used only when the package's own catering_main_dish_max
// hasn't loaded (e.g. DB fetch failed). The live value comes from the
// selected package's row — see getCateringMainDishMax().
const FALLBACK_MAIN_DISH_MAX = 3;

let DISHES = FALLBACK_DISHES;
let PRICES = FALLBACK_PRICES;

// Explicit per-section (tag) restrictions from public.catering_section_rule
// for the currently loaded package — { [tag]: { min, max } }. A tag with no
// row here (admin never added a restriction for it) falls back to the
// legacy derivation in getCateringSectionRule() below, so packages from
// before this table existed keep behaving exactly as they did.
let CATERING_SECTION_RULES = {};

// True when the currently-selected catering package has been checked
// against the DB and genuinely has no dish categories configured yet
// (Catering Menu admin shows "No categories yet" for it) — as opposed to
// simply not having loaded anything yet. Drives the "no menu available"
// notice in buildCateringDishBuilder() and blocks checkout in validate(),
// instead of silently substituting the generic FALLBACK_DISHES/PRICES
// menu for a package nobody actually configured.
let cateringMenuUnavailable = false;

// Tracks which package's menu is currently loaded into DISHES/PRICES so
// ensureCateringMenuLoaded() below can skip refetching on every re-render
// and only reload when the active catering package actually changes.
let cateringMenuLoadedForPkgId = null;

async function loadCateringMenu(packageId) {
    cateringMenuUnavailable = false;
    if (!packageId) return; // no catering-flagged package found — keep the fallback
    try {
        const [{ data: cats, error: catErr }, { data: dishRows, error: dishErr }, { data: ruleRows, error: ruleErr }] = await Promise.all([
            supabase.from('catering_dish_category').select('*').eq('is_active', true).eq('package_id', packageId).order('sort_order', { ascending: true }),
            supabase.from('catering_dish').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
            supabase.from('catering_section_rule').select('*').eq('package_id', packageId),
        ]);
        if (catErr) throw catErr;
        if (dishErr) throw dishErr;
        if (ruleErr) throw ruleErr;

        CATERING_SECTION_RULES = {};
        (ruleRows || []).forEach(r => { CATERING_SECTION_RULES[r.tag] = { min: r.min_select, max: r.max_select }; });

        if (!cats || !cats.length) {
            // This package genuinely has no dish categories configured in
            // Catering Menu admin yet — show it as unavailable rather than
            // quietly substituting the generic hardcoded menu (which the
            // admin never set up for this package and which would look
            // like a real, bookable menu). This also clears whatever a
            // *previously* selected catering package had loaded, so
            // switching into an unconfigured package never keeps showing
            // the old package's dishes and prices.
            DISHES = [];
            PRICES = {};
            cateringMenuUnavailable = true;
            return;
        }

        const dishesByCategory = {};
        (dishRows || []).forEach(d => {
            (dishesByCategory[d.category_id] ||= []).push(d.name);
        });

        DISHES = cats
            .filter(c => (dishesByCategory[c.category_id] || []).length > 0) // hide empty categories from the builder
            .map(c => ({
                cat: c.name,
                icon: c.icon || '&#127860;',
                tag: c.tag,
                required: !!c.is_required,
                items: dishesByCategory[c.category_id],
            }));

        PRICES = {};
        cats.forEach(c => { PRICES[c.name] = { 20: Number(c.price_20), 30: Number(c.price_30), 40: Number(c.price_40), 50: Number(c.price_50) }; });

        // Categories exist but every one of them filtered out above for
        // having zero active dishes — functionally the same "nothing to
        // show" case as no categories at all.
        if (!DISHES.length) cateringMenuUnavailable = true;
    } catch (err) {
        // A real fetch failure (DB hiccup), not "admin hasn't configured
        // this package yet" — keep the old safety-net fallback here so a
        // transient error doesn't strand every catering customer.
        console.warn('Failed to load catering menu from database, using fallback menu:', err);
        DISHES = FALLBACK_DISHES;
        PRICES = FALLBACK_PRICES;
        CATERING_SECTION_RULES = {};
    }
}

// Loads a specific catering-flagged package's dish menu into DISHES/
// PRICES, but only when it isn't already loaded — called every time a
// catering package becomes the active selection (category auto-resolve,
// package-card click, URL deep link, draft resume) so switching between
// two catering packages in the same category (or across categories)
// always shows that package's own menu, without refetching on every
// unrelated re-render of the same package.
async function ensureCateringMenuLoaded(pkg) {
    if (!pkg?.id || cateringMenuLoadedForPkgId === pkg.id) return;
    await loadCateringMenu(pkg.id);
    cateringMenuLoadedForPkgId = pkg.id;
}

// ── Utility ────────────────────────────────────────────────────────────
function pad(v) { return String(v).padStart(2, '0'); }

function toDateKey(date) {
    return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}

function fmtPeso(v) {
    return '₱' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDisplayDate(dateKey) {
    if (!dateKey) return '';
    const [year, month, day] = dateKey.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
}

// ── Guest-count validation, tied to the selected package's capacity ───
function getSelectedPackageMinGuests() {
    return (S.miniPackage || S.offsitePackage)?.min_guests ?? null;
}

function getSelectedPackageMaxGuests() {
    return (S.miniPackage || S.offsitePackage)?.max_guests ?? null;
}

function validateGuestCountRange(count) {
    if (!GUEST_COUNT_VALIDATION_ENABLED) return true;
    const min = getSelectedPackageMinGuests();
    const max = getSelectedPackageMaxGuests();
    if (min == null || max == null) return true;
    return count >= min && count <= max;
}

function updateGuestCountHint() {
    const hintEl = document.getElementById('guest-count-hint');
    if (!hintEl) return;
    const min = getSelectedPackageMinGuests();
    const max = getSelectedPackageMaxGuests();
    if (min == null || max == null) {
        hintEl.textContent = '';
        hintEl.classList.add('hidden');
        return;
    }
    hintEl.textContent = `Allowed: ${min}–${max} guests for this package.`;
    hintEl.classList.remove('hidden');
}

let guestNoticeTimer = null;
function showGuestCountAdjustedNotice() {
    const hintEl = document.getElementById('guest-count-hint');
    if (!hintEl) return;
    hintEl.textContent = "Adjusted to fit this package's guest limit.";
    hintEl.classList.remove('hidden');
    hintEl.classList.add('guest-count-hint--notice');
    clearTimeout(guestNoticeTimer);
    guestNoticeTimer = setTimeout(() => {
        hintEl.classList.remove('guest-count-hint--notice');
        updateGuestCountHint();
    }, 3000);
}

// Sets the native min/max on the input (covers stepper increment/decrement)
// and clamps any already-entered value that's now out of range — called
// whenever the selected package changes.
function clampGuestCountToSelection() {
    const gcEl = document.getElementById('guest-count');
    if (!gcEl) return;
    const min = getSelectedPackageMinGuests();
    const max = getSelectedPackageMaxGuests();
    gcEl.min = min != null ? String(min) : '1';
    if (max != null) gcEl.setAttribute('max', String(max));
    else gcEl.removeAttribute('max');

    const raw = gcEl.value.trim();
    updateGuestCountHint();
    if (!raw) return;
    let val = parseInt(raw, 10);
    if (Number.isNaN(val)) return;
    let adjusted = false;
    if (min != null && val < min) { val = min; adjusted = true; }
    if (max != null && val > max) { val = max; adjusted = true; }
    if (adjusted) {
        gcEl.value = String(val);
        S.guestCount = String(val);
        showGuestCountAdjustedNotice();
    }
}

document.getElementById('guest-count')?.addEventListener('input', function () {
    S.guestCount = this.value.trim();
});

document.getElementById('guest-count')?.addEventListener('blur', function () {
    const min = getSelectedPackageMinGuests();
    const max = getSelectedPackageMaxGuests();
    const raw = this.value.trim();
    if (!raw) return;
    let val = parseInt(raw, 10);
    if (Number.isNaN(val)) return;
    let adjusted = false;
    if (val < 1) { val = 1; adjusted = true; }
    if (min != null && val < min) { val = min; adjusted = true; }
    if (max != null && val > max) { val = max; adjusted = true; }
    this.value = String(val);
    S.guestCount = String(val);
    if (adjusted) showGuestCountAdjustedNotice();
});

// ── URL param entry handling ───────────────────────────────────────────
async function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const pkgId  = params.get('package');
    if (!pkgId) return false;

    // Compare as strings — package_id is a UUID so parseInt would return NaN
    const onsitePkg = MINI.find(p => String(p.id) === pkgId);
    if (onsitePkg) {
        S.locationType = 'onsite';
        S.categoryId   = onsitePkg.categoryId;
        S.miniPackage  = onsitePkg;
        // No card click happens for a pre-selected package (see the comment
        // at this function's call site) — resolve the room the same way
        // buildMiniGrid()'s onclick does, so a multi-venue package still
        // shows its picker instead of silently booking with no venue at all.
        await resolveVenueOptionsForPackage(onsitePkg);
        if (isCateringPackage(onsitePkg)) await ensureCateringMenuLoaded(onsitePkg);
        document.querySelectorAll('.location-card').forEach(c => {
            c.classList.toggle('active', c.dataset.val === 'onsite');
        });
        return true;
    }

    const offsitePkg = OFFSITE_ALL.find(p => String(p.id) === pkgId);
    if (offsitePkg) {
        S.locationType    = 'offsite';
        S.categoryId      = offsitePkg.categoryId;
        S.offsitePackage  = offsitePkg;
        if (isCateringPackage(offsitePkg)) await ensureCateringMenuLoaded(offsitePkg);
        document.querySelectorAll('.location-card').forEach(c => {
            c.classList.toggle('active', c.dataset.val === 'offsite');
        });
        return true;
    }

    // Package not found (archived or invalid ID) — fall back to empty form
    return false;
}

// ── Policy modal ───────────────────────────────────────────────────────
function setContractPolicyMessage(msg, tone = '') {
    if (!contractPolicyMessage) return;
    contractPolicyMessage.textContent = msg;
    contractPolicyMessage.className = 'contract-inline-message' + (tone ? ` ${tone}` : '');
}

function renderPolicyContent(key) {
    const policy = POLICY_CONTENT[key];
    if (!policy) return;
    policyModalTitle.textContent = policy.title;
    policyModalContent.innerHTML = policy.sections.map(s => `
        <section class="policy-section">
            <h4>${s.heading}</h4>
            ${(s.paragraphs || []).map(p => `<p>${p}</p>`).join('')}
            ${s.bullets?.length ? `<ul>${s.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
            ${(s.trailingParagraphs || []).map(p => `<p>${p}</p>`).join('')}
        </section>`).join('');
}

function openPolicyModal(key) {
    activePolicyKey = key;
    renderPolicyContent(key);
    policyModalBackdrop.classList.remove('hidden');
    policyModalBackdrop.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
}

function closePolicyModal() {
    policyModalBackdrop.classList.add('hidden');
    policyModalBackdrop.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
}

// ── Warning modal ──────────────────────────────────────────────────────
function showWarningModal(message, title, type = 'warning') {
    showFeedbackModal({ type, title: title || 'Almost there', message });
}

function agreeToPolicies() {
    if (contractAgreementTerms) contractAgreementTerms.checked = true;
    setContractPolicyMessage('');
    closePolicyModal();
}

// ── Signature capture ───────────────────────────────────────────────────
function setSignatureStatus(msg, isError = false) {
    if (!signatureStatus) return;
    signatureStatus.textContent = msg;
    signatureStatus.classList.toggle('error', isError);
}

function resizeSignatureCanvas() {
    if (!signatureCanvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const rect = signatureCanvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const data = signatureState.pad && !signatureState.pad.isEmpty() ? signatureState.pad.toData() : null;
    signatureCanvas.width  = rect.width * ratio;
    signatureCanvas.height = rect.height * ratio;
    signatureCanvas.getContext('2d').scale(ratio, ratio);
    if (signatureState.pad) {
        signatureState.pad.clear();
        if (data) signatureState.pad.fromData(data);
    }
}

// Transparent background (not white) so the CSS-drawn baseline/X guide
// underneath (.signature-guide, a DOM sibling — see the markup) shows
// through wherever the customer hasn't drawn ink. The guide is never
// touched by SignaturePad's own clear()/resize repaints since it isn't
// part of the canvas bitmap at all.
function initSignaturePad() {
    if (!signatureCanvas || signatureState.pad || typeof SignaturePad === 'undefined') return;
    signatureState.pad = new SignaturePad(signatureCanvas, {
        backgroundColor: 'rgba(0,0,0,0)',
        penColor: 'rgb(42,20,8)'
    });
    // signature_pad v3+ dropped the onBegin/onEnd constructor options in
    // favor of real DOM-style events — passing them as options (the old
    // API) is silently ignored, no error, the callbacks just never fire.
    // That's exactly why drawing a signature never unlocked Step 3: the
    // one call to refreshContractGatingUI() that was supposed to run
    // after a stroke never happened, while Type-instead (a plain <input>
    // 'input' listener, unrelated to this library) worked fine.
    signatureState.pad.addEventListener('beginStroke', () => setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, false));
    signatureState.pad.addEventListener('endStroke', () => {
        S.contractSignatureDrawData = signatureState.pad.toData();
        refreshContractGatingUI();
    });
    resizeSignatureCanvas();
    window.addEventListener('resize', resizeSignatureCanvas);
}

function setSignatureGuidePlaceholderVisible(el, visible) {
    el?.classList.toggle('is-hidden', !visible);
}

// Single source of truth for every piece of UI that depends on "has the
// agreement been read" and/or "does a signature currently exist" — called
// any time either condition could have changed (scrolled/opened the full
// agreement, drew/typed/cleared a signature, switched Draw/Type mode).
// This is the actual fix for the reported "confirmed without signing"
// failure: both consent checkboxes are only ever enabled here, together,
// once both conditions hold — never individually, never early.
function refreshContractGatingUI() {
    const read = !!signatureState.agreementViewMethod;
    const signed = isSignaturePresent();
    const unlocked = read && signed;

    // Step 1 status — nothing shown until it's actually done (see
    // .contract-step-status:empty in css/reservations.css).
    if (contractStep1Status) {
        contractStep1Status.textContent = read ? 'Completed — you scrolled to the end' : '';
        contractStep1Status.className = 'contract-step-status' + (read ? ' is-complete' : '');
    }

    // Step 2 — the amber "Ready…" line and the green captured-signature
    // badge are mutually exclusive: only one is ever visible at a time.
    signatureCapturedBadge?.classList.toggle('is-hidden', !signed);
    if (contractStep2Status) {
        const ready = read && !signed;
        contractStep2Status.textContent = ready ? 'Ready — sign below to continue' : '';
        contractStep2Status.className = 'contract-step-status' + (ready ? ' is-ready' : '');
    }

    // Step 3 — both checkboxes share one gate. Genuinely disabled (not
    // just dimmed), and re-locked (auto-unchecked) the instant the
    // signature that unlocked them is no longer present — e.g. Clear.
    contractSectionConsent?.classList.toggle('is-locked', !unlocked);
    [[contractAgreementTerms, 'contractAgreementTermsChecked'], [contractAgreementEsign, 'contractAgreementEsignChecked']].forEach(([cb, key]) => {
        if (!cb) return;
        cb.disabled = !unlocked;
        if (!unlocked) { cb.checked = false; S[key] = false; }
    });
    if (contractStep3Status) {
        contractStep3Status.textContent = unlocked ? '' : 'Sign the contract above to unlock this step';
        contractStep3Status.className = 'contract-step-status' + (!unlocked ? ' is-locked' : '');
    }
}

// Shrinks the live cursive preview in steps until it fits the available
// width, rather than letting a long typed name run past the box (the
// preview's own overflow:hidden + ellipsis is the hard backstop if even
// the smallest step still doesn't fit).
const SIGNATURE_TYPE_FONT_MAX = 32;
const SIGNATURE_TYPE_FONT_MIN = 18;
function fitSignatureTypePreview() {
    if (!signatureTypePreview) return;
    let size = SIGNATURE_TYPE_FONT_MAX;
    signatureTypePreview.style.fontSize = `${size}px`;
    const maxWidth = signatureTypePreview.clientWidth;
    while (signatureTypePreview.scrollWidth > maxWidth && size > SIGNATURE_TYPE_FONT_MIN) {
        size -= 2;
        signatureTypePreview.style.fontSize = `${size}px`;
    }
}

function setSignatureMode(mode) {
    signatureState.mode = mode;
    sigModeDrawBtn?.classList.toggle('active', mode === 'draw');
    sigModeTypeBtn?.classList.toggle('active', mode === 'type');
    signatureDrawPanel?.classList.toggle('hidden', mode !== 'draw');
    signatureTypePanel?.classList.toggle('hidden', mode !== 'type');
    if (mode === 'draw') { initSignaturePad(); resizeSignatureCanvas(); }
    setSignatureStatus('');
    refreshContractGatingUI();
}

function isSignaturePresent() {
    if (signatureState.mode === 'draw') return !!signatureState.pad && !signatureState.pad.isEmpty();
    return !!(signatureTypeInput?.value || '').trim();
}

function getSignerName() {
    if (signatureState.mode === 'type') return (signatureTypeInput?.value || '').trim();
    return S.name || '';
}

function renderTypedSignatureToDataUrl(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2A1408';
    ctx.font = '56px "Dancing Script", cursive';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
}

// The live canvas is transparent (so the CSS baseline/X guide shows
// through while drawing — see initSignaturePad), but the submitted/signed
// contract's signature image must not be: composite it onto an opaque
// white background at export time, independent of how the canvas is
// styled for the drawing UX. Never touches the live pad/canvas.
function flattenSignatureOntoWhite(transparentDataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = transparentDataUrl;
    });
}

async function getSignatureDataUrl() {
    if (signatureState.mode === 'draw') {
        if (!signatureState.pad || signatureState.pad.isEmpty()) return null;
        try {
            return await flattenSignatureOntoWhite(signatureState.pad.toDataURL('image/png'));
        } catch {
            return signatureState.pad.toDataURL('image/png');
        }
    }
    const text = (signatureTypeInput?.value || '').trim();
    if (!text) return null;
    try { await document.fonts.load('56px "Dancing Script"'); } catch { /* fall back to default font */ }
    return renderTypedSignatureToDataUrl(text);
}

// ── Contract template (in-app, dynamically merged) ─────────────────────
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function getSelectedContractPackageId() {
    if (S.locationType === 'onsite') return S.miniPackage?.id || null;
    return S.offsitePackage?.id || null;
}

function getSelectedContractPackageLabel() {
    if (S.locationType === 'onsite') return S.miniPackage?.label || null;
    return S.offsitePackage?.label || null;
}

// Same package-only rule as buildSummary(): catering has no single
// package.price to discount, add-ons are never discounted.
function computeContractPreviewDiscount() {
    if (isCateringPackage(getActivePackage())) return getPkgDiscount(null);
    if (S.locationType === 'onsite') return getPkgDiscount(S.miniPackage);
    return getPkgDiscount(S.offsitePackage);
}

// Additional Per-Head (supabase/migrations/20261018_additional_per_head.sql)
// — same package-only rule as computeContractPreviewDiscount(): catering
// has no single package to attach this to.
function computeContractPreviewAdditionalHeadCharge() {
    const pkg = getSelectedPackageForAdditionalHead();
    if (!pkg?.allowAdditionalHead || isCateringPackage(getActivePackage())) return 0;
    return (S.additionalHeads || 0) * Number(pkg.pricePerAdditionalHead || 0);
}

function computeContractPreviewBase() {
    let base;
    if (isCateringPackage(getActivePackage())) {
        base = S.cateringCart.filter(i => i && i.pax).reduce((sum, i) => sum + i.price, 0);
    } else if (S.locationType === 'onsite') {
        base = (S.miniPackage ? S.miniPackage.price : 0) + (S.snackAddon ? S.snackAddon.price : 0);
    } else {
        base = S.offsitePackage ? S.offsitePackage.price : 0;
    }
    base += computeContractPreviewAdditionalHeadCharge();
    // Discount reduces the base before the service charge, same ordering
    // as buildSummary() — so the pre-submit contract preview matches the
    // final breakdown the customer sees on the Review step.
    return base - computeContractPreviewDiscount().discountAmount;
}

// Same order of operations as buildSummary()/the submit handler: the
// service charge is added to the (already discounted) base to reach the
// total the customer actually signs for — never the pre-charge figure.
function computeContractPreviewCharge() {
    return resolveServiceCharge(computeContractPreviewBase(), S.locationType, S.categoryId);
}

function mergeTemplateTokens(template, data) {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (data[key] ?? ''));
}

// template_body has no explicit structural markup — every real row is
// plain text: a title, an intro paragraph, a "Label: Value" reservation
// summary block, then numbered clauses ("1. Heading. Body..."). Splits at
// the first numbered-clause line, so callers can keep the authored
// title/intro/summary prose as-is while replacing everything from the
// clauses onward with the live, admin-editable clause set (BUG-03 fix) —
// or, when no contract_template_clause rows exist yet for this package,
// fall back to whatever numbered clauses the template_body already has
// (same legacy-fallback behavior as the signed-PDF edge function).
function splitTemplateIntroAndLegacyClauses(templateBody) {
    const lines = String(templateBody || '').split('\n');
    const isClauseLine = l => /^\s*\d+\.\s+\S/.test(l);
    // "Label: Value" — same pattern the full-screen modal's own
    // parseAgreementSections() uses to recognize a reservation-summary
    // block. The intro must stop here too, not just at the first numbered
    // clause — every real template_body hardcodes its own "Reservation
    // Number: ... / Package: ..." block right after the opening paragraph,
    // and buildSummaryLinesText() below rebuilds that same block from the
    // live contract_field rows; without this second cutoff the two would
    // stack into a visibly duplicated summary.
    const isDetailLine = l => /^([A-Za-z][A-Za-z\s]{1,40}):\s*(.+)$/.test(l.trim());
    const introCutIdx = lines.findIndex(l => isClauseLine(l) || isDetailLine(l));
    const firstClauseIdx = lines.findIndex(isClauseLine);
    return {
        introText: introCutIdx === -1 ? (templateBody || '') : lines.slice(0, introCutIdx).join('\n').replace(/\n+$/, ''),
        legacyClausesText: firstClauseIdx === -1 ? '' : lines.slice(firstClauseIdx).join('\n')
    };
}

// Reservation Summary — Layer 1, built from the same contract_field rows
// (visibility/label/order) the admin's own preview uses, instead of the
// fixed set of lines a template_body happens to have hardcoded. "Label:
// Value" lines are what both the inline preview and the full-screen
// modal's parseAgreementSections() already recognize as a definition-list
// block, so no changes are needed there.
function buildSummaryLinesText(fields, data) {
    return fields
        .filter(f => f.is_visible !== false)
        .map(f => `${f.label}: ${data[f.token] ?? ''}`)
        .join('\n');
}

// Numbered clauses — Layer 2, built from contract_template_clause when the
// admin has saved any for this package; heading and body both go through
// the same token merge as everything else, so a clause referencing
// {{cancellation_fee}} etc. resolves correctly instead of rendering blank.
function buildClausesText(clauses, data, startNumber) {
    return clauses.map((c, i) => {
        const heading = mergeTemplateTokens(c.heading || '', data);
        const body = mergeTemplateTokens(c.body || '', data);
        return `${startNumber + i}. ${heading}.\n${body}`;
    }).join('\n\n');
}

function renderContractBody(templateBody, contractData = {}) {
    if (!contractViewer) return '';
    const { clauses = [], lockedClauses = {}, fields = [], feeTerms = {} } = contractData;
    const charge = computeContractPreviewCharge();
    const discount = computeContractPreviewDiscount();
    const previewAdditionalHeadCharge = computeContractPreviewAdditionalHeadCharge();
    const isOffsite = S.locationType === 'offsite';
    const data = {
        customer_name: S.name || 'Customer',
        package_name: getSelectedContractPackageLabel() || 'Selected Package',
        event_type: (S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType) || 'TBD',
        event_date: formatDisplayDate(S.eventDate) || 'TBD',
        event_time: S.time || 'TBD',
        venue: S.locationType === 'offsite' ? (S.venueLocation || 'Customer-provided venue') : 'ELI Coffee Events Cafe Binangonan (Onsite)',
        reservation_number: 'Assigned upon submission',
        total_price: fmtPeso(charge.total),
        service_charge_percent: String(charge.pct),
        service_charge_amount: fmtPeso(charge.amount),
        discount_percent: discount.active ? String(discount.percentOff) : '',
        discount_amount: discount.active ? fmtPeso(discount.discountAmount) : '',
        discount_label: discount.active ? (discount.label || '') : '',
        additional_heads: previewAdditionalHeadCharge > 0 ? String(S.additionalHeads) : '',
        additional_head_price: previewAdditionalHeadCharge > 0 ? fmtPeso(getSelectedPackageForAdditionalHead()?.pricePerAdditionalHead || 0) : '',
        additional_head_charge: previewAdditionalHeadCharge > 0 ? fmtPeso(previewAdditionalHeadCharge) : '',
        guest_count: previewAdditionalHeadCharge > 0
            ? String(Number(getSelectedPackageForAdditionalHead()?.max_guests || S.guestCount) + S.additionalHeads)
            : (S.guestCount || ''),
        // Same live system_settings/payment_type sources the admin's own
        // preview and the final signed PDF use — previously missing here
        // entirely, so any clause referencing one of these five tokens
        // silently rendered blank instead of matching what's shown
        // everywhere else (the second half of BUG-03).
        reschedule_fee: fmtPeso(feeTerms.rescheduleFee ?? 3000),
        cancellation_fee: fmtPeso(isOffsite ? (feeTerms.cancellationFeeOffsite ?? 2000) : (feeTerms.cancellationFeeOnsite ?? 500)),
        deposit_percent: String(feeTerms.depositPercent ?? 50),
        terms_and_conditions: feeTerms.termsAndConditions || '(See the Terms & Conditions page.)',
        data_privacy_policy: feeTerms.dataPrivacyPolicy || '(See the Data Privacy Policy page.)'
    };

    const { introText, legacyClausesText } = splitTemplateIntroAndLegacyClauses(templateBody);
    const summaryText = buildSummaryLinesText(fields, data);

    // Layer 3 (Electronic Signature / acknowledgement) is only appended
    // when real admin-saved clauses (Layer 2) are in use. The legacy
    // template_body fallback below is old, self-contained plain text — it
    // already ends with its own Electronic Signature clause and closing
    // "By signing below..." sentence (see DEFAULT_CONTRACT_TEMPLATE_BODY),
    // so appending Layer 3 on top of it would duplicate that content
    // rather than replace it. Matches the signed-PDF edge function's own
    // "templateClauses.length ? real clauses + Layer 3 : legacy text as-is"
    // branch exactly.
    const usingRealClauses = clauses.length > 0;
    const clausesText = usingRealClauses
        ? buildClausesText(clauses, data, 1)
        : mergeTemplateTokens(legacyClausesText, data);

    const esClause = lockedClauses.electronic_signature;
    const esText = (usingRealClauses && esClause)
        ? buildClausesText([esClause], data, clauses.length + 1)
        : '';

    const ackClause = lockedClauses.acknowledgement;
    const ackText = (usingRealClauses && ackClause) ? mergeTemplateTokens(ackClause.body || '', data) : '';

    const sections = [
        mergeTemplateTokens(introText, data),
        summaryText,
        clausesText,
        esText,
        ackText
    ].filter(s => s && s.trim());
    const merged = sections.join('\n\n');

    // Numbered clause headings ("1. Title.") get the same heading styling
    // as an ALL-CAPS section header — matches the full-screen modal's own
    // heading detection (parseAgreementSections()) so both surfaces agree
    // on what's a heading, not just this compact box's own ALL-CAPS-only
    // heuristic from before.
    const numberedHeadingPattern = /^\d+\.\s+.+\.$/;
    let inTitleBlock = true;
    contractViewer.innerHTML = merged.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) {
            inTitleBlock = false;
            return '<div class="contract-viewer-gap"></div>';
        }
        const isAllCaps = /[A-Z]/.test(trimmed) && !/[a-z]/.test(trimmed);
        if (isAllCaps && inTitleBlock) {
            return `<p class="contract-viewer-title">${escapeHtml(trimmed)}</p>`;
        }
        inTitleBlock = false;
        if (isAllCaps || numberedHeadingPattern.test(trimmed)) {
            return `<p class="contract-viewer-heading">${escapeHtml(trimmed)}</p>`;
        }
        return `<p>${escapeHtml(trimmed)}</p>`;
    }).join('');
    return merged;
}

// ── Agreement read-gating ────────────────────────────────────────────────
// Both consent checkboxes stay disabled until we have real evidence the
// customer actually saw the agreement text (scrolled the inline preview
// to its end, or opened the full-screen reader) AND a signature currently
// exists — see refreshContractGatingUI(), the single place that actually
// applies this to the checkboxes/status lines.
function resetAgreementGating() {
    signatureState.agreementViewMethod = '';
    signatureState.agreementViewedAt = '';
    refreshContractGatingUI();
}

// Restores contract-step progress from S (persisted the same way as every
// other field — see saveDraft()/restoreDraft()) instead of unconditionally
// wiping it on every visit to this step. Fixes two related annoyances: a
// refresh losing "read the contract" + the signature + both checkboxes, and
// navigating back to Review and forward to Contract again within the same
// visit re-locking an already-completed step. Falls through to the original
// reset when there's genuinely nothing saved (first-ever visit this step).
function applyOrResetContractProgress() {
    const hasSavedProgress = !!S.contractAgreementViewMethod ||
        !!S.contractSignatureTypedText ||
        (Array.isArray(S.contractSignatureDrawData) && S.contractSignatureDrawData.length > 0);

    if (!hasSavedProgress) {
        resetAgreementGating();
        return;
    }

    // Captured up front, before anything below runs: setSignatureMode()
    // (called a few lines down to re-select the saved Draw/Type mode)
    // calls refreshContractGatingUI() internally the instant it's invoked
    // — at that exact moment the signature payload (typed text / drawn
    // strokes) hasn't been reapplied to the DOM/pad yet, so
    // isSignaturePresent() still reports "nothing signed", unlocked comes
    // out false, and refreshContractGatingUI()'s own force-uncheck branch
    // (the one that re-locks Step 3 the instant a signature disappears —
    // e.g. Clear) wipes S.contractAgreementTermsChecked/EsignChecked to
    // false right there, before this function ever gets a chance to read
    // them. Reading S up front, before that happens, is what actually
    // survives to the restore below — reading S again after the mode
    // switch would just read back the wiped-out false.
    const savedTermsChecked = !!S.contractAgreementTermsChecked;
    const savedEsignChecked = !!S.contractAgreementEsignChecked;

    signatureState.agreementViewMethod = S.contractAgreementViewMethod || '';
    signatureState.agreementViewedAt = signatureState.agreementViewMethod ? new Date().toISOString() : '';

    if (S.contractSignatureMode === 'type') {
        setSignatureMode('type');
        if (signatureTypeInput) signatureTypeInput.value = S.contractSignatureTypedText || '';
        if (signatureTypePreview) signatureTypePreview.textContent = (S.contractSignatureTypedText || '').trim();
        fitSignatureTypePreview();
        if (S.contractSignatureTypedText) setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, false);
    } else {
        setSignatureMode('draw');
        if (Array.isArray(S.contractSignatureDrawData) && S.contractSignatureDrawData.length) {
            try {
                signatureState.pad?.fromData(S.contractSignatureDrawData);
                setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, false);
            } catch { /* corrupt/incompatible saved stroke data — customer just re-draws */ }
        }
    }

    // Restore from the captured values, not from S (see above) — by this
    // point both "read" and "signed" are true again, so the final
    // refreshContractGatingUI() call below only enables the checkboxes,
    // it never force-unchecks them.
    S.contractAgreementTermsChecked = savedTermsChecked;
    S.contractAgreementEsignChecked = savedEsignChecked;
    if (contractAgreementTerms) contractAgreementTerms.checked = savedTermsChecked;
    if (contractAgreementEsign) contractAgreementEsign.checked = savedEsignChecked;

    refreshContractGatingUI();
}

function markAgreementViewed(method) {
    if (signatureState.agreementViewMethod) return; // already satisfied
    signatureState.agreementViewMethod = method;
    signatureState.agreementViewedAt = new Date().toISOString();
    S.contractAgreementViewMethod = method;
    refreshContractGatingUI();
}

// Some agreements are short enough to fit the capped preview box with
// nothing to scroll — without this, those customers could never satisfy
// the "scrolled to the bottom" condition at all.
function checkInlinePreviewFits() {
    if (!contractViewer || signatureState.agreementViewMethod) return;
    if (contractViewer.scrollHeight <= contractViewer.clientHeight + 2) {
        markAgreementViewed('scrolled_inline');
    }
}

function showContractLoadError() {
    if (!contractViewer) return;
    contractViewer.innerHTML = `
        <p class="contract-viewer-loading contract-viewer-error">
            We couldn't load your agreement text right now.
            <button type="button" class="contract-retry-btn" id="contract-retry-btn">Retry</button>
        </p>
    `;
    document.getElementById('contract-retry-btn')?.addEventListener('click', buildContractStep);
}

async function buildContractStep() {
    if (!contractViewer) return;

    // "Draw" is the default active mode in the static HTML (no click
    // ever fires setSignatureMode('draw') on first arrival at this
    // step), so the SignaturePad instance was never actually created —
    // the canvas looked ready but had no pointer/touch capture wired up
    // at all, silently swallowing every stroke until the customer
    // switched to "Type instead" and back, which does call
    // setSignatureMode('draw'). initSignaturePad() is idempotent (bails
    // if a pad already exists), so this is safe to call on every visit
    // to this step without resetting an in-progress typed signature.
    initSignaturePad();

    const pkgId = getSelectedContractPackageId();

    signatureState.agreementText = '';
    signatureState.contractLoaded = false;
    applyOrResetContractProgress();

    if (!pkgId) {
        contractViewer.innerHTML = '<p class="contract-viewer-loading">Select a package first so the correct contract can be loaded.</p>';
        return;
    }

    contractViewer.innerHTML = '<p class="contract-viewer-loading">Loading your contract...</p>';

    // BUG-03 fix: fetch the exact same Layer 1/2/3 data + fee/terms tokens
    // the admin's own preview and the final signed PDF use (js/contract_
    // render.js), not just the flat template_body — see that module's doc
    // comment for the full story on why this step never used to show an
    // admin's saved clause/field edit.
    let tmpl = null, clauses = [], lockedClauses = {}, fields = [], feeTerms = {};
    try {
        const [templateData, feeTermsData] = await Promise.all([
            fetchContractTemplateData(supabase, pkgId),
            fetchContractFeeTermsTokens(supabase)
        ]);
        ({ template: tmpl, clauses, lockedClauses, fields } = templateData);
        feeTerms = feeTermsData;
    } catch (err) {
        showContractLoadError();
        return;
    }

    signatureState.activeTemplateContractType = tmpl?.contract_type || 'package_contract';
    signatureState.agreementText = renderContractBody(
        tmpl?.template_body || DEFAULT_CONTRACT_TEMPLATE_BODY,
        { clauses, lockedClauses, fields, feeTerms }
    );
    signatureState.contractLoaded = true;
    checkInlinePreviewFits();
}

// ── Full-screen agreement reader ───────────────────────────────────────
// Turns the flat, `\n`-separated agreement text into a heading hierarchy:
// the first line becomes the document title (h2), lines that open with
// "N. Title." (the convention every contract template + the fallback
// body follow) become sub-headings (h3), a run of consecutive
// "Label: Value" lines (Reservation Number, Package, Event Date, etc.)
// becomes a single definition-list block, and everything else stays a
// paragraph. Used by the modal renderer only.
function parseAgreementSections(text) {
    const lines = String(text || '').split('\n').map(l => l.trim());
    const blocks = [];
    let sawTitle = false;
    const detailLinePattern = /^([A-Za-z][A-Za-z\s]{1,40}):\s*(.+)$/;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (!line) { i++; continue; }

        if (!sawTitle) {
            sawTitle = true;
            blocks.push({ tag: 'h2', text: line });
            i++;
            continue;
        }

        const sectionMatch = line.match(/^(\d+)\.\s+([^.]{1,80})\.\s*(.*)$/);
        if (sectionMatch) {
            blocks.push({ tag: 'h3', text: `${sectionMatch[1]}. ${sectionMatch[2]}.` });
            if (sectionMatch[3]) blocks.push({ tag: 'p', text: sectionMatch[3] });
            i++;
            continue;
        }

        const detailMatch = line.match(detailLinePattern);
        if (detailMatch) {
            const rows = [];
            let j = i;
            while (j < lines.length) {
                const m = lines[j].match(detailLinePattern);
                if (!m) break;
                rows.push({ label: m[1].trim(), value: m[2].trim() });
                j++;
            }
            if (rows.length >= 2) {
                blocks.push({ tag: 'dl', rows });
                i = j;
                continue;
            }
        }

        blocks.push({ tag: 'p', text: line });
        i++;
    }

    return blocks;
}

function renderAgreementBlock(block) {
    if (block.tag === 'dl') {
        return `
            <dl class="agreement-detail-list">
                ${block.rows.map(row => `
                    <div class="agreement-detail-row">
                        <dt>${escapeHtml(row.label)}</dt>
                        <dd>${escapeHtml(row.value)}</dd>
                    </div>
                `).join('')}
            </dl>
        `;
    }
    return `<${block.tag}>${escapeHtml(block.text)}</${block.tag}>`;
}

function renderAgreementModalBody() {
    if (!agreementReadingColumn) return;
    const blocks = parseAgreementSections(signatureState.agreementText);
    agreementReadingColumn.innerHTML = blocks.map(renderAgreementBlock).join('');
}

function showAgreementModalError() {
    if (!agreementReadingColumn) return;
    agreementReadingColumn.innerHTML = `
        <p class="agreement-modal-error">
            We couldn't load the agreement text right now.
            <button type="button" class="contract-retry-btn" id="agreement-modal-retry-btn">Retry</button>
        </p>
    `;
    document.getElementById('agreement-modal-retry-btn')?.addEventListener('click', async () => {
        await buildContractStep();
        if (signatureState.agreementText) {
            renderAgreementModalBody();
            markAgreementViewed('opened_full_view');
        } else {
            showAgreementModalError();
        }
    });
}

function getAgreementModalFocusable() {
    if (!agreementModalBackdrop) return [];
    return Array.from(agreementModalBackdrop.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter(el => !el.disabled && el.offsetParent !== null);
}

function handleAgreementModalKeydown(event) {
    if (!agreementModalBackdrop || agreementModalBackdrop.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        closeAgreementModal();
        return;
    }

    if (event.key !== 'Tab') return;
    const focusable = getAgreementModalFocusable();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function openAgreementModal() {
    if (!agreementModalBackdrop) return;

    // Previously read from #contract-title in the (now-removed) redundant
    // icon/title/caption row above the preview box — that row duplicated
    // the "1. Read the contract" heading and the contract's own title
    // text inside the scroll box, so it's gone, but the modal still needs
    // a header title. This isn't package-specific data, just the site's
    // one contract name, so it's hardcoded here instead of read from a
    // DOM element kept around only to feed this.
    if (agreementModalTitle) {
        agreementModalTitle.textContent = 'ELI Coffee Events Reservation Contract';
    }

    if (signatureState.agreementText) {
        renderAgreementModalBody();
        markAgreementViewed('opened_full_view');
    } else {
        showAgreementModalError();
    }

    signatureState.agreementModalLastFocus = document.activeElement;
    agreementModalBackdrop.classList.remove('hidden');
    agreementModalBackdrop.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
    document.addEventListener('keydown', handleAgreementModalKeydown);

    const focusable = getAgreementModalFocusable();
    (focusable[0] || agreementModalBackdrop).focus();
}

function closeAgreementModal() {
    if (!agreementModalBackdrop) return;
    agreementModalBackdrop.classList.add('hidden');
    agreementModalBackdrop.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
    document.removeEventListener('keydown', handleAgreementModalKeydown);
    (signatureState.agreementModalLastFocus || contractViewFullBtn)?.focus();
}

// ── Availability helpers ───────────────────────────────────────────────
function setAvailabilityMessage(msg, isError = false) {
    if (!availabilityMessage) return;
    availabilityMessage.textContent = msg;
    availabilityMessage.classList.toggle('error', isError);
}

function setTimeStatusOverride(msg = '') {
    availabilityState.timeStatusOverride = String(msg || '').trim();
}

function setClosedDateNotice(dateKey = '', reason = '') {
    if (!availabilityClosureNote || !availabilityClosureCopy) return;
    if (!dateKey) { availabilityClosureNote.classList.add('hidden'); availabilityClosureCopy.textContent = ''; return; }
    if (availabilityClosureLabel) availabilityClosureLabel.textContent = `Date unavailable${dateKey ? ': ' + formatDisplayDate(dateKey) : ''}`;
    availabilityClosureCopy.textContent = reason ? `This date is unavailable due to: ${reason}.` : 'This date is currently unavailable for booking.';
    availabilityClosureNote.classList.remove('hidden');
}

function syncSelectedDate(dateKey) {
    if (!eventDateInput) return;
    eventDateInput.value = dateKey || '';
    if (eventDateDisplayInput) eventDateDisplayInput.value = dateKey ? formatDisplayDate(dateKey) : '';
    S.eventDate = dateKey || '';
    if (dateKey) setClosedDateNotice('', '');
}

function updateDateDisplayPlaceholder() {
    if (!eventDateDisplayInput) return;
    eventDateDisplayInput.placeholder = getSelectedBookingScope()
        ? 'Select a date from the availability calendar below *'
        : 'Choose your location and package first, then select a date *';
}

// Always an array (or null) — see getBookingScope()'s own doc comment in
// reservation_availability.js for why (a combo "Plus" package occupies
// more than one scope at once).
function getSelectedBookingScope() {
    if (!S.locationType) return null;
    if (S.locationType === 'offsite') {
        if (!S.categoryId) return null;
        if (!S.offsitePackage) return null;
        return ['offsite'];
    }
    return getSharedBookingScope(S.locationType, S.miniPackage?.label || '', S.miniPackage?.bookingScope || null);
}

function getSelectedDurationHours() {
    if (isCateringPackage(getActivePackage())) return Number(getActivePackage().durationHours || 0) || 4;
    if (S.locationType === 'onsite') return Number(S.miniPackage?.durationHours || 0) || null;
    return Number(S.offsitePackage?.durationHours || 0) || null;
}

// The actual selected package/category name — used in time-slot messaging
// instead of getScopeLabel()'s coarse VIP/Main Hall/Off-site bucket, which
// previously produced a generic or outright wrong label (e.g. always
// "VIP" for any onsite scope) regardless of which package was chosen.
function getSelectedPackageOrCategoryLabel() {
    if (S.locationType === 'onsite' && S.miniPackage) return S.miniPackage.label;
    if (S.offsitePackage) return S.offsitePackage.label;
    return null;
}

function getScopeSelectionPrompt() {
    if (!S.locationType) return 'Choose your location type and package first to unlock dates for your booking.';
    if (S.locationType === 'onsite' && !S.miniPackage) return 'Choose an onsite package first to unlock VIP or Main Hall dates.';
    if (S.locationType === 'offsite' && !S.categoryId) return 'Choose your offsite service first to unlock dates.';
    if (S.locationType === 'offsite' && !S.offsitePackage) return 'Choose an offsite package first to unlock dates.';
    return 'Choose an available date for your booking.';
}

function getDateAvailability(dateKey) {
    return availabilityState.calendarAvailability.get(dateKey) || {
        eventDate: dateKey, occupiedScopes: [], isFullyBooked: false, scopeTaken: false, blockedTimes: []
    };
}

function isDateUnavailableForScope(dateKey, scope) {
    if (!dateKey) return false;
    if (availabilityState.closedDates.has(dateKey)) return true;
    const { occupiedScopes, isFullyBooked } = getDateAvailability(dateKey);
    // get_booking_calendar_availability()'s own is_fully_booked only goes
    // true once ALL THREE scopes (onsite_vip/onsite_main_hall/offsite) are
    // exhausted for that date — correct for a "nothing at all is bookable
    // here" signal, but wrong for THIS customer's specific scope, which can
    // be full on its own while the other two scopes still have room. The
    // RPC already computes and ships the finer occupied_scopes array for
    // exactly this reason; it just wasn't being read here before, which let
    // the month-view calendar show a date as open when the customer's own
    // scope (e.g. VIP) was actually already at its daily cap — confirmed
    // live: the time-slot step correctly rejected it as fully booked while
    // the calendar month grid kept showing it as available.
    const scopes = (Array.isArray(scope) ? scope : [scope]).filter(Boolean);
    if (!scopes.length) return isFullyBooked;
    return isFullyBooked || scopes.some((s) => occupiedScopes.includes(s));
}

function isUnavailableDate(dateKey) {
    return isDateUnavailableForScope(dateKey, getSelectedBookingScope());
}

async function refreshAvailabilityForSelectedScope() {
    const selectedScope = getSelectedBookingScope();
    updateDateDisplayPlaceholder();
    setTimeStatusOverride('');

    if (S.eventDate && (!selectedScope || isDateUnavailableForScope(S.eventDate, selectedScope))) {
        const conflictMsg = selectedScope
            ? 'This date is fully booked. Choose another available date to see time slots.'
            : getScopeSelectionPrompt();
        syncSelectedDate('');
        S.time = '';
        availabilityState.selectedDateAvailability = null;
        setAvailabilityMessage(conflictMsg, Boolean(selectedScope));
        setTimeStatusOverride(conflictMsg);
    }

    setClosedDateNotice('', '');
    await loadAvailabilityCalendar();
    buildTimeGrid();
}

function renderAvailabilityCalendar() {
    if (!availabilityGrid || !availabilityMonthLabel) return;

    const monthStart = new Date(availabilityState.month.getFullYear(), availabilityState.month.getMonth(), 1);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const currentMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const gridStart = new Date(monthStart);
    gridStart.setDate(monthStart.getDate() - monthStart.getDay());
    const selectedScope = getSelectedBookingScope();

    availabilityMonthLabel.textContent = availabilityState.month.toLocaleDateString('en-US', { month:'long', year:'numeric' });
    if (availabilityPrevMonthBtn) availabilityPrevMonthBtn.disabled = monthStart <= currentMonthStart;

    availabilityGrid.innerHTML = '';

    for (let i = 0; i < 42; i++) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + i);
        const dateKey = toDateKey(date);
        const isCurrentMonth = date.getMonth() === availabilityState.month.getMonth();
        const isPast = date < today || isOutsideBookingWindow(date, today);
        const isBooked = isDateUnavailableForScope(dateKey, selectedScope) && !availabilityState.closedDates.has(dateKey);
        const isClosed = availabilityState.closedDates.has(dateKey);
        const isSelected = eventDateInput?.value === dateKey;
        const isContextLocked = !selectedScope && !isBooked;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'availability-day';
        btn.textContent = String(date.getDate());

        if (!isCurrentMonth) {
            btn.classList.add('outside-month'); btn.disabled = true;
        } else if (isPast) {
            btn.classList.add('past'); btn.disabled = true;
        } else if (isClosed) {
            btn.classList.add('closed');
            btn.title = 'Click to view why this date is unavailable.';
            btn.addEventListener('click', () => {
                syncSelectedDate(''); S.time = ''; availabilityState.selectedDateAvailability = null;
                setClosedDateNotice(dateKey, availabilityState.closedDateReasons.get(dateKey) || '');
                setAvailabilityMessage(`Selected a closed date: ${formatDisplayDate(dateKey)}.`, false);
                setTimeStatusOverride('This date is closed. Choose another available date to unlock time slots.');
                buildTimeGrid();
            });
        } else if (isContextLocked) {
            // General availability preview — visible to everyone, including
            // guests who haven't chosen a location/package yet, so they can
            // browse open dates before deciding to book. Actually selecting
            // a date still requires a location + package so we know which
            // scope to check when they get there.
            btn.classList.add('available', 'preview');
            btn.title = getScopeSelectionPrompt();
            btn.addEventListener('click', () => {
                const prompt = getScopeSelectionPrompt();
                setAvailabilityMessage(prompt, false);
                setTimeStatusOverride(prompt);
            });
        } else if (isBooked) {
            btn.classList.add('booked');
            btn.title = 'This date is fully booked.';
            btn.setAttribute('aria-disabled', 'true');
            btn.addEventListener('click', () => {
                const reason = 'This date is fully booked.';
                syncSelectedDate(''); S.time = ''; availabilityState.selectedDateAvailability = null;
                setClosedDateNotice('', ''); setAvailabilityMessage(reason, true);
                setTimeStatusOverride(`${reason} Choose another available date to see time slots.`);
                buildTimeGrid();
            });
        } else {
            btn.classList.add('available');
            btn.title = 'Click to select this date.';
            btn.addEventListener('click', async () => {
                if (eventDateInput?.value === dateKey) {
                    syncSelectedDate(''); S.time = ''; availabilityState.selectedDateAvailability = null;
                    setTimeStatusOverride(''); renderAvailabilityCalendar(); buildTimeGrid();
                    setAvailabilityMessage('Date selection cleared.', false); return;
                }
                syncSelectedDate(dateKey); S.time = ''; setTimeStatusOverride('');
                await loadSelectedDateAvailability();
                renderAvailabilityCalendar(); buildTimeGrid();
            });
        }

        if (isSelected && isCurrentMonth) btn.classList.add('selected');
        availabilityGrid.appendChild(btn);
    }
}

async function loadAvailabilityCalendar() {
    updateDateDisplayPlaceholder();
    setAvailabilityMessage('Loading availability...');

    try {
        const range = getCalendarRange(availabilityState.month);
        const [calendarAvailability, blackoutData] = await Promise.all([
            fetchCalendarAvailability(supabase, { fromDate: range.fromDate, toDate: range.toDate }),
            fetchBlackoutDates(supabase, availabilityState, true)
        ]);

        availabilityState.calendarAvailability = calendarAvailability;
        availabilityState.blackoutDateColumn   = blackoutData.blackoutDateColumn;
        availabilityState.blackoutReasonColumn = blackoutData.blackoutReasonColumn;
        availabilityState.closedDates          = blackoutData.closedDates;
        availabilityState.closedDateReasons    = blackoutData.closedDateReasons;

        if (S.eventDate && getSelectedBookingScope()) {
            await loadSelectedDateAvailability();
        } else {
            availabilityState.selectedDateAvailability = null;
        }

        if (!getSelectedBookingScope()) {
            setAvailabilityMessage(getScopeSelectionPrompt(), false);
        } else if (!S.eventDate) {
            setAvailabilityMessage(`Choose an available date for the ${getScopeLabel(getSelectedBookingScope())} booking slot.`, false);
        } else if (!availabilityState.selectedDateAvailability?.scopeTaken) {
            setAvailabilityMessage(`Selected ${formatDisplayDate(S.eventDate)}.`, false);
        }
    } catch (err) {
        availabilityState.calendarAvailability = new Map();
        availabilityState.closedDates = new Set();
        availabilityState.closedDateReasons = new Map();
        availabilityState.selectedDateAvailability = null;
        setAvailabilityMessage('Availability preview could not be loaded right now.', true);
    }

    renderAvailabilityCalendar();
}

async function loadSelectedDateAvailability() {
    const selectedScope = getSelectedBookingScope();
    if (!S.eventDate || !selectedScope) { availabilityState.selectedDateAvailability = null; return null; }

    try {
        const availability = await fetchDateAvailability(supabase, {
            eventDate: S.eventDate, scope: selectedScope, durationHours: getSelectedDurationHours()
        });
        availabilityState.selectedDateAvailability = availability;
        setAvailabilityMessage(availability.scopeTaken ? 'This date is fully booked.' : `Selected ${formatDisplayDate(S.eventDate)}.`, availability.scopeTaken);
        return availability;
    } catch (err) {
        availabilityState.selectedDateAvailability = null;
        setAvailabilityMessage('Could not refresh the selected date availability right now.', true);
        return null;
    }
}

// ── Load event types ───────────────────────────────────────────────────
async function loadEventTypes() {
    const { data, error } = await supabase.from('event_types').select('*').order('name', { ascending: true });
    if (error || !data) {
        setAvailabilityMessage('Some booking options could not be loaded. Please refresh the page and try again.', true);
        return;
    }

    eventTypesCache = data
        .filter(et => !(et.status && et.status !== 'Active') && et.is_active !== false)
        .map(et => ({
            name: et.name ?? et.event_type_name ?? et.type_name ?? Object.values(et)[1],
            minAdvanceDays: (et.min_advance_days !== null && et.min_advance_days !== undefined && Number.isFinite(Number(et.min_advance_days)))
                ? Number(et.min_advance_days)
                : null
        }))
        .filter(et => Boolean(et.name));

    buildEventTypeSelect();
}

function buildEventTypeSelect() {
    const sel = document.getElementById('event-type-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">Select event type…</option>';
    [...eventTypesCache.map(et => et.name), 'Other'].forEach(label => {
        const opt = document.createElement('option');
        opt.value = label;
        opt.textContent = label;
        if (S.eventType === label) opt.selected = true;
        sel.appendChild(opt);
    });
    const otherWrap = document.getElementById('event-type-other-wrap');
    if (S.eventType === 'Other' && otherWrap) {
        otherWrap.classList.remove('hidden');
        const otherInput = document.getElementById('event-type-other');
        if (otherInput && S.eventTypeOther) otherInput.value = S.eventTypeOther;
    } else {
        otherWrap?.classList.add('hidden');
    }
    updateMinNoticeBanner();
}

document.getElementById('event-type-select')?.addEventListener('change', function () {
    const label = this.value;
    S.eventType = label;
    const otherWrap = document.getElementById('event-type-other-wrap');
    if (label === 'Other') {
        otherWrap?.classList.remove('hidden');
        document.getElementById('event-type-other')?.focus();
    } else {
        otherWrap?.classList.add('hidden');
        S.eventTypeOther = '';
        const otherInput = document.getElementById('event-type-other');
        if (otherInput) otherInput.value = '';
    }
    updateMinNoticeBanner();

    // This event type may carry its own minimum-notice override, so the
    // bookable window (and which dates read as "too soon") can change —
    // re-check whether the displayed month still has any bookable date,
    // and only refetch from Supabase if we actually had to page forward.
    const prevMonthKey = availabilityState.month.getFullYear() + '-' + availabilityState.month.getMonth();
    advanceToFirstBookableMonth();
    const newMonthKey = availabilityState.month.getFullYear() + '-' + availabilityState.month.getMonth();
    if (prevMonthKey !== newMonthKey) {
        loadAvailabilityCalendar();
    } else {
        renderAvailabilityCalendar();
    }
});

// ── Load packages from Supabase ────────────────────────────────────────
let packagesLoadState = 'loading'; // 'loading' | 'ok' | 'error'

async function loadPackages() {
    packagesLoadState = 'loading';
    const { data: pkgs, error } = await supabase
        .from('package')
        .select('package_id, package_name, description, package_type, price, guest_capacity, min_guests, max_guests, location_type, duration_hours, booking_scope, sort_order, inclusions, package_image, package_category_id, catering_main_dish_max, uses_catering_menu, allow_additional_head, price_per_additional_head, max_additional_heads, package_category(category_name, is_active, sort_order, service_charge_percent)')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

    if (error || !pkgs) {
        packagesLoadState = 'error';
        MINI = []; SNACK = []; OFFSITE_ALL = [];
        MINI_BY_CAT = {}; OFFSITE_BY_CAT = {};
        ONSITE_CATEGORIES = []; OFFSITE_CATEGORIES = [];
        return;
    }

    // Venue-mapping counts + photo existence — the same "bookable"
    // definition the admin health strip already enforces
    // (js/super_admin_packages.js computeHealthIssues()): an onsite (or
    // "both") package needs at least one mapped venue; every package
    // needs at least one photo. Two batch queries, not one per package.
    const packageIds = pkgs.map(p => p.package_id);
    const [{ data: venueMaps }, { data: photoRows }, { data: discountRows }] = packageIds.length
        ? await Promise.all([
            supabase.from('package_venue').select('package_id').in('package_id', packageIds),
            supabase.from('package_photo').select('package_id, image_url, is_cover, sort_order').in('package_id', packageIds).order('sort_order', { ascending: true }),
            supabase.from('package_discount').select('*').in('package_id', packageIds)
        ])
        : [{ data: [] }, { data: [] }, { data: [] }];

    const venueCounts = new Map();
    (venueMaps || []).forEach(row => venueCounts.set(row.package_id, (venueCounts.get(row.package_id) || 0) + 1));
    const hasGalleryPhoto = new Set((photoRows || []).map(row => row.package_id));

    // Grouped by package, resolved to "the one active row (if any)" at the
    // point each base package object is built below — not cached as a
    // flat map, since applyDiscount()/pickActiveDiscount() must be
    // re-evaluated against `now` again later (buildSummary(), submit) in
    // case the window opens/closes mid-session.
    const discountsByPkg = new Map();
    (discountRows || []).forEach(row => {
        if (!discountsByPkg.has(row.package_id)) discountsByPkg.set(row.package_id, []);
        discountsByPkg.get(row.package_id).push(row);
    });

    // Cover photo per package — the gallery photo marked is_cover, else
    // the first uploaded photo (mirrors js/packages.js's _coverPhoto logic).
    const coverPhotoMap = new Map();
    (photoRows || []).forEach(row => {
        const existing = coverPhotoMap.get(row.package_id);
        if (!existing || row.is_cover) coverPhotoMap.set(row.package_id, row);
    });

    const visible = pkgs.filter(p => p.package_category?.is_active !== false);
    MINI = []; SNACK = []; OFFSITE_ALL = [];
    MINI_BY_CAT = {}; OFFSITE_BY_CAT = {};
    const onsiteCatMap  = new Map(); // categoryId -> { id, name, sortOrder, count }
    const offsiteCatMap = new Map();

    visible.forEach(p => {
        const desc = (p.description || '').trim();
        // Price 0 is legitimate for offsite "contact for quote" packages
        // as long as there's a real description — only drop packages
        // with neither (basically blank, never finished in admin).
        if (p.price === 0 && (desc === '' || desc === '.')) return;

        // Photo: the new gallery (package_photo) OR the legacy single
        // package_image column, so packages never re-saved through the
        // new photo editor aren't wrongly excluded.
        const hasPhoto = hasGalleryPhoto.has(p.package_id) || !!p.package_image;
        // Inclusions: the new structured array OR a real description —
        // most existing packages still carry inclusions as free text in
        // description and were never migrated to the structured column
        // (20260725_bookable_inventory.sql's inclusions column is
        // additive, no backfill, by design).
        const hasInclusions = (Array.isArray(p.inclusions) && p.inclusions.length > 0) || desc !== '';
        if (!hasPhoto || !hasInclusions) return;

        const loc = p.location_type;
        const venueCount = venueCounts.get(p.package_id) || 0;
        // location_type can be 'onsite', 'offsite', or 'both' (Bookable
        // Inventory's Service Mode field) — the previous version of this
        // function only handled 'onsite'/'offsite' explicitly, so any
        // 'both' package silently matched neither branch and vanished
        // from the form entirely despite being active. That was the
        // actual cause of "All-In" packages going missing: they're
        // configured as Service Mode "Both". An onsite-eligible package
        // (onsite or both) additionally needs at least one mapped venue —
        // enforced here for the first time; previously this form showed
        // onsite packages with zero venues too, which isn't bookable
        // either.
        const isOnsiteEligible = (loc === 'onsite' || loc === 'both') && venueCount > 0;
        const isOffsiteEligible = (loc === 'offsite' || loc === 'both');
        if (!isOnsiteEligible && !isOffsiteEligible) return;

        // A package with no category assigned can't be placed under the
        // category-selection step at all — skip it rather than showing
        // it in an "uncategorized" bucket nothing on this page can filter to.
        const categoryId = p.package_category_id || null;
        if (!categoryId) return;
        const categoryName = p.package_category?.category_name || '';
        const categorySortOrder = p.package_category?.sort_order ?? 0;
        CATEGORY_SERVICE_CHARGE_PCT[categoryId] = p.package_category?.service_charge_percent ?? null;

        const cover = coverPhotoMap.get(p.package_id);
        const base = {
            id: p.package_id,
            label: p.package_name,
            price: p.price,
            desc: p.description || '',
            inclusions: Array.isArray(p.inclusions) ? p.inclusions : [],
            durationHours: Number(p.duration_hours || 0) || null,
            bookingScope: p.booking_scope || null,
            min_guests: p.min_guests ?? null,
            max_guests: p.max_guests ?? null,
            guestCapacity: p.guest_capacity ?? null,
            allowAdditionalHead: !!p.allow_additional_head,
            pricePerAdditionalHead: p.price_per_additional_head ?? null,
            maxAdditionalHeads: p.max_additional_heads ?? null,
            categoryId,
            categoryName,
            // Package cards render at ~300-370px (`.cards-grid`, `.reservation-
            // container` max-width 720px) — 600 covers that at a safe ~1.6-2x
            // for retina screens instead of shipping the full Cloudinary
            // upload resolution into a small grid thumbnail.
            coverPhotoUrl: optimizedImageUrl(cover?.image_url || p.package_image, 600) || null,
            mainDishMax: p.catering_main_dish_max ?? null,
            // Drives the customer-facing dish-builder wizard (see
            // isCateringPackage()) — a standalone flag, independent of
            // this package's category name or Service Mode.
            usesCateringMenu: !!p.uses_catering_menu,
            // Raw rows (not a pre-resolved snapshot) so buildSummary() and
            // the submit handler can each re-evaluate against the current
            // clock — a promo could start or end mid-session.
            discountRows: discountsByPkg.get(p.package_id) || null
        };
        const isAddon = p.package_type === 'add on' || p.package_type === 'add_on';

        if (isOnsiteEligible) {
            if (isAddon) {
                SNACK.push(base);
            } else {
                MINI.push(base);
                if (!MINI_BY_CAT[categoryId]) MINI_BY_CAT[categoryId] = [];
                MINI_BY_CAT[categoryId].push(base);
                const entry = onsiteCatMap.get(categoryId) || { id: categoryId, name: categoryName, sortOrder: categorySortOrder, count: 0 };
                entry.count++;
                onsiteCatMap.set(categoryId, entry);
            }
        }
        if (isOffsiteEligible) {
            OFFSITE_ALL.push(base);
            if (!OFFSITE_BY_CAT[categoryId]) OFFSITE_BY_CAT[categoryId] = [];
            OFFSITE_BY_CAT[categoryId].push(base);
            const entry = offsiteCatMap.get(categoryId) || { id: categoryId, name: categoryName, sortOrder: categorySortOrder, count: 0 };
            entry.count++;
            offsiteCatMap.set(categoryId, entry);
        }
    });

    ONSITE_CATEGORIES  = [...onsiteCatMap.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    OFFSITE_CATEGORIES = [...offsiteCatMap.values()].sort((a, b) => a.sortOrder - b.sortOrder);

    packagesLoadState = 'ok';
}

function packagesEmptyStateHtml() {
    if (packagesLoadState === 'error') {
        return '<p class="pkg-empty-state">Couldn\'t load packages — please refresh the page.</p>';
    }
    return '<p class="pkg-empty-state">No packages are currently available for booking.</p>';
}


// ── Category step builder (1B) ─────────────────────────────────────────
function getCategoriesForLocation() {
    if (S.locationType === 'onsite')  return ONSITE_CATEGORIES;
    if (S.locationType === 'offsite') return OFFSITE_CATEGORIES;
    return [];
}

function buildCategoryGrid() {
    const g = document.getElementById('category-grid');
    const caption = document.getElementById('rs-cat-desc');
    if (!g) return;
    g.innerHTML = '';

    if (!S.locationType) {
        if (caption) caption.textContent = 'Choose a location first to see package categories.';
        return;
    }

    const cats = getCategoriesForLocation();
    if (!cats.length) {
        g.innerHTML = packagesEmptyStateHtml();
        if (caption) caption.textContent = '';
        return;
    }

    cats.forEach(cat => {
        const isActive = S.categoryId === cat.id;
        const el = document.createElement('div');
        el.className = 'pkg-cat-card' + (isActive ? ' active' : '');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-pressed', String(isActive));
        el.setAttribute('aria-label', 'View ' + cat.name + ' packages');
        el.innerHTML =
            '<div class="pkg-cat-check" aria-hidden="true"><i class="ti ti-check"></i></div>' +
            '<i class="ti ' + getCategoryIcon(cat.name) + ' pkg-cat-icon" aria-hidden="true"></i>' +
            '<p class="pkg-cat-name">' + escapeHtml(cat.name) + '</p>' +
            '<p class="pkg-cat-count">' + cat.count + (cat.count === 1 ? ' package' : ' packages') + '</p>';
        const choose = () => selectCategory(cat);
        el.addEventListener('click', choose);
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
        });
        g.appendChild(el);
    });

    if (caption) {
        const activeCat = cats.find(c => c.id === S.categoryId);
        caption.textContent = activeCat
            ? `Showing ${activeCat.name} options only.`
            : 'Pick the type of package that fits your event.';
    }
}

async function selectCategory(cat) {
    const prev = S.categoryId;
    S.categoryId = cat.id;
    if (prev !== cat.id) {
        S.miniPackage    = null;
        S.venueOptions   = [];
        S.venueId        = null;
        S.additionalHeads = 0;
        S.offsitePackage = null;
        S.snackAddon     = null;
        S.cateringCart   = [];
        S.cateringActiveMain = null;
        S.cateringOpenSection = null;
        S.cateringGlobalPax = null;
        S.cateringPaxCustomizeOpen = {};
        S.time           = '';
        syncSelectedDate('');
    }
    // Auto-resolve when this offsite category has exactly one package and
    // it's catering-flagged — there's nothing for the customer to pick,
    // so treat it as selected immediately (mirrors clicking its card,
    // minus the click) and preload its dish menu.
    if (S.locationType === 'offsite') {
        const list = OFFSITE_BY_CAT[cat.id] || [];
        if (list.length === 1 && isCateringPackage(list[0])) {
            S.offsitePackage = list[0];
            await ensureCateringMenuLoaded(list[0]);
        }
    }
    buildCategoryGrid();
    buildPackageStep();
    updateSectionLocks();
    buildAddonOrVenueStep();
    buildAdditionalHeadBlock();
    await refreshAvailabilityForSelectedScope();
}

// ── Package step builder (1C) ──────────────────────────────────────────
function buildPackageStep() {
    const onEl   = document.getElementById('onsite-section');
    const offEl  = document.getElementById('offsite-section');
    const descEl = document.getElementById('rs-pkg-desc');
    const subEl      = document.getElementById('offsite-sub');
    const cateringEl = document.getElementById('catering-section');

    if (S.locationType === 'onsite') {
        onEl.classList.remove('hidden');
        offEl.classList.add('hidden');
        if (!S.categoryId) {
            if (descEl) descEl.textContent = 'Choose a package category above to see available packages.';
            document.getElementById('mini-grid').innerHTML = '';
            cateringEl.classList.add('hidden');
            return;
        }
        if (descEl) descEl.textContent = 'Select a package for your event at ELI Coffee.';
        buildMiniGrid();
        // A catering-flagged onsite package (isCateringPackage()) drives
        // the dish builder the same as an offsite one does — the flag is
        // independent of location type, so no Service-Mode check here.
        if (isCateringPackage(S.miniPackage)) {
            cateringEl.classList.remove('hidden');
            buildCateringInclusionsBlock();
            buildCateringDishBuilder();
        } else {
            cateringEl.classList.add('hidden');
        }
    } else if (S.locationType === 'offsite') {
        onEl.classList.add('hidden');
        offEl.classList.remove('hidden');
        if (!S.categoryId) {
            if (descEl) descEl.textContent = 'Choose a package category above to see available packages.';
            subEl.classList.add('hidden');
            cateringEl.classList.add('hidden');
            return;
        }
        if (descEl) descEl.textContent = 'Choose your offsite package.';

        const catList = OFFSITE_BY_CAT[S.categoryId] || [];
        const soleCateringPkg = (catList.length === 1 && isCateringPackage(catList[0])) ? catList[0] : null;

        if (soleCateringPkg) {
            // Nothing to pick — this category's only package is the
            // catering one, so skip the grid entirely.
            subEl.classList.add('hidden');
            cateringEl.classList.remove('hidden');
            buildCateringInclusionsBlock();
            buildCateringDishBuilder();
        } else {
            // Mixed or all-regular category: always show the picker grid
            // (catering and regular packages can sit side by side), and
            // additionally reveal the dish builder once the customer has
            // actually picked a catering-flagged package from it.
            document.getElementById('offsite-sub-label').textContent = 'Choose a Package';
            subEl.classList.remove('hidden');
            buildOffsiteSub(S.categoryId);
            if (isCateringPackage(S.offsitePackage)) {
                cateringEl.classList.remove('hidden');
                buildCateringInclusionsBlock();
                buildCateringDishBuilder();
            } else {
                cateringEl.classList.add('hidden');
            }
        }
    } else {
        onEl.classList.add('hidden');
        offEl.classList.add('hidden');
        if (descEl) descEl.textContent = 'Choose your location type first to unlock package options.';
    }
}

// ── Unified package card ───────────────────────────────────────────────
function buildGuestDurationChips(p) {
    let chips = '';
    if (p.min_guests != null && p.max_guests != null) {
        chips += '<span class="rpkg-chip"><i class="ti ti-users"></i>' + p.min_guests + '–' + p.max_guests + ' guests</span>';
    } else if (p.guestCapacity) {
        chips += '<span class="rpkg-chip"><i class="ti ti-users"></i>Up to ' + p.guestCapacity + ' guests</span>';
    }
    if (p.durationHours) {
        chips += '<span class="rpkg-chip"><i class="ti ti-clock"></i>' + p.durationHours + (p.durationHours === 1 ? ' hr' : ' hrs') + '</span>';
    }
    return chips;
}

function buildPkgCardInner(p) {
    const photoHtml = p.coverPhotoUrl
        ? '<img class="rpkg-photo" src="' + escapeHtml(p.coverPhotoUrl) + '" alt="' + escapeHtml(p.label) + '" loading="lazy">'
        : '<div class="rpkg-photo-placeholder" aria-hidden="true"><i class="ti ti-photo"></i></div>';
    const discount = getPkgDiscount(p);
    let priceHtml;
    if (!(p.price > 0)) {
        priceHtml = '<div class="rpkg-price rpkg-price--contact">Contact for quote</div>';
    } else if (discount.active) {
        priceHtml = '<div class="rpkg-price rpkg-price--discounted">' +
            '<s class="rpkg-price-original">' + fmtPeso(discount.listPrice) + '</s> ' +
            fmtPeso(discount.discountedPrice) +
            ' <span class="rpkg-price-off">&minus;' + discount.percentOff + '%</span>' +
            '</div>';
    } else {
        priceHtml = '<div class="rpkg-price">' + fmtPeso(p.price) + '</div>';
    }
    const chips = buildGuestDurationChips(p);
    return (
        '<div class="rpkg-media">' + photoHtml +
            '<div class="rpkg-check" aria-hidden="true"><i class="ti ti-check"></i></div>' +
        '</div>' +
        '<div class="rpkg-body">' +
            '<h4 class="rpkg-name">' + escapeHtml(p.label) + '</h4>' +
            priceHtml +
            (p.desc ? '<p class="rpkg-desc">' + escapeHtml(p.desc) + '</p>' : '') +
            (chips ? '<div class="rpkg-chips">' + chips + '</div>' : '') +
            '<a class="rpkg-details-link" href="/packages.html?package=' + encodeURIComponent(p.id) + '" target="_blank" rel="noopener noreferrer">' +
                'View full details <i class="ti ti-arrow-up-right" aria-hidden="true"></i>' +
            '</a>' +
        '</div>'
    );
}

function buildMiniGrid() {
    const g = document.getElementById('mini-grid');
    if (!g) return;
    g.innerHTML = '';
    const list = MINI_BY_CAT[S.categoryId] || [];
    list.forEach(p => {
        const c = card(buildPkgCardInner(p), !!S.miniPackage && S.miniPackage.id === p.id);
        c.onclick = async () => {
            const switchingToCatering = isCateringPackage(p) && (!S.miniPackage || S.miniPackage.id !== p.id);
            S.miniPackage = p;
            S.snackAddon  = null;
            S.time        = '';
            if (switchingToCatering) {
                // A different catering package — don't carry another
                // package's dish selections into this one (mirrors
                // buildOffsiteSub()'s same handling for offsite).
                S.cateringCart = [];
                S.cateringActiveMain = null;
                S.cateringOpenSection = null;
                S.cateringGlobalPax = null;
                S.cateringPaxCustomizeOpen = {};
                await ensureCateringMenuLoaded(p);
            }
            activate(g, c);
            updateSectionLocks();
            clampGuestCountToSelection();
            resetAdditionalHeads();
            await resolveVenueOptionsForPackage(p);
            const cateringEl = document.getElementById('catering-section');
            if (isCateringPackage(p)) {
                cateringEl?.classList.remove('hidden');
                buildCateringInclusionsBlock();
                buildCateringDishBuilder();
                scrollToCateringMenu();
            } else {
                cateringEl?.classList.add('hidden');
            }
            buildAddonOrVenueStep();
            buildAdditionalHeadBlock();
            await refreshAvailabilityForSelectedScope();
        };
        g.appendChild(c);
    });
    if (!list.length) g.innerHTML = packagesEmptyStateHtml();
}

function buildSnackGrid() {
    const g = document.getElementById('snack-grid');
    if (!g) return;
    g.innerHTML = '';
    // "No Add-on" is an always-available default, not a product — kept
    // visually distinct (solid tint) rather than the full unified card.
    const none = document.createElement('div');
    none.className = 'pkg-card rpkg-noaddon' + (S.snackAddon === null ? ' active' : '');
    none.innerHTML = '<i class="ti ti-circle-off" aria-hidden="true"></i><h4>No Add-on</h4><p class="rpkg-desc">Skip the snack bar corner</p>';
    none.setAttribute('role', 'button');
    none.setAttribute('tabindex', '0');
    none.setAttribute('aria-pressed', String(S.snackAddon === null));
    none.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); none.click(); }
    });
    none.onclick = () => { S.snackAddon = null; activate(g, none); };
    g.appendChild(none);
    SNACK.forEach(p => {
        const c = card(buildPkgCardInner(p), !!S.snackAddon && S.snackAddon.id === p.id);
        c.onclick = () => { S.snackAddon = p; activate(g, c); };
        g.appendChild(c);
    });
}

function buildOffsiteSub(categoryId) {
    const g = document.getElementById('offsite-sub-grid');
    if (!g) return;
    g.innerHTML = '';
    const list = OFFSITE_BY_CAT[categoryId] || [];
    list.forEach(p => {
        const c = card(buildPkgCardInner(p), !!S.offsitePackage && S.offsitePackage.id === p.id);
        c.onclick = async () => {
            const switchingToCatering = isCateringPackage(p) && (!S.offsitePackage || S.offsitePackage.id !== p.id);
            S.offsitePackage = p; S.time = '';
            if (switchingToCatering) {
                // A different catering package — don't carry another
                // package's dish selections into this one.
                S.cateringCart = [];
                S.cateringActiveMain = null;
                S.cateringOpenSection = null;
                S.cateringGlobalPax = null;
                S.cateringPaxCustomizeOpen = {};
                await ensureCateringMenuLoaded(p);
            }
            activate(g, c);
            updateSectionLocks();
            clampGuestCountToSelection();
            resetAdditionalHeads();
            const cateringEl = document.getElementById('catering-section');
            if (isCateringPackage(p)) {
                cateringEl?.classList.remove('hidden');
                buildCateringInclusionsBlock();
                buildCateringDishBuilder();
                scrollToCateringMenu();
            } else {
                cateringEl?.classList.add('hidden');
            }
            buildAdditionalHeadBlock();
            buildAddonOrVenueStep();
            await refreshAvailabilityForSelectedScope();
        };
        g.appendChild(c);
    });
    if (!list.length) g.innerHTML = packagesEmptyStateHtml();
}

// ── Add-on / Venue conditional step ───────────────────────────────────
// ── Onsite room resolution (supabase/migrations/20261016_venue_capacity_
// and_selection.sql) — package_venue/venue are both publicly readable, so
// this queries them directly rather than needing a dedicated RPC. Mirrors
// the server's own resolution rule: 0 mapped venues or a combo (multi-
// scope) package never gets a resolved venue and falls back to pure
// scope-based booking; exactly 1 auto-resolves silently; 2+ needs the
// customer to pick one below. ──────────────────────────────────────────
async function resolveVenueOptionsForPackage(pkg) {
    S.venueOptions = [];
    S.venueId = null;
    const isComboPackage = Array.isArray(pkg?.bookingScope) && pkg.bookingScope.length > 1;
    if (!pkg?.id || isComboPackage) return;

    try {
        const { data, error } = await supabase
            .from('package_venue')
            .select('venue_id, venue:venue_id(venue_id, name, description, capacity, is_active)')
            .eq('package_id', pkg.id);
        if (error) throw error;

        const options = (data || [])
            .map(row => row.venue)
            .filter(v => v && v.is_active);
        S.venueOptions = options;
        if (options.length === 1) S.venueId = options[0].venue_id;
    } catch {
        // Non-critical — falls back to scope-only booking, same as a
        // package with zero mapped venues.
        S.venueOptions = [];
        S.venueId = null;
    }
}

function buildRoomPickerBlock() {
    const block = document.getElementById('room-picker-block');
    const g = document.getElementById('room-picker-grid');
    if (!block || !g) return;

    // Nothing to choose — either zero or exactly one (already auto-resolved).
    if (S.venueOptions.length < 2) {
        block.classList.add('hidden');
        g.innerHTML = '';
        return;
    }

    block.classList.remove('hidden');
    g.innerHTML = '';
    S.venueOptions.forEach(v => {
        const c = card(
            '<div class="rpkg-body">' +
                '<h4 class="rpkg-name">' + escapeHtml(v.name) + '</h4>' +
                (v.description ? '<p class="rpkg-desc">' + escapeHtml(v.description) + '</p>' : '') +
            '</div>',
            S.venueId === v.venue_id
        );
        c.onclick = async () => {
            S.venueId = v.venue_id;
            S.time = '';
            buildRoomPickerBlock();
            buildAdditionalHeadBlock();
            await refreshAvailabilityForSelectedScope();
        };
        g.appendChild(c);
    });
}

// ── Additional Per-Head (supabase/migrations/20261018_additional_per_head.sql)
// — guests booked beyond the selected package's Max Guests, at that
// package's own configured per-head price. Mirrors the server trigger's
// exact cap rule so the UI never lets a customer pick a count the server
// would reject: onsite is capped at (resolved venue's capacity − package's
// Max Guests), further capped by the package's own Max Additional Heads if
// set; offsite has no venue check, capped only by the package's own max
// (or uncapped if the package leaves it blank). ─────────────────────────
// Catering-flagged packages are cart-priced (no single package.price to
// attach a per-head charge to), so they never get an additional-head
// block — returning null here keeps every caller (block, preview, summary,
// submit) consistent without each one re-checking.
function getSelectedPackageForAdditionalHead() {
    const pkg = getActivePackage();
    return isCateringPackage(pkg) ? null : pkg;
}

function getAdditionalHeadEffectiveMax() {
    const pkg = getSelectedPackageForAdditionalHead();
    if (!pkg?.allowAdditionalHead) return 0;

    let max = Number.isFinite(pkg.maxAdditionalHeads) ? pkg.maxAdditionalHeads : Infinity;

    if (S.locationType === 'onsite') {
        const venue = S.venueOptions.find(v => v.venue_id === S.venueId);
        if (!venue || !Number.isFinite(venue.capacity)) return 0; // can't verify capacity yet — no room picked
        const venueRoom = Math.max(venue.capacity - Number(pkg.max_guests || 0), 0);
        max = Math.min(max, venueRoom);
    }

    return Math.max(max, 0);
}

function resetAdditionalHeads() {
    S.additionalHeads = 0;
    const input = document.getElementById('additional-heads-input');
    if (input) input.value = '0';
}

function setAdditionalHeads(next) {
    const effectiveMax = getAdditionalHeadEffectiveMax();
    S.additionalHeads = Math.min(Math.max(Math.round(next) || 0, 0), effectiveMax);
    buildAdditionalHeadBlock();
}

function buildAdditionalHeadBlock() {
    const block = document.getElementById('additional-head-block');
    const priceNote = document.getElementById('additional-head-price-note');
    const hint = document.getElementById('additional-head-hint');
    const input = document.getElementById('additional-heads-input');
    const minusBtn = document.getElementById('additional-head-minus');
    const plusBtn = document.getElementById('additional-head-plus');
    if (!block) return;

    const pkg = getSelectedPackageForAdditionalHead();
    if (!pkg?.allowAdditionalHead) {
        block.classList.add('hidden');
        return;
    }

    const effectiveMax = getAdditionalHeadEffectiveMax();
    if (S.additionalHeads > effectiveMax) S.additionalHeads = effectiveMax;

    block.classList.remove('hidden');
    const perHead = Number(pkg.pricePerAdditionalHead || 0);
    if (priceNote) priceNote.textContent = `${fmtPeso(perHead)} per extra guest, on top of this package's ${pkg.max_guests ?? '—'}-guest limit.`;
    if (input) {
        input.value = String(S.additionalHeads);
        input.max = String(effectiveMax);
    }
    if (minusBtn) minusBtn.disabled = S.additionalHeads <= 0;
    if (plusBtn) plusBtn.disabled = effectiveMax <= 0 || S.additionalHeads >= effectiveMax;

    if (hint) {
        if (effectiveMax <= 0) {
            hint.textContent = S.locationType === 'onsite' && !S.venueOptions.find(v => v.venue_id === S.venueId)
                ? 'Choose your room below to see how many extra guests it can hold.'
                : 'No extra guests can be added for this package.';
            hint.classList.add('additional-head-hint--limit');
        } else if (S.additionalHeads > 0) {
            hint.textContent = `+${S.additionalHeads} guest${S.additionalHeads === 1 ? '' : 's'} × ${fmtPeso(perHead)} = +${fmtPeso(S.additionalHeads * perHead)} (up to ${effectiveMax} extra allowed).`;
            hint.classList.remove('additional-head-hint--limit');
        } else {
            hint.textContent = `Up to ${effectiveMax} extra guest${effectiveMax === 1 ? '' : 's'} allowed.`;
            hint.classList.remove('additional-head-hint--limit');
        }
    }
}

document.getElementById('additional-head-minus')?.addEventListener('click', () => setAdditionalHeads(S.additionalHeads - 1));
document.getElementById('additional-head-plus')?.addEventListener('click', () => setAdditionalHeads(S.additionalHeads + 1));
document.getElementById('additional-heads-input')?.addEventListener('input', (e) => setAdditionalHeads(Number(e.target.value)));

function buildAddonOrVenueStep() {
    const title      = document.getElementById('rs-addon-or-venue-title');
    const desc       = document.getElementById('rs-addon-or-venue-desc');
    const addonSect  = document.getElementById('addon-section');
    const venueSect  = document.getElementById('venue-section');

    // When no package is chosen yet, keep content collapsed (lock overlay handles messaging)
    if (!isGuestsTypeUnlocked()) {
        if (title) title.textContent = 'Add-ons / Venue';
        if (desc)  desc.textContent = '';
        if (addonSect) addonSect.classList.add('hidden');
        if (venueSect) venueSect.classList.add('hidden');
        return;
    }

    if (S.locationType === 'onsite') {
        const needsRoomChoice = S.venueOptions.length > 1;
        if (title) title.innerHTML = needsRoomChoice
            ? 'Choose your <em>room</em>'
            : 'Want to add a <em>Snack Bar</em>?';
        if (desc)  desc.textContent = needsRoomChoice
            ? 'This package is available in more than one room — pick which one, then add a Snack Bar Corner if you\'d like.'
            : 'This optional add-on pairs perfectly with your gathering. You can skip it and proceed.';
        if (addonSect) addonSect.classList.remove('hidden');
        if (venueSect) venueSect.classList.add('hidden');
        buildRoomPickerBlock();
        buildSnackGrid();
    } else {
        if (title) title.innerHTML = 'Where is your <em>venue</em>?';
        if (desc)  desc.textContent = 'Search your address or click the map to pin your venue. Rizal province only.';
        if (addonSect) addonSect.classList.add('hidden');
        if (venueSect) venueSect.classList.remove('hidden');
        setTimeout(() => {
            if (window.initVenueMap) window.initVenueMap();
            if (window.venueMap) window.venueMap.invalidateSize();
        }, 150);
    }
}

// ── Catering inclusions block (admin-editable via the package's own
// Description + Inclusions fields in Inventory, same fields used on the
// public Packages page — this used to be static hardcoded HTML) ───────
function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function buildCateringInclusionsBlock() {
    const block = document.getElementById('catering-inclusions-block');
    if (!block) return;
    const pkg = getCateringPackage();
    if (!pkg) { block.innerHTML = ''; return; }

    const items = Array.isArray(pkg.inclusions) ? pkg.inclusions.filter(i => i && i.trim()) : [];
    const desc  = (pkg.desc || '').trim();

    // An inclusion line written as "Special Offer: ..." (case-insensitive,
    // same "label: text" convention already used for tier inclusions
    // elsewhere in this app) renders in the highlighted offer box instead
    // of a plain bullet — lets admins control it without a dedicated field.
    const bulletItems = [];
    const offerItems = [];
    items.forEach(item => {
        const m = item.match(/^\s*special offer\s*:\s*(.+)$/i);
        if (m) offerItems.push(m[1].trim());
        else bulletItems.push(item);
    });

    if (!desc && !bulletItems.length && !offerItems.length) {
        block.innerHTML = `
            <h4><i class="ti ti-clipboard-list" aria-hidden="true"></i> Catering Package Inclusions</h4>
            <p style="font-size:14px;color:var(--text-light,#8a8378);margin:0;">Inclusions are provided upon inquiry. Please contact us for details.</p>`;
        return;
    }

    let html = `<h4><i class="ti ti-clipboard-list" aria-hidden="true"></i> Catering Package Inclusions</h4>`;
    if (desc) html += `<p class="catering-inclusions-desc">${escHtml(desc)}</p>`;
    if (bulletItems.length) {
        html += `<ul>${bulletItems.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>`;
    }
    offerItems.forEach(offer => {
        html += `<div class="special-offer"><i class="ti ti-gift" aria-hidden="true"></i> Special Offer<span>${escHtml(offer)}</span></div>`;
    });
    block.innerHTML = html;
}

// ── Catering dish builder ──────────────────────────────────────────────
// A step-by-step wizard (Main Dish -> Pasta -> Dessert -> Rice -> Drink),
// matching the progress tracker shown above the builder. The protein
// categories (Chicken/Pork/Beef/Fish/Vegetables) all share the 'main' tag
// — the requirement is "at least 1 dish across all of them, up to the
// package's configured max", not "one from each". They're grouped under
// one "Main Dish" section below with a protein-type tab switcher, so only
// one dish grid is visible at a time instead of 5 stacked grids.
//
// Section required/optional state is NOT hardcoded — it's derived from
// whichever category (or categories) under that tag has its is_required
// flag set in the admin's Catering Menu screen, so toggling that checkbox
// actually changes what checkout enforces here.
const CATERING_TAG_ORDER = ['main', 'vegetable', 'pasta', 'dessert', 'rice', 'drinks'];

// CATERING_SECTION_META now lives in catering_section_hints.js — the admin's
// Section Restrictions preview (super_admin_packages.js) imports the same
// copy so its "what the customer sees" preview can never drift from this.

// Computed fresh each call (not cached) since it depends on DISHES, which
// can change after loadCateringMenu() resolves. The "Pax Count" step is
// synthetic — it has no DISHES group of its own — and is always first:
// customers pick a global serving size before any dish category unlocks
// (see the `locked` handling in buildCateringDishBuilder()).
function getCateringSections() {
    const paxMeta = CATERING_SECTION_META.pax;
    const paxSection = { tag: 'pax', label: paxMeta.label, optional: false, hint: paxMeta.hint() };

    const dishSections = CATERING_TAG_ORDER
        .filter(tag => DISHES.some(g => g.tag === tag))
        .map(tag => {
            const min = getCateringSectionMin(tag);
            const max = getCateringSectionMax(tag);
            const required = min > 0;
            const meta = CATERING_SECTION_META[tag] || { label: tag, hint: (r) => r ? 'Required for this package.' : 'Optional add-on.' };
            return { tag, label: meta.label, optional: !required, hint: meta.hint(required, max ?? min) };
        });

    return [paxSection, ...dishSections];
}

// The package's configured cap on main-dish (protein) selections —
// admin-editable via the "Max main dishes" field on Inventory > Catering
// Menu, stored on the package row itself (a whole-section rule, not a
// per-category one). Falls back to FALLBACK_MAIN_DISH_MAX if unset/invalid.
function getCateringPackage() {
    const pkg = getActivePackage();
    return isCateringPackage(pkg) ? pkg : null;
}

function getCateringMainDishMax() {
    const v = Number(getCateringPackage()?.mainDishMax);
    return Number.isFinite(v) && v > 0 ? v : FALLBACK_MAIN_DISH_MAX;
}

// Resolves the effective { min, max } for a section (tag). Prefers an
// explicit catering_section_rule row (admin's "+ Add Restriction" on the
// Catering Menu screen); falls back to the pre-restriction-table behavior
// so packages nobody has touched since this feature shipped keep working
// unchanged: 'main' derives from the package's legacy catering_main_dish_max
// (required to reach exactly that many), every other tag derives from
// whether any of its categories has the legacy is_required flag set
// (required to pick just one, uncapped).
function getCateringSectionRule(tag) {
    const explicit = CATERING_SECTION_RULES[tag];
    if (explicit) return explicit;
    if (tag === 'main') { const max = getCateringMainDishMax(); return { min: max, max }; }
    const required = DISHES.filter(g => g.tag === tag).some(g => g.required);
    return { min: required ? 1 : 0, max: null };
}

function getCateringSectionMin(tag) { return getCateringSectionRule(tag).min || 0; }
function getCateringSectionMax(tag) { return getCateringSectionRule(tag).max ?? null; } // null = unlimited

// Counts straight from the live cart instead of walking DISHES' groups for
// this tag. Walking the groups undercounts "remaining" (and can show a
// smaller "Still needed" number than what's actually left to pick)
// whenever a category is duplicated in the loaded menu, since the same
// cart selection then gets matched — and counted — once per matching
// group instead of once. Deduping against the *current* set of tag
// category names still keeps this accurate if the menu changes underneath
// an existing cart (e.g. after switching packages).
function getCateringSectionSelectedCount(tag) {
    const tagCats = new Set(DISHES.filter(g => g.tag === tag).map(g => g.cat));
    return S.cateringCart.filter(i => i && i.pax && tagCats.has(i.cat)).length;
}

function hasCateringTag(tag) {
    return DISHES.filter(g => g.tag === tag).some(g => S.cateringCart.some(i => i.cat === g.cat && i.pax));
}

function isCateringSelectionValid() {
    return getCateringSections().every(section => isCateringSectionValid(section));
}

// A section with a configured minimum (e.g. Main Dish needing 3 proteins,
// or any other section an admin has marked Required/Min N for) is valid
// only once the cart reaches that count — not just "has one pick". A
// section with no minimum is always optional. Pax Count is required but
// isn't tag-driven at all, since it has no DISHES group of its own.
function isCateringSectionValid(section) {
    if (section.tag === 'pax') return !!S.cateringGlobalPax;
    const min = getCateringSectionMin(section.tag);
    return min <= 0 || getCateringSectionSelectedCount(section.tag) >= min;
}

function getFirstIncompleteCateringSection() {
    return getCateringSections().find((section) => !isCateringSectionValid(section)) || null;
}

function openCateringSection(tag) {
    S.cateringOpenSection = tag;
    buildCateringDishBuilder();
    focusCateringSection(tag);
}

// Brings the clicked step's section into view (vertically centered — see
// block: 'center' below) AND moves keyboard/screen-reader focus onto it,
// instead of leaving a bare scrollIntoView() to land wherever it lands with
// no offset for the sticky navbar. A hand-computed
// `getBoundingClientRect().top + scrollY - 80` pixel target was tried here
// first, but window.scrollTo() aims at a fixed absolute position — if
// anything below (lazy-loaded dish images, etc.) changes the page's height
// while that scroll is still animating, the target point drifts and the
// scroll overshoots, in one case landing all the way down at "Guests &
// event type". scrollIntoView() re-targets the element itself rather than a
// frozen pixel offset, so it doesn't have that failure mode.
//
// block: 'center' rather than 'start': lands the opened section in the
// middle of the screen instead of pinned under the sticky navbar, so there's
// visible context both above (what's already answered) and below (what's
// next) without an extra manual scroll either way. scroll-margin-top on
// .catering-accordion-item (css/reservations.css, the same pattern
// css/menu.css uses for its own sticky-nav offset) still guards the case
// where a short trailing section can't fully center because there isn't
// enough page left below it — 'center' clamps to 'start' then and the
// margin keeps it clear of the navbar.
//
// focus() is still called first, not last. `preventScroll: true` isn't
// honored by every engine (notably iOS Safari), and on those, focusing the
// header fires its own implicit scroll-into-view the instant it runs. If
// that happened *after* scrollIntoView() below, it would fire mid-animation
// and hijack it, landing whatever distance short/past the target that
// engine's own "bring focused element into view" heuristic picks — the
// overshoot reported when tapping any step chip on a real device. Doing the
// focus first means any implicit scroll it causes happens before the
// animation starts, and the explicit scrollIntoView() immediately after is
// the last word on scroll position, so it always settles exactly on target
// regardless of that engine's preventScroll support.
function focusCateringSection(tag) {
    const sectionEl = document.getElementById('catering-section-' + tag);
    if (!sectionEl) return;
    sectionEl.querySelector('.catering-accordion-header')?.focus({ preventScroll: true });
    sectionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Carries the customer straight to the dish builder the moment they pick a
// catering-flagged package (buildMiniGrid()/buildOffsiteSub() card clicks),
// instead of leaving them at the package grid with the now-visible menu
// further down the page. rAF-deferred one frame so the browser has actually
// laid out #catering-section after its class="hidden" was just removed —
// scrolling in the same tick can measure the pre-reveal (zero-height)
// position and undershoot. block: 'start' (rather than focusCateringSection's
// 'center') lands the section header — and its "Pax Count" first step —
// right under the sticky navbar, matching how a customer would expect a
// freshly-revealed section to open; #catering-section's own
// scroll-margin-top (css/reservations.css) clears that navbar the same way
// .catering-accordion-item's does.
function scrollToCateringMenu() {
    const sectionEl = document.getElementById('catering-section');
    if (!sectionEl) return;
    requestAnimationFrame(() => {
        sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

function scrollToCateringSection(tag) {
    // Every dish section is locked until a global pax is chosen — redirect
    // there instead of opening a section the customer can't use yet.
    if (tag !== 'pax' && !S.cateringGlobalPax) { openCateringSection('pax'); return; }
    openCateringSection(tag);
}

function getCateringCartTotal()  { return S.cateringCart.reduce((s, i) => s + (i && i.pax ? i.price : 0), 0); }
function getCateringCartCount()  { return S.cateringCart.filter(i => i && i.pax).length; }
// A category (protein tab, or a single-category section like Pasta) can
// now hold more than one selected dish at once — e.g. Main Dish lets the
// customer mix and match proteins until they reach the package's max, and
// that max can be spread across categories however they like (2 chicken +
// 1 pork, or 3 of the same protein). `getCateringSelection` returns every
// dish currently picked under `cat`, not just one.
function getCateringSelection(cat) { return S.cateringCart.filter(i => i.cat === cat); }
function isDishSelected(cat, dish) { return S.cateringCart.some(i => i.cat === cat && i.dish === dish); }

// `customPax`, when provided, overrides this dish's tray size independent
// of the global serving size chosen in the Pax Count step. Omitting it
// (null/undefined) falls back to that global pax, and keeps following it
// automatically if the customer changes the global pax later (see
// updateGlobalCateringPax) — that's what distinguishes a "default" pick
// from a "customized" one (the `customized` flag).
//
// Only replaces the cart entry for this exact cat+dish pair (not every
// entry under `cat`) — that's what lets a second, third, etc. dish be
// added under the same category instead of bumping the previous pick.
function setCateringSelection(cat, dish, customPax) {
    S.cateringCart = S.cateringCart.filter(i => !(i.cat === cat && i.dish === dish));
    if (!dish) return;
    const effectivePax = customPax || S.cateringGlobalPax || null;
    if (effectivePax && PRICES[cat] && PRICES[cat][effectivePax]) {
        S.cateringCart.push({ cat, dish, pax: effectivePax, price: PRICES[cat][effectivePax], customized: !!customPax });
    } else {
        S.cateringCart.push({ cat, dish, pax: null, price: 0, customized: false });
    }
}

// Reverts a dish that was customized away from the global pax back to
// following it. Needs `dish` now that a category can hold several picks.
function resetCateringPaxToDefault(cat, dish) {
    const selected = S.cateringCart.find(i => i.cat === cat && i.dish === dish);
    if (!selected) return;
    setCateringSelection(cat, dish, null);
    rebuildCateringUI();
}

// Drinks aren't priced per pax bracket — one price per package regardless
// of headcount — so picking a drink finalizes it immediately instead of
// going through the "choose your pax" step every other category needs.
// pax:true (not a number) marks it complete for the truthy checks
// elsewhere (cart count, hasCateringTag, etc.) without implying a bracket.
function setCateringFlatSelection(cat, dish) {
    S.cateringCart = S.cateringCart.filter(i => !(i.cat === cat && i.dish === dish));
    if (dish) S.cateringCart.push({ cat, dish, pax: true, price: Number(PRICES[cat]?.[20]) || 0 });
}

// `dish` removes just that one pick; omitting it clears every dish under
// `cat` (used by "Clear all" style flows elsewhere).
function clearCateringSelection(cat, dish) {
    S.cateringCart = S.cateringCart.filter(i => !(i.cat === cat && (dish === undefined || i.dish === dish)));
    if (dish !== undefined) delete S.cateringPaxCustomizeOpen[cat + '|' + dish];
}

async function clearAllCateringSelections() {
    if (!S.cateringCart.length) return;
    const confirmed = await showConfirmModal({
        title: 'Remove all dishes?',
        message: 'This clears every dish you\u2019ve added for this catering package. You\u2019ll need to pick your main dish, pasta, and dessert again before continuing.',
        confirmText: 'Yes, remove all',
        cancelText: 'Cancel',
        destructive: true
    });
    if (!confirmed) return;

    S.cateringCart = [];
    S.cateringActiveMain = null;
    S.cateringPaxCustomizeOpen = {};
    // Global pax (serving size) isn't a "dish", so it's left as-is — only
    // the dish picks are cleared. Reopen whichever section is now first
    // incomplete (Main Dish, unless pax itself was somehow never set).
    S.cateringOpenSection = getFirstIncompleteCateringSection()?.tag || null;
    buildCateringDishBuilder();
}

// Fires only when a pax count is chosen (the point at which a dish becomes
// a *complete* pick) — mirrors the "build your bowl" pattern of Chipotle/
// Cava/Sweetgreen-style ordering flows: finishing the section you're
// currently working in collapses it into a compact confirmed summary and
// auto-advances to the next thing still needed, instead of requiring an
// explicit "Next" click. Only triggers when the section that was just
// completed is the one currently open, so switching between protein tabs
// inside an already-satisfied Main Dish section never yanks focus away.
function handleCateringPaxSelected(cat, dish, pax) {
    setCateringSelection(cat, dish, pax);
    advanceCateringSectionIfDoneForTag(DISHES.find(g => g.cat === cat)?.tag);
}

// Same auto-advance behavior as handleCateringPaxSelected, for categories
// (currently just Drinks) that skip the pax step entirely.
function handleCateringFlatSelected(cat, dish) {
    setCateringFlatSelection(cat, dish);
    advanceCateringSectionIfDoneForTag(DISHES.find(g => g.cat === cat)?.tag);
}

// Sets the order-wide serving size and re-prices every dish that's still
// following it (not individually customized), then advances out of the
// Pax Count step the same way finishing any other section does.
function handleGlobalPaxSelected(pax) {
    updateGlobalCateringPax(pax);
    advanceCateringSectionIfDoneForTag('pax');
}

function updateGlobalCateringPax(pax) {
    S.cateringGlobalPax = pax;
    S.cateringCart.forEach(item => {
        if (item && !item.customized && typeof item.pax === 'number' && PRICES[item.cat] && PRICES[item.cat][pax]) {
            item.pax = pax;
            item.price = PRICES[item.cat][pax];
        }
    });
}

function advanceCateringSectionIfDoneForTag(tag) {
    const sections = getCateringSections();
    const section = tag && sections.find(s => s.tag === tag);

    if (section && section.tag === S.cateringOpenSection && isCateringSectionValid(section)) {
        const currentIdx = sections.indexOf(section);
        const next = sections.slice(currentIdx + 1).find((s) => !isCateringSectionValid(s));
        S.cateringOpenSection = next ? next.tag : null;
        buildCateringDishBuilder();
        return;
    }

    buildCateringDishBuilder();
}


function renderCateringProgress() {
    const tracker = document.getElementById('catering-progress-tracker');
    if (!tracker) return;
    tracker.innerHTML = '';
    const sections = getCateringSections();
    // A grid of equal-width step chips, not a connected dot-and-dash line —
    // a connecting line can't wrap cleanly when the item count (6 or 7,
    // depending on the package's active sections) and each label's length
    // both vary: whatever the line's length rule (stretch, fixed, hidden on
    // mobile), the wrap point still falls somewhere different every time
    // and looks broken there. Equal grid cells wrap the same way regardless
    // of where the break falls, so there's no wrap point to get wrong.
    sections.forEach((section, idx) => {
        const done = isCateringSectionValid(section);
        const locked = section.tag !== 'pax' && !S.cateringGlobalPax;

        const item = document.createElement('div');
        item.className = 'pt-item' + (done ? ' done' : ' pending') + (S.cateringOpenSection === section.tag ? ' active' : '') + (locked ? ' locked' : '');
        item.innerHTML =
            '<div class="pt-dot">' + (done ? '&#10003;' : (locked ? '<i class="ti ti-lock" aria-hidden="true"></i>' : idx + 1)) + '</div>' +
            '<span>' + section.label + (section.optional ? ' <em style="font-weight:400;font-style:normal;opacity:0.6">(optional)</em>' : '') + '</span>';
        item.onclick = () => scrollToCateringSection(section.tag);
        tracker.appendChild(item);
    });
}

function buildCateringDishBuilder() {
    const builder = document.getElementById('catering-tray-builder');
    if (!builder) return;

    const trackerEl    = document.getElementById('catering-progress-tracker');
    const cartSection  = document.getElementById('catering-tray-cart')?.closest('.cart-section');
    if (cateringMenuUnavailable) {
        if (trackerEl) trackerEl.innerHTML = '';
        if (cartSection) cartSection.style.display = 'none';
        const labelEl = document.getElementById('catering-builder-label');
        if (labelEl) labelEl.innerHTML = '<i class="ti ti-tools-kitchen-2" aria-hidden="true"></i> Choose Your Dishes';
        const hintEl = document.getElementById('catering-builder-hint');
        if (hintEl) hintEl.textContent = '';
        builder.innerHTML =
            '<div class="catering-menu-unavailable">' +
                '<i class="ti ti-tools-kitchen-off" aria-hidden="true"></i>' +
                '<p>No catering menu is available for this package yet. Please choose a different package, or contact us directly to book it.</p>' +
            '</div>';
        return;
    }
    if (cartSection) cartSection.style.display = '';

    // First-ever render with nothing picked at all (no cart, no pax yet):
    // default to the first section open. Once anything is picked —
    // including just the global pax — an explicit collapse (auto-advance
    // or manual) is a deliberate state and is never overridden.
    const sections = getCateringSections();
    if (S.cateringOpenSection === null && S.cateringCart.length === 0 && !S.cateringGlobalPax) {
        S.cateringOpenSection = sections[0]?.tag || null;
    }

    builder.innerHTML = '';

    const labelEl = document.getElementById('catering-builder-label');
    if (labelEl) labelEl.innerHTML = '<i class="ti ti-tools-kitchen-2" aria-hidden="true"></i> Choose Your Dishes';
    const hintEl = document.getElementById('catering-builder-hint');
    if (hintEl) hintEl.textContent = 'Tap a section to choose its dish \u2014 it\u2019ll confirm and move you to what\u2019s next automatically.';

    sections.forEach((section) => {
        const isPaxSection = section.tag === 'pax';
        const groups = isPaxSection ? [] : DISHES.filter(g => g.tag === section.tag);
        if (!isPaxSection && !groups.length) return;

        // Every dish section stays locked until a global pax is chosen —
        // that's the "pax before dishes" ordering the builder enforces.
        const locked = !isPaxSection && !S.cateringGlobalPax;
        const valid  = isCateringSectionValid(section);
        const isOpen = !locked && S.cateringOpenSection === section.tag;
        const titleIcon = (!isPaxSection && groups.length === 1) ? groups[0].icon + ' ' : '';

        const sectionEl = document.createElement('div');
        sectionEl.className = 'catering-accordion-item' + (isOpen ? ' open' : '') + (valid ? ' done' : '') + (locked ? ' locked' : '');
        sectionEl.id = 'catering-section-' + section.tag;

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'catering-accordion-header';
        header.innerHTML =
            '<span class="accordion-status-dot' + (valid ? ' visible' : '') + '">' +
                (valid ? '&#10003;' : (locked ? '<i class="ti ti-lock" aria-hidden="true"></i>' : '')) +
            '</span>' +
            '<span class="catering-accordion-title">' + titleIcon + escHtml(section.label) + (section.optional ? ' <span class="cat-tag">(optional)</span>' : '') + '</span>' +
            '<i class="ti ti-chevron-down accordion-chevron" aria-hidden="true"></i>';
        header.onclick = () => {
            if (locked) { openCateringSection('pax'); return; }
            S.cateringOpenSection = isOpen ? null : section.tag; buildCateringDishBuilder();
        };
        sectionEl.appendChild(header);

        if (isOpen) {
            const body = document.createElement('div'); body.className = 'catering-accordion-body';
            const hint = document.createElement('p'); hint.className = 'catering-section-hint';
            hint.textContent = section.hint;
            body.appendChild(hint);

            if (isPaxSection) {
                body.appendChild(buildGlobalPaxPicker());
            } else if (groups.length > 1) {
                // Main Dish: several protein categories share this one
                // section. Rather than stacking every category's full dish
                // grid at once (the original clutter), show a tab per
                // protein with a checkmark once it has a selection, and
                // only that protein's dish grid below it — selections
                // across tabs are independent and all still count, so
                // switching tabs never loses a pick.
                if (!S.cateringActiveMain || !groups.some(g => g.cat === S.cateringActiveMain)) {
                    S.cateringActiveMain = groups[0].cat;
                }

                const tabs = document.createElement('div'); tabs.className = 'pills-row catering-protein-tabs';
                groups.forEach(group => {
                    const groupSelections = getCateringSelection(group.cat).filter(i => i.pax);
                    const groupCheck = groupSelections.length > 1 ? '&#10003; ' + groupSelections.length : '&#10003;';
                    const tab = document.createElement('button');
                    tab.type = 'button';
                    tab.className = 'pill' + (group.cat === S.cateringActiveMain ? ' active' : '');
                    tab.innerHTML = group.icon + ' ' + escHtml(group.cat) + (groupSelections.length ? ' <span class="pill-check">' + groupCheck + '</span>' : '');
                    tab.onclick = (e) => { e.stopPropagation(); S.cateringActiveMain = group.cat; buildCateringDishBuilder(); };
                    tabs.appendChild(tab);
                });
                body.appendChild(tabs);

                const activeGroup = groups.find(g => g.cat === S.cateringActiveMain) || groups[0];
                body.appendChild(buildCateringCategoryBlock(activeGroup));
            } else {
                body.appendChild(buildCateringCategoryBlock(groups[0]));
            }

            sectionEl.appendChild(body);
        } else if (valid) {
            sectionEl.appendChild(isPaxSection ? buildGlobalPaxRecap() : buildCateringSectionRecap(groups));
        }

        builder.appendChild(sectionEl);
    });

    renderCateringCart();
    renderCateringProgress();
}

// The Pax Count step's body: a single global 20/30/40/50 picker that sets
// every dish's default tray size at once. Mirrors the per-dish pax-buttons
// styling so it reads as the same kind of choice, just made once up front.
function buildGlobalPaxPicker() {
    const wrap = document.createElement('div');
    const btns = document.createElement('div'); btns.className = 'pax-buttons';
    [20, 30, 40, 50].forEach(n => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pax-btn' + (S.cateringGlobalPax === n ? ' selected' : '');
        btn.textContent = n + ' pax';
        btn.onclick = () => handleGlobalPaxSelected(n);
        btns.appendChild(btn);
    });
    wrap.appendChild(btns);

    if (!S.cateringGlobalPax) {
        const hint = document.createElement('p'); hint.className = 'pax-hint';
        hint.textContent = 'This sets the default tray size for every dish \u2014 pick a different pax for any individual dish later if you need to.';
        wrap.appendChild(hint);
    }
    return wrap;
}

// Compact recap for the collapsed, completed Pax Count step.
function buildGlobalPaxRecap() {
    const recap = document.createElement('div'); recap.className = 'catering-accordion-recap';
    const row = document.createElement('div'); row.className = 'catering-recap-row';
    row.innerHTML =
        '<span class="catering-recap-dish">Serving size</span>' +
        '<span class="catering-recap-meta">' + S.cateringGlobalPax + ' pax</span>';
    recap.appendChild(row);
    return recap;
}

// Compact "confirmed" recap shown for a collapsed, completed section — one
// line per selected dish (Main Dish can have more than one protein picked;
// Pasta/Dessert/Rice only ever have one). Clicking anywhere on it reopens
// the section, same as tapping its header.
function buildCateringSectionRecap(groups) {
    const recap = document.createElement('div'); recap.className = 'catering-accordion-recap';
    groups.forEach(group => {
        const selections = getCateringSelection(group.cat).filter(i => i.pax);
        selections.forEach(selected => {
            const row = document.createElement('div'); row.className = 'catering-recap-row';
            row.innerHTML =
                '<span class="catering-recap-dish">' + group.icon + ' ' + escHtml(selected.dish) + '</span>' +
                '<span class="catering-recap-meta">' + (selected.pax === true ? '' : selected.pax + ' pax &middot; ') + escHtml(fmtPeso(selected.price)) + '</span>';
            recap.appendChild(row);
        });
    });
    return recap;
}

// Renders one category's dish grid + pax picker (used both for single-
// category sections like Pasta/Dessert/Rice, and for whichever protein
// tab is active under Main Dish).
function buildCateringCategoryBlock(group) {
    // Every dish currently picked under this one category (e.g. every
    // Chicken dish chosen so far) — a category can hold more than one now,
    // so this is an array rather than a single selection.
    const selections = getCateringSelection(group.cat);
    const wrap = document.createElement('div');

    // Any section with a configured max (the package's configured cap for
    // that tag — e.g. Main Dish's "3 dishes" inclusion, or any other
    // section an admin has set a Max select restriction for) disables
    // *unpicked* cards, across every category in the section, once the cap
    // is reached — a dish already in the cart can still be unpicked to
    // free up room for a different one.
    const sectionMax = getCateringSectionMax(group.tag);
    const atSectionCap = sectionMax !== null && getCateringSectionSelectedCount(group.tag) >= sectionMax;

    if (atSectionCap && !selections.length) {
        const sectionLabel = CATERING_SECTION_META[group.tag]?.label || group.tag;
        const capNote = document.createElement('p'); capNote.className = 'pax-hint';
        capNote.textContent = `You\u2019ve reached the ${sectionMax}-dish limit for ${sectionLabel}. Remove one to pick a different option.`;
        wrap.appendChild(capNote);
    }

    const grid = document.createElement('div'); grid.className = 'dish-grid';
    group.items.forEach(item => {
        const isSelected = isDishSelected(group.cat, item);
        // Only unpicked cards get locked out at the cap — a selected card
        // stays clickable so it can always be removed.
        const disableAdd = atSectionCap && !isSelected;
        const dc = document.createElement('div');
        dc.className = 'dish-card' + (isSelected ? ' selected' : '') + (disableAdd ? ' disabled' : '');
        dc.innerHTML =
            '<div class="dish-name">' + item + '</div>' +
            '<div class="dish-status checked">&#10003; Selected</div>' +
            '<div class="dish-status remove">&#10005; Click to remove</div>';
        if (disableAdd) {
            dc.onclick = null;
        } else if (group.tag === 'drinks') {
            // No pax bracket for drinks — picking the card finalizes it
            // immediately instead of opening the pax-wrapper below.
            dc.onclick = () => { if (isSelected) clearCateringSelection(group.cat, item); else handleCateringFlatSelected(group.cat, item); rebuildCateringUI(); };
        } else {
            dc.onclick = () => { if (isSelected) clearCateringSelection(group.cat, item); else setCateringSelection(group.cat, item, null); rebuildCateringUI(); };
        }
        grid.appendChild(dc);
    });
    wrap.appendChild(grid);

    // A picked dish is already complete the moment it's clicked — it
    // inherits the global pax from the Pax Count step. "Customize pax"
    // only needs to appear (per-dish, optional) for the customer to
    // override that default; Drinks never gets it since drinks are always
    // flat-priced regardless of headcount. One summary row (with its own
    // optional pax picker) is rendered per selected dish, since each pick
    // under this category can be customized independently.
    if (selections.length && group.tag !== 'drinks') {
        selections.forEach(selected => {
            const dishKey = group.cat + '|' + selected.dish;
            const isCustomizing = !!S.cateringPaxCustomizeOpen[dishKey];

            const summary = document.createElement('div'); summary.className = 'pax-summary-row';
            summary.innerHTML =
                (selections.length > 1 ? '<span class="pax-summary-dish">' + escHtml(selected.dish) + '</span>' : '') +
                '<span class="pax-summary-text">' + (selected.pax === true ? '' : selected.pax + ' pax per tray \u00b7 ') +
                '<b>' + escHtml(fmtPeso(selected.price)) + '</b>' +
                (selected.customized ? ' <span class="pax-custom-badge">Customized</span>' : '') + '</span>';

            if (!isCustomizing) {
                const actions = document.createElement('div'); actions.className = 'pax-summary-actions';
                const custBtn = document.createElement('button');
                custBtn.type = 'button'; custBtn.className = 'pax-link-btn';
                custBtn.textContent = 'Customize pax';
                custBtn.onclick = () => { S.cateringPaxCustomizeOpen[dishKey] = true; rebuildCateringUI(); };
                actions.appendChild(custBtn);

                if (selected.customized) {
                    const resetBtn = document.createElement('button');
                    resetBtn.type = 'button'; resetBtn.className = 'pax-link-btn';
                    resetBtn.textContent = 'Reset to default';
                    resetBtn.onclick = () => resetCateringPaxToDefault(group.cat, selected.dish);
                    actions.appendChild(resetBtn);
                }
                summary.appendChild(actions);
            }
            wrap.appendChild(summary);

            // The pax-per-tray picker only shows up while actively
            // customizing this particular dish — not on every dish, all
            // the time.
            if (isCustomizing) {
                const paxWrap = document.createElement('div'); paxWrap.className = 'pax-wrapper visible';
                const paxTop  = document.createElement('div'); paxTop.className = 'pax-top';
                paxTop.innerHTML = '<span class="pax-top-label">Pax per tray' + (selections.length > 1 ? ' \u2014 ' + escHtml(selected.dish) : '') + '</span>';
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button'; cancelBtn.className = 'pax-link-btn';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => { S.cateringPaxCustomizeOpen[dishKey] = false; rebuildCateringUI(); };
                paxTop.appendChild(cancelBtn);
                paxWrap.appendChild(paxTop);

                const paxBtns = document.createElement('div'); paxBtns.className = 'pax-buttons';
                [20, 30, 40, 50].forEach(n => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'pax-btn' + (selected.pax === n ? ' selected' : '');
                    btn.textContent = n + ' pax';
                    btn.onclick = () => {
                        S.cateringPaxCustomizeOpen[dishKey] = false;
                        handleCateringPaxSelected(group.cat, selected.dish, n);
                    };
                    paxBtns.appendChild(btn);
                });
                paxWrap.appendChild(paxBtns);
                wrap.appendChild(paxWrap);
            }
        });
    }

    return wrap;
}

function renderCateringCart() {
    const rows      = document.getElementById('catering-tray-rows');
    const emptyEl   = document.getElementById('catering-cart-empty');
    const footerEl  = document.getElementById('catering-cart-footer');
    const badgeEl   = document.getElementById('catering-cart-badge');
    const runningEl = document.getElementById('catering-cart-running-total');
    const countEl   = document.getElementById('catering-cart-footer-count');
    const totalEl   = document.getElementById('catering-tray-total');
    const noticeEl  = document.getElementById('catering-validation-notice');
    const noticeText = document.getElementById('catering-validation-text');
    const clearAllBtn = document.getElementById('catering-cart-clear-all');

    const count = getCateringCartCount();
    const total = getCateringCartTotal();
    rows.innerHTML = '';
    if (badgeEl) badgeEl.textContent = count;
    if (runningEl) runningEl.textContent = fmtPeso(total);
    if (clearAllBtn) clearAllBtn.style.display = count ? 'inline-flex' : 'none';

    if (!count) {
        if (emptyEl)  emptyEl.style.display = 'block';
        if (footerEl) footerEl.style.display = 'none';
    } else {
        if (emptyEl)  emptyEl.style.display = 'none';
        if (footerEl) footerEl.style.display = 'flex';
        if (countEl)  countEl.textContent = count + ' dish' + (count !== 1 ? 'es' : '') + ' selected';
        if (totalEl)  totalEl.textContent = fmtPeso(total);

        S.cateringCart.filter(i => i && i.pax).forEach(item => {
            const row = document.createElement('div'); row.className = 'cart-item';
            row.innerHTML =
                '<div class="ci-indicator"></div>' +
                '<div><div class="ci-cat">' + item.cat + '</div>' +
                '<div class="ci-dish">' + item.dish + '</div>' +
                (item.pax === true ? '' : '<div class="ci-pax">' + item.pax + ' pax</div>') + '</div>' +
                '<div class="ci-right"><span class="ci-price">' + fmtPeso(item.price) + '</span>' +
                '<button type="button" class="ci-remove-btn" data-cat="' + escHtml(item.cat) + '" data-dish="' + escHtml(item.dish) + '">Remove</button></div>';
            rows.appendChild(row);
        });

        rows.querySelectorAll('.ci-remove-btn').forEach(btn => {
            btn.onclick = () => { clearCateringSelection(btn.dataset.cat, btn.dataset.dish); rebuildCateringUI(); };
        });
    }

    if (clearAllBtn) clearAllBtn.onclick = clearAllCateringSelections;

    if (noticeEl) {
        noticeEl.className = 'validation-notice' + (isCateringSelectionValid() ? ' success' : '');
        if (noticeEl.querySelector('.vn-icon')) {
            noticeEl.querySelector('.vn-icon').textContent = isCateringSelectionValid() ? '✅' : '⚠️';
        }
        if (noticeText) {
            if (isCateringSelectionValid()) {
                noticeText.textContent = 'Your menu meets the requirements. You can proceed.';
            } else {
                const missing = getCateringSections()
                    .filter(section => !isCateringSectionValid(section))
                    .map(section => {
                        if (section.tag === 'pax') return 'your pax count';
                        const min = getCateringSectionMin(section.tag);
                        if (min > 1) {
                            const remaining = min - getCateringSectionSelectedCount(section.tag);
                            return remaining + ' ' + section.label.toLowerCase() + ' dish' + (remaining === 1 ? '' : 'es');
                        }
                        return '1 ' + section.label.toLowerCase();
                    });
                noticeText.textContent = 'Still needed: ' + missing.join(', ') + '.';
            }
        }
    }
}

function rebuildCateringUI() { buildCateringDishBuilder(); }

// ── Time grid ──────────────────────────────────────────────────────────
let timeGridRequestToken = 0;

function findAvailableStartTimeRow(timeLabel) {
    return (availabilityState.availableStartTimes || []).find(r => r.timeLabel === timeLabel) || null;
}

function formatTimeOfDay(value) {
    if (!value) return '';
    const [hStr, mStr] = String(value).split(':');
    let h = parseInt(hStr, 10);
    if (Number.isNaN(h)) return '';
    const m = (mStr || '00').padStart(2, '0');
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m} ${suffix}`;
}

function renderEndTimeReadout() {
    if (!timeEndReadout) return;
    const row = S.time ? findAvailableStartTimeRow(S.time) : null;
    if (row && row.endTime) {
        timeEndReadout.textContent = `Ends at: ${formatTimeOfDay(row.endTime)}`;
        timeEndReadout.classList.remove('hidden');
    } else {
        timeEndReadout.textContent = '';
        timeEndReadout.classList.add('hidden');
    }
}

async function buildTimeGrid() {
    const g = document.getElementById('time-grid');
    if (!g) return;

    const selectedScope = getSelectedBookingScope();
    const selectedAvail = availabilityState.selectedDateAvailability || { scopeTaken: false };
    const override      = availabilityState.timeStatusOverride || '';
    const selectedLabel = getSelectedPackageOrCategoryLabel() || (selectedScope ? getScopeLabel(selectedScope) : '');

    g.innerHTML = '';
    availabilityState.availableStartTimes = [];

    if (!S.eventDate) {
        if (timeStatusNote) timeStatusNote.textContent = override || (selectedScope
            ? `Choose an available date for the ${selectedLabel} booking slot first.`
            : 'Choose your location and package first, then pick an available date to unlock time slots.');
        renderEndTimeReadout();
        return;
    }

    if (!selectedScope) {
        if (timeStatusNote) timeStatusNote.textContent = 'Choose your location and package first so the correct booking slot can be checked.';
        renderEndTimeReadout();
        return;
    }

    if (selectedAvail.scopeTaken) {
        S.time = '';
        if (timeStatusNote) timeStatusNote.textContent = 'This date is fully booked.';
        renderEndTimeReadout();
        return;
    }

    const requestToken = ++timeGridRequestToken;
    g.innerHTML = '<p class="time-grid-loading">Loading available times...</p>';

    let rows = [];
    try {
        rows = await fetchAvailableStartTimes(supabase, {
            eventDate: S.eventDate,
            scope: selectedScope,
            durationHours: getSelectedDurationHours(),
            venueId: S.venueId
        });
    } catch (err) {
        if (requestToken !== timeGridRequestToken) return;
        g.innerHTML = '';
        if (timeStatusNote) timeStatusNote.textContent = 'Could not load available times. Please try again.';
        renderEndTimeReadout();
        return;
    }

    if (requestToken !== timeGridRequestToken) return; // superseded by a newer request

    availabilityState.availableStartTimes = rows;
    g.innerHTML = '';

    if (S.time && !rows.some(r => r.timeLabel === S.time && r.isAvailable)) {
        S.time = ''; // previously chosen time is no longer valid (duration/scope/date changed)
    }

    if (!rows.length) {
        if (timeStatusNote) timeStatusNote.textContent = `${selectedLabel} has no valid start times for this package's duration within operating hours.`;
    } else if (timeStatusNote) {
        const anyBlocked = rows.some(r => !r.isAvailable);
        timeStatusNote.textContent = anyBlocked
            ? `${selectedLabel} is open on this date. Disabled times overlap with an existing reservation.`
            : `${selectedLabel} is open on this date. Choose your event start time below.`;
    }

    rows.forEach(row => {
        const isDisabled = !row.isAvailable;
        const c = document.createElement('div');
        c.className = 'time-card' + (S.time === row.timeLabel ? ' active' : '') + (isDisabled ? ' disabled' : '');
        c.textContent = row.timeLabel;
        c.title = isDisabled
            ? (row.reason || `${selectedLabel} is unavailable at ${row.timeLabel} due to an overlapping reservation.`)
            : `Choose ${row.timeLabel} as your start time.`;

        c.onclick = () => {
            if (isDisabled) return;
            S.time = row.timeLabel;
            g.querySelectorAll('.time-card').forEach(x => x.classList.remove('active'));
            c.classList.add('active');
            renderEndTimeReadout();
        };
        g.appendChild(c);
    });

    renderEndTimeReadout();
}

// ── Summary ────────────────────────────────────────────────────────────
function buildSummary() {
    const box = document.getElementById('summary-content');
    if (!box) return;

    let pkgRows = '';
    let total   = 0;
    // Only a real onsite/offsite package can carry a discount — catering
    // is cart-priced with no single package.price to discount (the same
    // exemption the price-floor DB trigger already gives it), and add-ons
    // are never discounted (the discount applies to the package/tier price
    // only), so discountAmount below only ever comes off S.miniPackage /
    // S.offsitePackage, never S.snackAddon or the catering cart.
    let discount = { active: false, discountAmount: 0, label: '' };

    // Additional Per-Head — added into `total` alongside the package price
    // so it flows through the same discount/service-charge math below
    // exactly like an add-on does; itemised as its own row rather than
    // folded into the Package line (supabase/migrations/20261018_
    // additional_per_head.sql — subtotal = base − discount + additional
    // charge + add-ons, discount only ever applies to the package portion).
    // Null for catering-flagged packages (see getSelectedPackageForAdditionalHead()).
    const additionalHeadPkg = getSelectedPackageForAdditionalHead();
    const additionalHeadCharge = (additionalHeadPkg?.allowAdditionalHead && S.additionalHeads > 0)
        ? S.additionalHeads * Number(additionalHeadPkg.pricePerAdditionalHead || 0)
        : 0;
    const additionalHeadRowHtml = additionalHeadCharge > 0
        ? sr('Additional Guests', '+' + S.additionalHeads + ' &times; ' + fmtPeso(additionalHeadPkg.pricePerAdditionalHead) + ' = +' + fmtPeso(additionalHeadCharge), 'users-plus')
        : '';

    if (isCateringPackage(getActivePackage())) {
        const catObj = (S.locationType === 'onsite' ? ONSITE_CATEGORIES : OFFSITE_CATEGORIES).find(c => c.id === S.categoryId);
        const cateringPkg = getActivePackage();
        pkgRows += sr('Service', catObj ? catObj.name : 'Catering', 'tools-kitchen-2');
        pkgRows += sr('Package', cateringPkg.label, 'package');
        const cateringItems = Array.isArray(cateringPkg?.inclusions) ? cateringPkg.inclusions.filter(i => i && i.trim()) : [];
        const cateringOffer = cateringItems.find(i => /^\s*special offer\s*:/i.test(i));
        const cateringPlainItems = cateringItems.filter(i => i !== cateringOffer);
        if (cateringPlainItems.length) pkgRows += sr('Inclusions', cateringPlainItems.join(', '), 'list-check');
        else if (cateringPkg?.desc) pkgRows += sr('Inclusions', cateringPkg.desc, 'list-check');
        if (cateringOffer) pkgRows += sr('Special Offer', cateringOffer.replace(/^\s*special offer\s*:\s*/i, ''), 'gift');
        S.cateringCart.filter(i => i && i.pax).forEach(i => {
            total += i.price;
            pkgRows += sr(i.cat + ' (' + i.pax + ' pax)', i.dish + ' &mdash; ' + fmtPeso(i.price), 'users');
        });
        if (total === 0) pkgRows += sr('Price', 'Contact for quote', 'tag');
    } else if (S.locationType === 'onsite') {
        if (S.miniPackage) {
            total += S.miniPackage.price;
            pkgRows += sr('Package', S.miniPackage.label + ' &mdash; ' + fmtPeso(S.miniPackage.price), 'package');
            pkgRows += additionalHeadRowHtml;
            total += additionalHeadCharge;
            discount = getPkgDiscount(S.miniPackage);
        }
        if (S.snackAddon) {
            total += S.snackAddon.price;
            pkgRows += sr('Add-on', S.snackAddon.label + ' &mdash; ' + fmtPeso(S.snackAddon.price), 'plus');
        }
    } else if (S.offsitePackage) {
        const catObj = OFFSITE_CATEGORIES.find(c => c.id === S.categoryId);
        total = S.offsitePackage.price + additionalHeadCharge;
        pkgRows += sr('Service', catObj ? catObj.name : '', 'tools-kitchen-2');
        pkgRows += sr('Package', S.offsitePackage.label, 'package');
        if (S.offsitePackage.price > 0) pkgRows += sr('Price', fmtPeso(S.offsitePackage.price), 'tag');
        pkgRows += additionalHeadRowHtml;
        discount = getPkgDiscount(S.offsitePackage);
    }

    // Discount reduces the base BEFORE the service charge — the critical
    // ordering the whole feature depends on. Itemised as its own line
    // (Package -> Discount -> Subtotal -> Service charge -> Total), never
    // folded silently into a lower package price.
    const discountedTotal = total - discount.discountAmount;
    const charge = resolveServiceCharge(discountedTotal, S.locationType, S.categoryId);
    // Subtotal/Service charge/Discount/Total are the receipt-style lines of
    // the Total card — deliberately icon-less (unlike every Event/Contact
    // row) so that card reads as a plain receipt, not another field list.
    const discountRowHtml = discount.active
        ? sr('Discount' + (discount.label ? ' (' + discount.label + ')' : ''), '&minus;' + fmtPeso(discount.discountAmount))
        : '';
    const pricingRowsHtml = total > 0
        ? discountRowHtml +
          sr('Subtotal', fmtPeso(discountedTotal)) +
          sr('Service charge (' + charge.pct + '%)', fmtPeso(charge.amount)) +
          totalRow('Total', fmtPeso(charge.total))
        : totalRow('Total', 'Contact for quote');

    const locStr   = S.locationType === 'onsite' ? 'Onsite &mdash; ELI Coffee' : 'Offsite' + (S.venueLocation ? ' &mdash; ' + S.venueLocation : '');
    const displayEventType = S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType;

    // Effective final guest count — base pax (Max Guests) + additional
    // heads once any are added, same formula the server recomputes
    // guest_count to (enforce_reservation_capacity(), 20261018_additional_
    // per_head.sql). Unaffected (stays exactly what the customer typed)
    // when no additional heads are involved.
    const effectiveGuestCount = additionalHeadCharge > 0
        ? Number(additionalHeadPkg.max_guests || S.guestCount) + S.additionalHeads
        : S.guestCount;

    const eventRows =
        sr('Location',   locStr, 'building-store') +
        pkgRows +
        sr('Guests',     effectiveGuestCount, 'users') +
        sr('Event Type', displayEventType, 'confetti') +
        sr('Date',       formatDisplayDate(S.eventDate) || S.eventDate, 'calendar') +
        sr('Time',       S.time, 'clock');

    const contactRows =
        sr('Name',  S.name, 'user') +
        sr('Email', S.email, 'mail') +
        sr('Phone', S.phone, 'phone') +
        (S.requests ? sr('Requests', S.requests, 'message') : '');

    box.innerHTML =
        '<div class="rs-summary-cards">' +
        summaryCard('Event',    eventRows) +
        summaryCard('Contact',  contactRows) +
        summaryCard('Total',    pricingRowsHtml) +
        '</div>';

    document.getElementById('guest-warning').classList.toggle('hidden', isLoggedIn);
}

function summaryCard(title, rowsHtml) {
    if (!rowsHtml) return '';
    return '<div class="rs-summary-card"><p class="rs-summary-card-title">' + title + '</p>' + rowsHtml + '</div>';
}

function sr(label, value, icon) {
    const iconHtml = icon ? '<i class="ti ti-' + icon + '" aria-hidden="true"></i>' : '';
    return '<div class="rs-summary-row"><span class="rs-row-label">' + iconHtml + label + '</span><span class="rs-row-value">' + value + '</span></div>';
}

function totalRow(label, value) {
    return '<div class="rs-summary-total-row"><span class="rs-row-label">' + label + '</span><span class="rs-row-value">' + value + '</span></div>';
}

// ── Contract download ──────────────────────────────────────────────────

// ── Contact prefill ────────────────────────────────────────────────────
function getReservationContactName(profile, user) {
    return [profile?.first_name, profile?.middle_name, profile?.last_name].filter(Boolean).join(' ').trim() || user?.email || '';
}

function applyReservationContactPrefill(profile, user) {
    const fullName = getReservationContactName(profile, user);
    const email    = profile?.email || user?.email || '';
    const phone    = profile?.phone_number || user?.user_metadata?.phone_number || '';
    // Name always reflects the account's current name — it's read-only in
    // this step, so unlike phone/email there's no "customer already typed
    // something, don't clobber it" case to guard against.
    if (nameInput) nameInput.value = fullName;
    if (phoneInput && !phoneInput.value.trim()) phoneInput.value = phone;
    if (emailInput && !emailInput.value.trim()) emailInput.value = email;
    S.name  = nameInput?.value.trim()  || S.name;
    S.phone = phoneInput?.value.trim() || S.phone;
    S.email = emailInput?.value.trim() || S.email;
    setContactFieldsLoading(false);
}

async function prefillReservationContactDetails() {
    const user = session?.user;
    if (!user) return;
    setContactFieldsLoading(true);
    const fallback = { first_name: user.user_metadata?.first_name || '', middle_name: user.user_metadata?.middle_name || '', last_name: user.user_metadata?.last_name || '', email: user.email || '', phone_number: user.user_metadata?.phone_number || '' };
    try {
        const { data: profile, error } = await supabase.from('profiles').select('first_name, middle_name, last_name, email, phone_number').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        applyReservationContactPrefill(profile || fallback, user);
    } catch {
        applyReservationContactPrefill(fallback, user);
    }
}

// ── Step display ───────────────────────────────────────────────────────
function showStep(n) {
    document.querySelectorAll('.res-step').forEach(s => s.classList.remove('active'));
    const stepEl = document.getElementById(sid(n));
    if (stepEl) stepEl.classList.add('active');

    document.getElementById('progress').style.width = (n / total() * 100) + '%';
    document.getElementById('step-text').textContent = 'Step ' + n + ' of ' + total() + ': ' + (STEP_LABELS[n - 1] || '');

    document.getElementById('prevBtn').classList.toggle('hidden', n === 1);
    document.getElementById('nextBtn').textContent = n === total() ? 'Submit' : 'Next →';

    populate(sid(n));
    saveDraft();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function populate(id) {
    if (id === 'rs1') {
        // Restore location card active state
        document.querySelectorAll('.location-card').forEach(c => {
            c.classList.toggle('active', c.dataset.val === S.locationType);
        });
        // Build the category chip grid, then package options based on saved category
        buildCategoryGrid();
        buildPackageStep();
        // Build event type select (always ready so it renders when unlocked)
        buildEventTypeSelect();
        // Restore guest count field
        const gcEl = document.getElementById('guest-count');
        if (gcEl && S.guestCount) gcEl.value = S.guestCount;
        // Apply locked/unlocked state to sections 1C and 1D
        updateSectionLocks();
        // Build add-ons / venue section
        buildAddonOrVenueStep();
        // Additional Per-Head — reflects S.additionalHeads (e.g. restored
        // from a saved draft) against the now-rendered DOM controls.
        buildAdditionalHeadBlock();
        // Calendar and time
        updateDateDisplayPlaceholder();
        loadAvailabilityCalendar();
        buildTimeGrid();
    }
    if (id === 'rs6')  buildSummary();
    if (id === 'rs7')  buildContractStep();
    if (id === 'rs4' && isLoggedIn) prefillReservationContactDetails();
}

// ── Validation ─────────────────────────────────────────────────────────
function validate(n) {
    const id = sid(n);

    if (id === 'rs1') {
        // 1A — Location
        if (!S.locationType) {
            showWarningModal('Please choose whether your event is onsite or offsite.');
            scrollToSection('sub-loc'); return false;
        }

        // 1B — Package
        if (S.locationType === 'onsite') {
            if (!S.miniPackage) {
                showWarningModal('Please select a package before continuing.');
                scrollToSection('sub-pkg'); return false;
            }
        } else {
            if (!S.categoryId) {
                showWarningModal('Please select an offsite service category.');
                scrollToSection('sub-pkg'); return false;
            }
            if (!S.offsitePackage) {
                showWarningModal('Please select a specific package before continuing.');
                scrollToSection('sub-pkg'); return false;
            }
        }

        // 1B — Catering dish builder — checked for either location type,
        // since a catering-flagged package (isCateringPackage()) drives
        // this wizard regardless of onsite/offsite.
        if (isCateringPackage(getActivePackage())) {
            if (cateringMenuUnavailable) {
                showWarningModal('This package doesn\u2019t have a catering menu available yet. Please choose a different package, or contact us directly to book it.');
                scrollToSection('sub-pkg'); return false;
            }
            if (!isCateringSelectionValid()) {
                const firstInvalidSection = getFirstIncompleteCateringSection();
                if (firstInvalidSection) scrollToCateringSection(firstInvalidSection.tag);
                const missing = getCateringSections()
                    .filter(section => !isCateringSectionValid(section))
                    .map(section => section.tag === 'main' ? 'at least 1 main dish' : '1 ' + section.label.toLowerCase());
                showWarningModal('Please select ' + missing.join(', ') + ' for your catering package.');
                scrollToSection('sub-pkg'); return false;
            }
        }

        // 1C — Guest count
        const raw = document.getElementById('guest-count')?.value.trim();
        const gc  = parseInt(raw, 10);
        if (!raw || isNaN(gc) || gc < 1) {
            showWarningModal('Please enter a valid number of guests (at least 1).');
            scrollToSection('sub-guests-type'); return false;
        }
        if (!validateGuestCountRange(gc)) {
            const min = getSelectedPackageMinGuests();
            const max = getSelectedPackageMaxGuests();
            showWarningModal(`Guest count must be between ${min} and ${max} for this package.`);
            scrollToSection('sub-guests-type'); return false;
        }
        S.guestCount = String(gc);

        // 1C — Event type
        if (!S.eventType) {
            showWarningModal('Please select your event type.');
            scrollToSection('sub-guests-type'); return false;
        }
        if (S.eventType === 'Other') {
            const otherText = document.getElementById('event-type-other')?.value.trim();
            if (!otherText) {
                showWarningModal('Please describe your event type in the text field below.');
                scrollToSection('sub-guests-type'); return false;
            }
            S.eventTypeOther = otherText;
        }

        // 1D — Venue pin (offsite only; onsite add-ons are optional)
        if (S.locationType === 'offsite') {
            const venueVal = document.getElementById('venue-location')?.value.trim();
            if (!venueVal) {
                showWarningModal('Please search for your venue address or click the map to drop a pin.');
                scrollToSection('sub-addon-venue'); return false;
            }
            S.venueLocation = venueVal;
        }

        // 1D — Room pick (onsite only, and only when the package maps to
        // more than one venue — a single-venue package already auto-resolved).
        if (S.locationType === 'onsite' && S.venueOptions.length > 1 && !S.venueId) {
            showWarningModal('Please choose which room for your booking.');
            scrollToSection('sub-addon-venue'); return false;
        }

        // 1E — Date
        const ed = document.getElementById('event-date')?.value;
        if (!ed) {
            showWarningModal('Please choose an available date from the calendar.');
            scrollToSection('sub-date'); return false;
        }
        const d = new Date(ed), today = new Date(); today.setHours(0, 0, 0, 0);
        if (d < today) {
            showWarningModal('Please select a future date.');
            scrollToSection('sub-date'); return false;
        }
        if (isUnavailableDate(ed)) {
            showWarningModal('The selected date is not available for this booking type. Please choose another date.');
            scrollToSection('sub-date'); return false;
        }
        S.eventDate = ed;

        // 1F — Time
        if (!S.time) {
            showWarningModal('Please select a start time.');
            scrollToSection('sub-time'); return false;
        }

        return true;
    }

    if (id === 'rs4') {
        const name     = document.getElementById('name')?.value.trim();
        const phone    = document.getElementById('phone')?.value.trim();
        const email    = document.getElementById('email')?.value.trim();
        const requests = document.getElementById('requests')?.value.trim() || '';
        if (!name || !email) { showWarningModal('Please fill in all contact details.'); return false; }
        if (FORM_CONFIG.fieldRules.contact_phone_required && !phone) { showWarningModal('Please fill in all contact details.'); return false; }
        if (FORM_CONFIG.fieldRules.special_requests_required && !requests) { showWarningModal('Please let us know your special requests before continuing.'); return false; }
        if (!/^\S+@\S+\.\S+$/.test(email)) { showWarningModal('Please enter a valid email address.'); return false; }
        S.name = name; S.phone = phone; S.email = email;
        S.requests = requests;
        return true;
    }

    if (id === 'rs6') {
        if (!isLoggedIn) { document.getElementById('guest-warning').classList.remove('hidden'); return false; }
        return true;
    }

    if (id === 'rs7') {
        if (!isSignaturePresent()) {
            setSignatureStatus(signatureState.mode === 'draw' ? 'Please sign to continue.' : 'Please type your name to continue.', true);
            return false;
        }
        if (!contractAgreementTerms?.checked) {
            setContractPolicyMessage('Please agree to the Terms & Conditions and Data Privacy Policy before submitting.', 'error'); return false;
        }
        if (!signatureState.agreementViewMethod) {
            setContractPolicyMessage('Please read the agreement first — scroll the preview to the bottom or open the full view.', 'error'); return false;
        }
        if (!contractAgreementEsign?.checked) {
            setContractPolicyMessage('Please confirm your details are accurate and that you are signing electronically.', 'error'); return false;
        }
        setSignatureStatus('');
        setContractPolicyMessage('');
        return true;
    }

    return true;
}

// ── Section lock helpers ────────────────────────────────────────────────
function isGuestsTypeUnlocked() {
    if (!S.locationType) return false;
    if (S.locationType === 'onsite') return !!S.miniPackage;
    // Offsite: unlock once a category is chosen (catering dish validation happens at submit)
    return !!S.categoryId;
}

function updateSectionLocks() {
    const unlocked = isGuestsTypeUnlocked();

    // ── Guests + Event Type (1C) ──
    const lockMsg  = document.getElementById('guests-type-status');
    const content  = document.getElementById('guests-type-content');
    const gcInput  = document.getElementById('guest-count');
    const etSelect = document.getElementById('event-type-select');
    if (lockMsg)  lockMsg.classList.toggle('hidden', unlocked);
    if (content)  content.classList.toggle('res-locked-content', !unlocked);
    if (gcInput)  gcInput.disabled = !unlocked;
    if (etSelect) etSelect.disabled = !unlocked;

    // ── Add-ons / Venue (1D) ──
    const addonMsg     = document.getElementById('addon-venue-status');
    const addonContent = document.getElementById('addon-venue-content');
    if (addonMsg)     addonMsg.classList.toggle('hidden', unlocked);
    if (addonContent) addonContent.classList.toggle('res-locked-content', !unlocked);
}

function scrollToSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: 'smooth' });
}

// ── Card / pill helpers ────────────────────────────────────────────────
function card(html, isActive) {
    const d = document.createElement('div');
    d.className = 'pkg-card' + (isActive ? ' active' : '');
    d.innerHTML = html;
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-pressed', String(!!isActive));
    d.addEventListener('keydown', (e) => {
        // Let native controls inside the card (e.g. the "View full
        // details" link) handle their own Enter/Space activation.
        if (e.target !== d && e.target.closest('a,button')) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); }
    });
    return d;
}

function activate(container, el) {
    container.querySelectorAll('.pkg-card').forEach(c => {
        c.classList.remove('active');
        c.setAttribute('aria-pressed', 'false');
    });
    el.classList.add('active');
    el.setAttribute('aria-pressed', 'true');
}

// Real, enforced gate for guests: intercepts the attempt to leave the
// Review step (or submit from Contract) with a modal instead of silently
// refusing or letting them proceed. The actual enforcement is server-side
// (RLS on public.reservations only allows an authenticated user to insert
// a row as themselves — see supabase/migrations/20260930_reservations_
// insert_rls.sql, confirmed live: an unauthenticated insert is rejected);
// this modal only surfaces that requirement earlier and more clearly than
// discovering it at submission time. saveDraft() runs immediately (rather
// than relying only on the pagehide/visibilitychange listeners) so the
// in-progress booking is guaranteed to be there when Sign In/Create
// Account bring the customer back.
async function showGuestSubmitGateModal() {
    saveDraft();
    const result = await showFeedbackModal({
        type: 'info',
        icon: 'ti-lock',
        title: 'Sign in to complete your booking',
        message: "You're almost done — an account is required to submit a reservation. Your progress on this form is saved and won't be lost.",
        confirmText: 'Sign In',
        tertiaryText: 'Create Account',
        dismissText: 'Continue browsing'
    });
    if (result === true) {
        window.location.href = '/login?redirect=' + encodeURIComponent('/reservations');
    } else if (result === 'tertiary') {
        window.location.href = '/signup?redirect=' + encodeURIComponent('/reservations');
    }
    // false (Escape/backdrop/"Continue browsing") — stay on the form as-is.
}

// Gate for guests at the Step 1 → Step 2 transition specifically (not
// within Step 1 itself — every field there, including the public
// availability calendar, stays fully browsable for guests). Fires only
// after validate(cur) has already passed, so a guest still gets normal
// per-field validation feedback while filling out Step 1 instead of being
// blocked before they've even finished it. The rs6/rs7 gate above stays in
// place independently as defense-in-depth (e.g. a session that expires
// mid-flow after this point).
async function showGuestStep1GateModal() {
    // Save the draft one step ahead (as rs4/Step 2), matching where a
    // logged-in customer would land from this same click, so that once
    // auth completes and the existing draft-resume prompt reappears on
    // /reservations, "Continue" resumes directly on Step 2 instead of
    // back on Step 1 — the customer never has to reselect anything.
    const stepBeforeGate = cur;
    cur = Math.min(cur + 1, total());
    saveDraft();
    cur = stepBeforeGate;

    const result = await showFeedbackModal({
        type: 'warning',
        icon: 'ti-lock',
        title: 'Sign in to continue your booking',
        message: "Create an account or sign in to continue — your selections so far will be saved.",
        confirmText: 'Sign In',
        tertiaryText: 'Create Account',
        dismissText: 'Continue Browsing'
    });
    if (result === true) {
        window.location.href = '/login?redirect=' + encodeURIComponent('/reservations');
    } else if (result === 'tertiary') {
        window.location.href = '/signup?redirect=' + encodeURIComponent('/reservations');
    }
    // false (Escape/backdrop/"Continue Browsing") — stay on Step 1 as-is.
}

// ── Event listeners ────────────────────────────────────────────────────
document.getElementById('nextBtn').onclick = () => {
    // Guests may browse and fill out every step, but can't advance past
    // the Review (rs6) summary — an account is required to actually create
    // the reservation. Checked here, before validate(), so the same guard
    // also covers a guest somehow still parked on rs7 (e.g. a session that
    // expired mid-flow) clicking Submit.
    if (!isLoggedIn && (sid(cur) === 'rs6' || sid(cur) === 'rs7')) {
        document.getElementById('guest-warning')?.classList.remove('hidden');
        showGuestSubmitGateModal();
        return;
    }
    if (!validate(cur)) return;
    // Guests may fully complete Step 1, but can't advance into Step 2
    // (account details/notes) without signing in — checked AFTER
    // validate() succeeds, unlike the rs6/rs7 gate above, so guests still
    // get normal per-field validation feedback while working through Step 1.
    if (!isLoggedIn && sid(cur) === 'rs1') {
        showGuestStep1GateModal();
        return;
    }
    if (cur < total()) { cur++; showStep(cur); }
    else { submitDone(); }
};

document.getElementById('prevBtn').onclick = () => {
    if (cur > 1) { cur--; showStep(cur); }
};

document.querySelectorAll('.location-card').forEach(c => {
    c.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); }
    });
    c.onclick = () => {
        document.querySelectorAll('.location-card').forEach(x => {
            x.classList.remove('active');
            x.setAttribute('aria-pressed', 'false');
        });
        c.classList.add('active');
        c.setAttribute('aria-pressed', 'true');
        const prev = S.locationType;
        S.locationType = c.dataset.val;
        // Reset downstream selections when location type changes
        if (prev !== S.locationType) {
            S.categoryId      = '';
            S.miniPackage     = null;
            S.venueOptions    = [];
            S.venueId         = null;
            S.additionalHeads = 0;
            S.snackAddon      = null;
            S.offsitePackage  = null;
            S.cateringCart    = [];
            S.cateringActiveMain = null;
            S.cateringOpenSection = null;
            S.cateringGlobalPax = null;
            S.cateringPaxCustomizeOpen = {};
            S.time            = '';
            syncSelectedDate('');
        }
        buildCategoryGrid();
        buildPackageStep();
        updateSectionLocks();
        buildAddonOrVenueStep();
        buildAdditionalHeadBlock();
        refreshAvailabilityForSelectedScope();
    };
});

availabilityPrevMonthBtn?.addEventListener('click', async () => {
    availabilityState.month = new Date(availabilityState.month.getFullYear(), availabilityState.month.getMonth() - 1, 1);
    await loadAvailabilityCalendar();
});

availabilityNextMonthBtn?.addEventListener('click', async () => {
    availabilityState.month = new Date(availabilityState.month.getFullYear(), availabilityState.month.getMonth() + 1, 1);
    await loadAvailabilityCalendar();
});

contractAgreementTerms?.addEventListener('change', () => {
    S.contractAgreementTermsChecked = contractAgreementTerms.checked;
    if (contractAgreementTerms.checked) setContractPolicyMessage('');
});
contractAgreementEsign?.addEventListener('change', () => {
    S.contractAgreementEsignChecked = contractAgreementEsign.checked;
    if (contractAgreementEsign.checked) setContractPolicyMessage('');
});
// Only one signature format is ever submitted — switching modes discards
// whichever one the customer is leaving. Confirm first if there's actually
// something to lose; an empty mode switches silently.
async function switchSignatureMode(nextMode) {
    if (nextMode === signatureState.mode) return;
    const leavingMode = signatureState.mode;
    const hasContentToLose = leavingMode === 'draw'
        ? !!signatureState.pad && !signatureState.pad.isEmpty()
        : !!(signatureTypeInput?.value || '').trim();

    if (hasContentToLose) {
        const confirmed = await showConfirmModal({
            title: 'Switch signature mode?',
            message: 'Switching will clear your current signature.',
            confirmText: 'Yes, switch',
            cancelText: 'Cancel'
        });
        if (!confirmed) return;
    }

    if (leavingMode === 'draw') {
        signatureState.pad?.clear();
        S.contractSignatureDrawData = null;
        setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, true);
    } else {
        if (signatureTypeInput) signatureTypeInput.value = '';
        if (signatureTypePreview) signatureTypePreview.textContent = '';
        S.contractSignatureTypedText = '';
    }

    S.contractSignatureMode = nextMode;
    setSignatureMode(nextMode);
}

sigModeDrawBtn?.addEventListener('click', () => switchSignatureMode('draw'));
sigModeTypeBtn?.addEventListener('click', () => switchSignatureMode('type'));
signatureClearBtn?.addEventListener('click', () => {
    signatureState.pad?.clear();
    S.contractSignatureDrawData = null;
    setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, true);
    refreshContractGatingUI();
    setSignatureStatus('');
});
signatureTypeInput?.addEventListener('input', () => {
    const text = signatureTypeInput.value.trim();
    S.contractSignatureTypedText = signatureTypeInput.value;
    if (signatureTypePreview) signatureTypePreview.textContent = text;
    fitSignatureTypePreview();
    refreshContractGatingUI();
    setSignatureStatus('');
});
policyButtons.forEach(btn => btn.addEventListener('click', () => openPolicyModal(btn.dataset.policy)));
policyModalClose?.addEventListener('click', closePolicyModal);
policyModalDismiss?.addEventListener('click', closePolicyModal);
policyModalAgree?.addEventListener('click', agreeToPolicies);
policyModalBackdrop?.addEventListener('click', e => { if (e.target === policyModalBackdrop) closePolicyModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !policyModalBackdrop?.classList.contains('hidden')) closePolicyModal(); });

contractViewer?.addEventListener('scroll', () => {
    if (signatureState.agreementViewMethod) return;
    const el = contractViewer;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
        markAgreementViewed('scrolled_inline');
    }
});
contractViewFullBtn?.addEventListener('click', openAgreementModal);
agreementModalCloseBtn?.addEventListener('click', closeAgreementModal);
agreementModalFooterCloseBtn?.addEventListener('click', closeAgreementModal);
agreementModalFinishBtn?.addEventListener('click', closeAgreementModal);
agreementModalBackdrop?.addEventListener('click', e => { if (e.target === agreementModalBackdrop) closeAgreementModal(); });

// ── Submit ─────────────────────────────────────────────────────────────
async function submitDone() {
    const nextBtn = document.getElementById('nextBtn');
    nextBtn.disabled = true; nextBtn.textContent = 'Submitting...';

    try {
        const latestAvail = await fetchDateAvailability(supabase, {
            eventDate: S.eventDate, scope: getSelectedBookingScope(), durationHours: getSelectedDurationHours()
        });
        if (getSelectedBookingScope() && latestAvail.scopeTaken) {
            availabilityState.selectedDateAvailability = latestAvail;
            buildTimeGrid();
            throw new Error('This date is fully booked. A maximum of 2 reservations are accepted per day.');
        }

        const latestStartTimes = await fetchAvailableStartTimes(supabase, {
            eventDate: S.eventDate, scope: getSelectedBookingScope(), durationHours: getSelectedDurationHours(), venueId: S.venueId
        });
        const chosenRow = latestStartTimes.find(r => r.timeLabel === S.time);
        if (!chosenRow || !chosenRow.isAvailable) {
            availabilityState.availableStartTimes = latestStartTimes;
            buildTimeGrid();
            throw new Error('Your selected start time is no longer available. Please choose another time.');
        }

        const { data: { session: freshSession } } = await supabase.auth.getSession();
        if (!freshSession) throw new Error('Please sign in to submit your reservation.');
        const userId = freshSession.user.id;

        if (!isSignaturePresent()) throw new Error('Please sign the contract before submitting.');
        if (!contractAgreementTerms?.checked || !contractAgreementEsign?.checked) {
            throw new Error('Please check both agreement boxes before submitting.');
        }
        if (!signatureState.agreementViewMethod || !signatureState.agreementViewedAt) {
            throw new Error('Please read the agreement (scroll the preview or open the full view) before submitting.');
        }
        const signatureDataUrl = await getSignatureDataUrl();
        if (!signatureDataUrl) throw new Error('Please sign the contract before submitting.');
        const signerName = getSignerName();
        const signatureType = signatureState.mode === 'draw' ? 'drawn' : 'typed';

        let packageId  = null;
        let addOnId    = null;
        let totalPrice = 0;
        // Only a real onsite/offsite package can carry a discount — same
        // package-only, catering-exempt rule as buildSummary()/
        // computeContractPreviewDiscount(). Re-evaluated against the
        // current clock right here (not reused from Step 1) in case the
        // promo's window opened or closed since the customer picked it.
        let discount = { active: false, discountAmount: 0, percentOff: 0, label: '' };

        // Additional Per-Head (supabase/migrations/20261018_additional_per_
        // head.sql) — re-evaluated here the same as discount above, not
        // trusted from Step 1's cached value. The server trigger is the
        // real authority (recomputes/validates all of this independently),
        // but sending the correct figures avoids relying on its fallback.
        // Null for catering-flagged packages (see getSelectedPackageForAdditionalHead()).
        const additionalHeadPkg = getSelectedPackageForAdditionalHead();
        const additionalHeads = additionalHeadPkg?.allowAdditionalHead ? (S.additionalHeads || 0) : 0;
        const additionalHeadPrice = additionalHeadPkg?.allowAdditionalHead ? Number(additionalHeadPkg.pricePerAdditionalHead || 0) : null;
        const additionalHeadCharge = additionalHeads > 0 ? additionalHeads * additionalHeadPrice : 0;

        if (isCateringPackage(getActivePackage())) {
            packageId  = getActivePackage().id;
            totalPrice = S.cateringCart.reduce((sum, i) => sum + i.price, 0);
        } else if (S.locationType === 'onsite') {
            packageId  = S.miniPackage ? S.miniPackage.id : null;
            addOnId    = S.snackAddon  ? S.snackAddon.id  : null;
            totalPrice = (S.miniPackage ? S.miniPackage.price : 0) + (S.snackAddon ? S.snackAddon.price : 0) + additionalHeadCharge;
            discount = getPkgDiscount(S.miniPackage);
        } else {
            packageId  = S.offsitePackage ? S.offsitePackage.id    : null;
            totalPrice = (S.offsitePackage ? S.offsitePackage.price : 0) + additionalHeadCharge;
            discount = getPkgDiscount(S.offsitePackage);
        }

        // Discount reduces the base BEFORE the service charge — same
        // ordering as buildSummary(). Snapshotted below alongside
        // total_price/service_charge_* so a later promo change or expiry
        // never reprices this booking or its signed contract.
        totalPrice -= discount.discountAmount;

        // Service charge is added to the (already discounted) base to
        // reach the total that gets stored — everything downstream
        // (deposit %, custom-amount minimum) reads this same total_price
        // column, so they automatically compute off the post-charge,
        // post-discount figure. Snapshotted alongside total_price so later
        // default/override edits never change an existing booking.
        const serviceCharge = resolveServiceCharge(totalPrice, S.locationType, S.categoryId);
        totalPrice = serviceCharge.total;

        const displayEventType = S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType;

        // Final guest count = base pax (this package's Max Guests) +
        // additional heads, same formula the server trigger recomputes
        // guest_count to when additional_heads > 0 — sent proactively so
        // the summary/contract line up with what's about to be inserted,
        // but the server's own recompute is what's actually authoritative.
        const finalGuestCount = additionalHeads > 0
            ? Number(additionalHeadPkg.max_guests || S.guestCount) + additionalHeads
            : parseInt(S.guestCount);

        const { data: reservation, error: insertError } = await supabase
            .from('reservations')
            .insert({
                user_id:          userId,
                event_type:       displayEventType,
                event_date:       S.eventDate,
                event_time:       S.time,
                guest_count:      finalGuestCount,
                location_type:    S.locationType,
                venue_location:   S.venueLocation || null,
                venue_id:         S.locationType === 'onsite' ? (S.venueId || null) : null,
                package_id:       packageId,
                add_on_id:        addOnId,
                additional_heads:        additionalHeads,
                additional_head_price:   additionalHeads > 0 ? additionalHeadPrice : null,
                additional_head_charge:  additionalHeadCharge,
                total_price:      totalPrice,
                service_charge_percent: serviceCharge.pct,
                service_charge_amount:  serviceCharge.amount,
                discount_percent: discount.active ? discount.percentOff : null,
                discount_amount:  discount.active ? discount.discountAmount : null,
                discount_label:   discount.active ? (discount.label || null) : null,
                contact_name:     S.name,
                contact_email:    S.email,
                contact_phone:    S.phone,
                special_requests: S.requests || null,
                status:           'pending'
            })
            .select('reservation_id')
            .single();

        if (insertError) throw new Error('Reservation save failed: ' + insertError.message);

        const { data: contractResult, error: contractError } = await supabase.functions.invoke('generate-signed-contract', {
            body: {
                reservation_id: reservation.reservation_id,
                signature_data_url: signatureDataUrl,
                signer_name: signerName,
                signature_type: signatureType,
                agreement_view_method: signatureState.agreementViewMethod,
                agreement_viewed_at: signatureState.agreementViewedAt
            }
        });

        if (contractError || !contractResult?.success) {
            throw new Error(contractResult?.error || 'We could not finalize your signed contract. Please try again.');
        }

        // Order matters: lock BEFORE clearing, so a pagehide/visibilitychange
        // firing in the gap between these two lines still hits the guard in
        // saveDraft() rather than racing clearDraft() itself.
        submissionLocked = true;
        clearDraft();

        document.querySelectorAll('.res-step').forEach(s => s.classList.remove('active'));
        document.querySelector('.reservation-buttons').style.display = 'none';
        document.querySelector('.progress-container').style.display  = 'none';

        const msg = document.createElement('div');
        msg.className = 'rs-summary-card';
        msg.style.cssText = 'text-align:center;padding:48px 20px;';
        msg.innerHTML =
            '<i class="ti ti-circle-check" style="font-size:52px;margin-bottom:16px;color:#2E7D4F;" aria-hidden="true"></i>' +
            '<h3 style="color:#2A1408;font-size:22px;margin-bottom:10px;font-weight:700;">Reservation Submitted!</h3>' +
            '<p style="color:#777;line-height:1.8;font-size:15px;">Thank you, <strong>' + S.name + '</strong>!<br>' +
            'Reservation Number: <strong style="color:#6B3A1F;">' + (contractResult.reservation_number || '') + '</strong><br>' +
            'Your reservation is <strong style="color:#6B3A1F;">under review</strong>.<br>' +
            'We\'ll contact you at <strong>' + S.email + '</strong> to confirm.</p>' +
            '<p style="margin-top:14px;"><a href="' + contractResult.contract_url + '" target="_blank" rel="noopener noreferrer" class="dl-btn" style="text-decoration:none;">Download your signed contract</a></p>' +
            '<p style="margin-top:22px;padding-top:22px;border-top:1px solid #EFE8DC;color:#777;font-size:14px;">Enjoyed booking with us?<br>' +
            '<a href="https://www.google.com/maps/place/Eli+Coffee+-+Binangonan/@14.4859006,121.183786,17z/data=!3m1!4b1!4m8!3m7!1s0x3397c323cec4b3b7:0xd94ed9b314980cd5!8m2!3d14.4859006!4d121.1863609!9m1!1b1!16s%2Fg%2F11r10q3pd6?entry=ttu" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#6B3A1F;font-weight:600;text-decoration:none;"><i class="ti ti-brand-google" aria-hidden="true"></i> Leave us a Google Review</a></p>';
        document.querySelector('.reservation-container').appendChild(msg);
        // Collapsing the multi-step form down to this one short card can
        // otherwise leave the browser's scroll position wherever the user
        // last was (mid-form, often near the bottom) — snap to top so the
        // confirmation is what's actually on screen, with no visible scroll.
        window.scrollTo({ top: 0, behavior: 'auto' });

    } catch (err) {
        showWarningModal(err.message, 'Something went wrong', 'error');
        nextBtn.disabled = false; nextBtn.textContent = 'Submit';
    }
}

// ── Initialize ─────────────────────────────────────────────────────────
syncSelectedDate('');
await loadReservationRules();
await loadServiceChargeSettings();
await loadEventTypes();
await loadPackages();

// Safety net: Step 1 alone covers several sub-sections (location →
// category → package → guests/type → add-ons/venue → date → time)
// without calling saveDraft() until "Next" is clicked — so an accidental
// refresh or tab close mid-Step-1 could lose selections made since the
// last step transition. These two listeners flush the latest in-memory
// state right before the page actually goes away, regardless of step.
window.addEventListener('pagehide', saveDraft);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveDraft();
});

// Runs the parts of init that depend on the step/draft decision below
// having already been made (URL params applied, or the resume-vs-start-
// fresh prompt resolved).
function finishInit() {
    // Runs after S.eventType is known (URL params / restored draft) so a
    // pre-selected event type's own min-advance override is accounted
    // for on the very first paint, not just after the user re-picks it.
    advanceToFirstBookableMonth();
    // Prefill contact details for logged-in users (non-blocking)
    prefillReservationContactDetails();
    // Calendar loads after the page renders so the hero is fast
    loadAvailabilityCalendar();
}

// Cross-checks a saved draft against the server before ever offering to
// "resume" it — client-side storage alone isn't trustworthy here: a
// customer who already submitted successfully (this device or a different
// one) after this draft was last saved would otherwise still see a stale
// resume prompt if localStorage wasn't cleared for some reason (browser
// crash, closed tab before the clear call ran, etc.). Finding a
// reservation created at/after the draft's own savedAt timestamp means the
// draft was already carried to completion. Submitting a reservation always
// requires a logged-in customer, so there's no anonymous-draft case here.
async function wasDraftAlreadySubmitted(draft) {
    if (!session?.user?.id) return false;
    try {
        const { data, error } = await supabase
            .from('reservations')
            .select('reservation_id')
            .eq('user_id', session.user.id)
            .gte('created_at', new Date(draft.savedAt).toISOString())
            .limit(1);
        if (error) return false;
        return Boolean(data && data.length);
    } catch {
        return false;
    }
}

function hideDraftResumeModal() {
    draftResumeModalBackdrop?.classList.add('hidden');
    draftResumeModalBackdrop?.setAttribute('aria-hidden', 'true');
}

// URL params (from "Book" on the Packages page) always take priority over
// any saved draft — the user made an explicit package selection, so discard
// any stale draft state that would otherwise silently suppress it.
const hasUrlPackage = new URLSearchParams(window.location.search).has('package');
if (hasUrlPackage) {
    clearDraft();
    const paramApplied = await applyUrlParams();
    cur = 1;
    showStep(cur);
    if (paramApplied) {
        // applyUrlParams() sets S.miniPackage/S.offsitePackage directly
        // (no card click happens for a pre-selected package), so the
        // guest-count native min/max and the "Allowed: X–Y guests" hint —
        // normally set inside the card's onclick handler via this same
        // call — never ran. Without this, the hint stayed blank until the
        // customer manually reselected a package card.
        clampGuestCountToSelection();
        buildAdditionalHeadBlock();
        setTimeout(() => scrollToSection('sub-guests-type'), 120);
    }
    finishInit();
} else {
    const draft = peekDraft();
    if (draft && await wasDraftAlreadySubmitted(draft)) {
        // The draft's own reservation already exists server-side — it was
        // carried to completion, not abandoned. Discard it silently rather
        // than offering to "resume" a reservation that's already been made.
        clearDraft();
        cur = 1;
        showStep(cur);
        finishInit();
    } else if (draft) {
        // Don't touch S/cur yet — wait for the customer to choose.
        draftResumeModalBackdrop?.classList.remove('hidden');
        draftResumeModalBackdrop?.setAttribute('aria-hidden', 'false');

        draftResumeContinueBtn?.addEventListener('click', async () => {
            restoreDraft();
            if (isCateringPackage(getActivePackage())) await ensureCateringMenuLoaded(getActivePackage());
            hideDraftResumeModal();
            showStep(cur);
            finishInit();
        }, { once: true });

        draftResumeStartNewBtn?.addEventListener('click', () => {
            clearDraft();
            cur = 1;
            hideDraftResumeModal();
            showStep(cur);
            finishInit();
        }, { once: true });
    } else {
        cur = 1;
        showStep(cur);
        finishInit();
    }
}