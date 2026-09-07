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

const { data: { session } } = await supabase.auth.getSession();
const isLoggedIn = !!session;

if (!isLoggedIn) {
    document.getElementById('resGuestNotice').classList.remove('hidden');
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
    snackAddon: null,
    offsiteCategory: '',
    offsitePackage: null,
    cateringCart: [],
    guestCount: '',
    eventType: '',
    eventTypeOther: '',
    venueLocation: '',
    eventDate: '',
    time: '',
    name: '', phone: '', email: '', requests: ''
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

// Catering packages have no fixed per-item price (the dish-builder cart
// computes its own total), so this stays a name-based flag derived from
// the *category* name, mirroring the same catering detection the
// enforce_reservation_capacity() DB trigger uses on the package name.
function deriveOffsiteCategoryFlag(categoryName) {
    return /cater/i.test(categoryName || '') ? 'catering' : 'other';
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
const DRAFT_KEY = 'eli_reservation_draft';
const DRAFT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — after this, treat as stale and don't offer to resume

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
    if (submissionLocked) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ state: S, step: cur, savedAt: Date.now() })); } catch { /* ignore */ }
}

function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// Reads the saved draft without applying it, so the resume-prompt modal
// can decide whether to appear before anything is mutated. Returns null
// if there's no draft, it's malformed, or it's past DRAFT_MAX_AGE_MS.
function peekDraft() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed?.state || typeof parsed.step !== 'number') return null;
        if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS) return null;
        return parsed;
    } catch { return null; }
}

function restoreDraft() {
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
const contractAgreementHelper = document.getElementById('contract-agreement-esign-helper');
const agreementModalBackdrop  = document.getElementById('agreement-modal-backdrop');
const agreementModalTitle     = document.getElementById('agreement-modal-title');
const agreementModalBody      = document.getElementById('agreement-modal-body');
const agreementReadingColumn  = document.getElementById('agreement-reading-column');
const agreementModalCloseBtn        = document.getElementById('agreement-modal-close-btn');
const agreementModalFooterCloseBtn  = document.getElementById('agreement-modal-footer-close-btn');
const agreementModalFinishBtn       = document.getElementById('agreement-modal-finish-btn');

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

// Landing a customer on a calendar page that's entirely grey (every date
// either past or inside the minimum-advance-notice window — e.g. today
// is the 26th with a 14-day minimum, so the rest of this month can never
// have a bookable date) reads as broken, even though it's working as
// designed. Called once on initial load only — not on manual Prev/Next,
// so a customer who deliberately pages back can still see why a month is
// empty. Bounded to 24 months so a misconfigured max_advance_days (e.g.
// 0) can't spin this forever.
function advanceToFirstBookableMonth() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
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
    { cat:'Fish',       icon:'&#128031;', tag:'main',    required:true,  items:['Fish Fillet with Tartar Sauce','Sweet and Sour Fish Fillet'] },
    { cat:'Vegetables', icon:'&#129382;', tag:'main',    required:true,  items:['Mixed Vegetables in Butter Corn and Carrots','Potato Marble'] },
    { cat:'Pasta',      icon:'&#127837;', tag:'pasta',   required:true,  items:['Spaghetti','Carbonara','Baked Macaroni','Tuna Pesto','Pancit Canton'] },
    { cat:'Dessert',    icon:'&#127854;', tag:'dessert', required:true,  items:['Coffee Jelly','Buko Pandan','Mango Sago','Chocolate Mousse'] },
    { cat:'Rice',       icon:'&#127834;', tag:'rice',    required:false, items:['Steamed Rice'] }
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

let DISHES = FALLBACK_DISHES;
let PRICES = FALLBACK_PRICES;

async function loadCateringMenu(packageId) {
    if (!packageId) return; // no catering-flagged package found — keep the fallback
    try {
        const [{ data: cats, error: catErr }, { data: dishRows, error: dishErr }] = await Promise.all([
            supabase.from('catering_dish_category').select('*').eq('is_active', true).eq('package_id', packageId).order('sort_order', { ascending: true }),
            supabase.from('catering_dish').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
        ]);
        if (catErr) throw catErr;
        if (dishErr) throw dishErr;
        if (!cats || !cats.length) return; // empty menu — keep the fallback rather than showing nothing

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
    } catch (err) {
        console.warn('Failed to load catering menu from database, using fallback menu:', err);
        DISHES = FALLBACK_DISHES;
        PRICES = FALLBACK_PRICES;
    }
}

// ── Utility ────────────────────────────────────────────────────────────
function pad(v) { return String(v).padStart(2, '0'); }

function toDateKey(date) {
    return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}

function fmtPeso(v) { return '₱' + Number(v || 0).toLocaleString(); }

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
function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const pkgId  = params.get('package');
    if (!pkgId) return false;

    // Compare as strings — package_id is a UUID so parseInt would return NaN
    const onsitePkg = MINI.find(p => String(p.id) === pkgId);
    if (onsitePkg) {
        S.locationType = 'onsite';
        S.categoryId   = onsitePkg.categoryId;
        S.miniPackage  = onsitePkg;
        document.querySelectorAll('.location-card').forEach(c => {
            c.classList.toggle('active', c.dataset.val === 'onsite');
        });
        return true;
    }

    const offsitePkg = OFFSITE_ALL.find(p => String(p.id) === pkgId);
    if (offsitePkg) {
        S.locationType    = 'offsite';
        S.categoryId      = offsitePkg.categoryId;
        S.offsiteCategory = deriveOffsiteCategoryFlag(offsitePkg.categoryName);
        S.offsitePackage  = offsitePkg;
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
}

function closePolicyModal() {
    policyModalBackdrop.classList.add('hidden');
    policyModalBackdrop.setAttribute('aria-hidden', 'true');
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
        penColor: 'rgb(42,20,8)',
        onBegin: () => setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, false),
        onEnd: () => updateSignatureCapturedBadge()
    });
    resizeSignatureCanvas();
    window.addEventListener('resize', resizeSignatureCanvas);
}

function setSignatureGuidePlaceholderVisible(el, visible) {
    el?.classList.toggle('is-hidden', !visible);
}

function updateSignatureCapturedBadge() {
    signatureCapturedBadge?.classList.toggle('is-hidden', !isSignaturePresent());
}

// Shrinks the live cursive preview in steps until it fits the available
// width, rather than letting a long typed name run past the box (the
// preview's own overflow:hidden + ellipsis is the hard backstop if even
// the smallest step still doesn't fit).
const SIGNATURE_TYPE_FONT_MAX = 32;
const SIGNATURE_TYPE_FONT_MIN = 18;
// Runs on every keystroke (see the 'input' listener below) — the old
// version looped "write font-size, read scrollWidth" up to 7 times per
// call, and each iteration forces the browser to synchronously flush
// layout to answer that read (a "forced reflow"/layout thrashing; this
// showed up directly in a PageSpeed audit as ~63ms of forced-reflow time).
// Measuring once at max size and computing the fitted size by ratio
// instead needs exactly one write + two reads (clientWidth/scrollWidth,
// taken back-to-back with no write between them, so they share a single
// layout flush) + one final write with no read after it — no reflow loop.
// A script font's width doesn't scale *perfectly* linearly with px size,
// so this can occasionally land a shade looser/tighter than the old
// iterative version — safe, since the preview's own overflow:hidden is
// already the documented hard backstop for exactly that case.
function fitSignatureTypePreview() {
    if (!signatureTypePreview) return;
    signatureTypePreview.style.fontSize = `${SIGNATURE_TYPE_FONT_MAX}px`;
    const maxWidth = signatureTypePreview.clientWidth;
    const naturalWidth = signatureTypePreview.scrollWidth;
    if (naturalWidth <= maxWidth || naturalWidth === 0) return; // already fits at max size

    const fittedSize = Math.floor(SIGNATURE_TYPE_FONT_MAX * (maxWidth / naturalWidth));
    const size = Math.max(SIGNATURE_TYPE_FONT_MIN, Math.min(SIGNATURE_TYPE_FONT_MAX, fittedSize));
    signatureTypePreview.style.fontSize = `${size}px`;
}

function setSignatureMode(mode) {
    signatureState.mode = mode;
    sigModeDrawBtn?.classList.toggle('active', mode === 'draw');
    sigModeTypeBtn?.classList.toggle('active', mode === 'type');
    signatureDrawPanel?.classList.toggle('hidden', mode !== 'draw');
    signatureTypePanel?.classList.toggle('hidden', mode !== 'type');
    if (mode === 'draw') { initSignaturePad(); resizeSignatureCanvas(); }
    setSignatureStatus('');
    updateSignatureCapturedBadge();
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
    if (S.offsiteCategory === 'catering') return OFFSITE_BY_CAT[S.categoryId]?.[0]?.id || null;
    return S.offsitePackage?.id || null;
}

function getSelectedContractPackageLabel() {
    if (S.locationType === 'onsite') return S.miniPackage?.label || null;
    if (S.offsiteCategory === 'catering') return 'Catering Package';
    return S.offsitePackage?.label || null;
}

function computeContractPreviewBase() {
    if (S.locationType === 'onsite') {
        return (S.miniPackage ? S.miniPackage.price : 0) + (S.snackAddon ? S.snackAddon.price : 0);
    }
    if (S.offsiteCategory === 'catering') {
        return S.cateringCart.filter(i => i && i.pax).reduce((sum, i) => sum + i.price, 0);
    }
    return S.offsitePackage ? S.offsitePackage.price : 0;
}

// Same order of operations as buildSummary()/the submit handler: the
// service charge is added to the base to reach the total the customer
// actually signs for — never the pre-charge figure.
function computeContractPreviewCharge() {
    return resolveServiceCharge(computeContractPreviewBase(), S.locationType, S.categoryId);
}

function mergeTemplateTokens(template, data) {
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (data[key] ?? ''));
}

function renderContractBody(templateBody) {
    if (!contractViewer) return '';
    const charge = computeContractPreviewCharge();
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
        guest_count: S.guestCount || ''
    };
    const merged = mergeTemplateTokens(templateBody, data);
    // Templates have no explicit structural markup — real contract_templates
    // rows are plain text with the title (and often a brand line before it)
    // as consecutive ALL-CAPS lines at the very top, then ALL-CAPS section
    // headers (EVENT DETAILS, PAYMENT TERMS, etc.) scattered through
    // otherwise-regular paragraphs. Confirmed against live template rows,
    // not assumed. inTitleBlock tracks "still in that opening run of
    // consecutive caps lines" — the first blank line ends it, so any caps
    // line after that point is a section header, not more title.
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
        if (isAllCaps) {
            return `<p class="contract-viewer-heading">${escapeHtml(trimmed)}</p>`;
        }
        return `<p>${escapeHtml(trimmed)}</p>`;
    }).join('');
    return merged;
}

// ── Agreement read-gating ────────────────────────────────────────────────
// The e-sign checkbox stays disabled until we have real evidence the
// customer actually saw the agreement text — either they scrolled the
// inline preview to its end, or they opened the full-screen reader.
function resetAgreementGating() {
    signatureState.agreementViewMethod = '';
    signatureState.agreementViewedAt = '';
    if (contractAgreementEsign) {
        contractAgreementEsign.checked = false;
        contractAgreementEsign.disabled = true;
    }
    if (contractAgreementHelper) contractAgreementHelper.hidden = false;
}

function markAgreementViewed(method) {
    if (signatureState.agreementViewMethod) return; // already satisfied
    signatureState.agreementViewMethod = method;
    signatureState.agreementViewedAt = new Date().toISOString();
    if (contractAgreementEsign) contractAgreementEsign.disabled = false;
    if (contractAgreementHelper) contractAgreementHelper.hidden = true;
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
    resetAgreementGating();

    if (!pkgId) {
        contractViewer.innerHTML = '<p class="contract-viewer-loading">Select a package first so the correct contract can be loaded.</p>';
        return;
    }

    contractViewer.innerHTML = '<p class="contract-viewer-loading">Loading your contract...</p>';

    let tmpl = null;
    try {
        const { data, error } = await supabase
            .from('contract_templates')
            .select('template_body, contract_type')
            .eq('package_id', pkgId)
            .eq('is_active', true)
            .order('version_no', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        tmpl = data;
    } catch (err) {
        showContractLoadError();
        return;
    }

    signatureState.activeTemplateContractType = tmpl?.contract_type || 'package_contract';
    signatureState.agreementText = renderContractBody(tmpl?.template_body || DEFAULT_CONTRACT_TEMPLATE_BODY);
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

    if (agreementModalTitle) {
        agreementModalTitle.textContent = document.getElementById('contract-title')?.textContent || 'Service Agreement';
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
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleAgreementModalKeydown);

    const focusable = getAgreementModalFocusable();
    (focusable[0] || agreementModalBackdrop).focus();
}

function closeAgreementModal() {
    if (!agreementModalBackdrop) return;
    agreementModalBackdrop.classList.add('hidden');
    agreementModalBackdrop.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
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

function getSelectedBookingScope() {
    if (!S.locationType) return null;
    if (S.locationType === 'offsite') {
        if (!S.offsiteCategory) return null;
        if (S.offsiteCategory !== 'catering' && !S.offsitePackage) return null;
        return 'offsite';
    }
    return getSharedBookingScope(S.locationType, S.miniPackage?.label || '', S.miniPackage?.bookingScope || null);
}

function getSelectedDurationHours() {
    if (S.locationType === 'onsite') return Number(S.miniPackage?.durationHours || 0) || null;
    if (S.offsiteCategory === 'catering') return Number(OFFSITE_BY_CAT[S.categoryId]?.[0]?.durationHours || 0) || 4;
    return Number(S.offsitePackage?.durationHours || 0) || null;
}

// The actual selected package/category name — used in time-slot messaging
// instead of getScopeLabel()'s coarse VIP/Main Hall/Off-site bucket, which
// previously produced a generic or outright wrong label (e.g. always
// "VIP" for any onsite scope) regardless of which package was chosen.
function getSelectedPackageOrCategoryLabel() {
    if (S.locationType === 'onsite' && S.miniPackage) return S.miniPackage.label;
    if (S.offsiteCategory === 'catering') {
        const cat = OFFSITE_CATEGORIES.find(c => c.id === S.categoryId);
        return cat ? cat.name : 'Catering';
    }
    if (S.offsitePackage) return S.offsitePackage.label;
    return null;
}

function getScopeSelectionPrompt() {
    if (!S.locationType) return 'Choose your location type and package first to unlock dates for your booking.';
    if (S.locationType === 'onsite' && !S.miniPackage) return 'Choose an onsite package first to unlock VIP or Main Hall dates.';
    if (S.locationType === 'offsite' && !S.offsiteCategory) return 'Choose your offsite service first to unlock dates.';
    if (S.locationType === 'offsite' && S.offsiteCategory !== 'catering' && !S.offsitePackage) return 'Choose an offsite package first to unlock dates.';
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
    return getDateAvailability(dateKey).isFullyBooked;
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
        .select('package_id, package_name, description, package_type, price, guest_capacity, min_guests, max_guests, location_type, duration_hours, booking_scope, sort_order, inclusions, package_image, package_category_id, package_category(category_name, is_active, sort_order, service_charge_percent)')
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
    const [{ data: venueMaps }, { data: photoRows }] = packageIds.length
        ? await Promise.all([
            supabase.from('package_venue').select('package_id').in('package_id', packageIds),
            supabase.from('package_photo').select('package_id, image_url, is_cover, sort_order').in('package_id', packageIds).order('sort_order', { ascending: true })
        ])
        : [{ data: [] }, { data: [] }];

    const venueCounts = new Map();
    (venueMaps || []).forEach(row => venueCounts.set(row.package_id, (venueCounts.get(row.package_id) || 0) + 1));
    const hasGalleryPhoto = new Set((photoRows || []).map(row => row.package_id));

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
            categoryId,
            categoryName,
            coverPhotoUrl: cover?.image_url || p.package_image || null
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
    S.offsiteCategory = S.locationType === 'offsite' ? deriveOffsiteCategoryFlag(cat.name) : '';
    if (prev !== cat.id) {
        S.miniPackage    = null;
        S.offsitePackage = null;
        S.snackAddon     = null;
        S.cateringCart   = [];
        S.time           = '';
        syncSelectedDate('');
    }
    buildCategoryGrid();
    buildPackageStep();
    updateSectionLocks();
    buildAddonOrVenueStep();
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
            return;
        }
        if (descEl) descEl.textContent = 'Select a package for your event at ELI Coffee.';
        buildMiniGrid();
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
        if (S.offsiteCategory === 'catering') {
            subEl.classList.add('hidden');
            cateringEl.classList.remove('hidden');
            buildCateringInclusionsBlock();
            buildCateringDishBuilder();
        } else {
            cateringEl.classList.add('hidden');
            subEl.classList.remove('hidden');
            document.getElementById('offsite-sub-label').textContent = 'Choose a Package';
            buildOffsiteSub(S.categoryId);
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
    const priceHtml = p.price > 0
        ? '<div class="rpkg-price">' + fmtPeso(p.price) + '</div>'
        : '<div class="rpkg-price rpkg-price--contact">Contact for quote</div>';
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
            '<a class="rpkg-details-link" href="/package-details.html?id=' + encodeURIComponent(p.id) + '" target="_blank" rel="noopener noreferrer">' +
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
            S.miniPackage = p;
            S.snackAddon  = null;
            S.time        = '';
            activate(g, c);
            updateSectionLocks();
            clampGuestCountToSelection();
            buildAddonOrVenueStep();
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
            S.offsitePackage = p; S.time = '';
            activate(g, c);
            updateSectionLocks();
            clampGuestCountToSelection();
            buildAddonOrVenueStep();
            await refreshAvailabilityForSelectedScope();
        };
        g.appendChild(c);
    });
    if (!list.length) g.innerHTML = packagesEmptyStateHtml();
}

// ── Add-on / Venue conditional step ───────────────────────────────────
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
        if (title) title.innerHTML = 'Want to add a <em>Snack Bar</em>?';
        if (desc)  desc.textContent = 'This optional add-on pairs perfectly with your gathering. You can skip it and proceed.';
        if (addonSect) addonSect.classList.remove('hidden');
        if (venueSect) venueSect.classList.add('hidden');
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
    const pkg = (OFFSITE_BY_CAT[S.categoryId] || [])[0];
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
function hasCateringTag(tag) {
    return DISHES.filter(g => g.tag === tag).some(g => S.cateringCart.some(i => i.cat === g.cat && i.pax));
}

function isCateringSelectionValid() {
    return hasCateringTag('main') && hasCateringTag('pasta') && hasCateringTag('dessert');
}

function getCateringCartTotal()  { return S.cateringCart.reduce((s, i) => s + (i && i.pax ? i.price : 0), 0); }
function getCateringCartCount()  { return S.cateringCart.filter(i => i && i.pax).length; }
function getCateringSelection(cat) { return S.cateringCart.find(i => i.cat === cat); }

function setCateringSelection(cat, dish, pax) {
    S.cateringCart = S.cateringCart.filter(i => i.cat !== cat);
    if (dish && pax && PRICES[cat] && PRICES[cat][pax]) S.cateringCart.push({ cat, dish, pax, price: PRICES[cat][pax] });
    else if (dish) S.cateringCart.push({ cat, dish, pax: null, price: 0 });
}

function clearCateringSelection(cat) { S.cateringCart = S.cateringCart.filter(i => i.cat !== cat); }

function renderCateringProgress() {
    const tracker = document.getElementById('catering-progress-tracker');
    if (!tracker) return;
    const steps = [
        { label:'Main Dish', check: () => hasCateringTag('main') },
        { label:'Pasta',     check: () => hasCateringTag('pasta') },
        { label:'Dessert',   check: () => hasCateringTag('dessert') },
        { label:'Rice',      check: () => hasCateringTag('rice'), optional: true }
    ];
    tracker.innerHTML = '';
    steps.forEach((step, idx) => {
        const done = step.check();
        const item = document.createElement('div');
        item.className = 'pt-item' + (done ? ' done' : ' pending');
        item.innerHTML =
            '<div class="pt-dot">' + (done ? '&#10003;' : idx + 1) + '</div>' +
            '<span>' + step.label + (step.optional ? ' <em style="font-weight:400;font-style:normal;opacity:0.6">(optional)</em>' : '') + '</span>';
        tracker.appendChild(item);
        if (idx < steps.length - 1) {
            const div = document.createElement('div'); div.className = 'pt-divider'; tracker.appendChild(div);
        }
    });
}

function buildCateringDishBuilder() {
    const builder = document.getElementById('catering-tray-builder');
    if (!builder) return;
    builder.innerHTML = '';

    DISHES.forEach(group => {
        const selected = getCateringSelection(group.cat);
        const isDone   = selected && selected.pax;
        const section  = document.createElement('div'); section.className = 'cat-section';

        const header = document.createElement('div'); header.className = 'cat-header';
        header.innerHTML =
            '<div class="cat-icon-wrap">' + group.icon + '</div>' +
            '<span class="cat-title">' + group.cat + '</span>' +
            '<span class="cat-tag">' + (group.required ? '(required)' : '(optional add-on)') + '</span>' +
            '<span class="cat-done-badge' + (isDone ? ' visible' : '') + '">&#10003; Added</span>';
        section.appendChild(header);

        const grid = document.createElement('div'); grid.className = 'dish-grid';
        group.items.forEach(item => {
            const isSelected = selected && selected.dish === item;
            const dc = document.createElement('div');
            dc.className = 'dish-card' + (isSelected ? ' selected' : '');
            dc.innerHTML =
                '<div class="dish-name">' + item + '</div>' +
                '<div class="dish-status checked">&#10003; Selected</div>' +
                '<div class="dish-status remove">&#10005; Click to remove</div>';
            dc.onclick = () => { if (isSelected) clearCateringSelection(group.cat); else setCateringSelection(group.cat, item, null); rebuildCateringUI(); };
            grid.appendChild(dc);
        });
        section.appendChild(grid);

        if (selected && selected.dish) {
            const paxWrap = document.createElement('div'); paxWrap.className = 'pax-wrapper visible';
            const paxTop  = document.createElement('div'); paxTop.className = 'pax-top';
            paxTop.innerHTML =
                '<span class="pax-top-label">Pax per tray</span>' +
                (selected.pax ? '<span class="pax-selected-price">' + fmtPeso(PRICES[group.cat][selected.pax]) + '</span>' : '');
            paxWrap.appendChild(paxTop);

            const paxBtns = document.createElement('div'); paxBtns.className = 'pax-buttons';
            [20, 30, 40, 50].forEach(n => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pax-btn' + (selected.pax === n ? ' selected' : '');
                btn.textContent = n + ' pax';
                btn.onclick = () => { setCateringSelection(group.cat, selected.dish, n); rebuildCateringUI(); };
                paxBtns.appendChild(btn);
            });
            paxWrap.appendChild(paxBtns);

            if (!selected.pax) {
                const hint = document.createElement('p'); hint.className = 'pax-hint';
                hint.textContent = 'Choose the number of pax to add this dish to your cart.';
                paxWrap.appendChild(hint);
            }
            section.appendChild(paxWrap);
        }

        const divider = document.createElement('hr'); divider.className = 'cat-divider';
        section.appendChild(divider);
        builder.appendChild(section);
    });

    renderCateringCart();
    renderCateringProgress();
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

    const count = getCateringCartCount();
    const total = getCateringCartTotal();
    rows.innerHTML = '';
    if (badgeEl) badgeEl.textContent = count;
    if (runningEl) runningEl.textContent = fmtPeso(total);

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
                '<div class="ci-pax">' + item.pax + ' pax</div></div>' +
                '<div class="ci-right"><span class="ci-price">' + fmtPeso(item.price) + '</span>' +
                '<button type="button" class="ci-remove-btn" data-cat="' + item.cat + '">Remove</button></div>';
            rows.appendChild(row);
        });

        rows.querySelectorAll('.ci-remove-btn').forEach(btn => {
            btn.onclick = () => { clearCateringSelection(btn.dataset.cat); rebuildCateringUI(); };
        });
    }

    if (noticeEl) {
        noticeEl.className = 'validation-notice' + (isCateringSelectionValid() ? ' success' : '');
        if (noticeEl.querySelector('.vn-icon')) {
            noticeEl.querySelector('.vn-icon').textContent = isCateringSelectionValid() ? '✅' : '⚠️';
        }
        if (noticeText) {
            if (isCateringSelectionValid()) {
                noticeText.textContent = 'Great! Your menu meets the minimum requirements. You can add more dishes if you like.';
            } else {
                const missing = [];
                if (!hasCateringTag('main'))   missing.push('1 main dish');
                if (!hasCateringTag('pasta'))  missing.push('1 pasta');
                if (!hasCateringTag('dessert')) missing.push('1 dessert');
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
            durationHours: getSelectedDurationHours()
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

    if (S.locationType === 'onsite') {
        if (S.miniPackage) {
            total += S.miniPackage.price;
            pkgRows += sr('Package', S.miniPackage.label + ' &mdash; &#8369;' + S.miniPackage.price.toLocaleString());
        }
        if (S.snackAddon) {
            total += S.snackAddon.price;
            pkgRows += sr('Add-on', S.snackAddon.label + ' &mdash; &#8369;' + S.snackAddon.price.toLocaleString());
        }
    } else if (S.offsiteCategory === 'catering') {
        const catObj = OFFSITE_CATEGORIES.find(c => c.id === S.categoryId);
        const cateringPkg = (OFFSITE_BY_CAT[S.categoryId] || [])[0];
        pkgRows += sr('Service', catObj ? catObj.name : 'Catering');
        const cateringItems = Array.isArray(cateringPkg?.inclusions) ? cateringPkg.inclusions.filter(i => i && i.trim()) : [];
        const cateringOffer = cateringItems.find(i => /^\s*special offer\s*:/i.test(i));
        const cateringPlainItems = cateringItems.filter(i => i !== cateringOffer);
        if (cateringPlainItems.length) pkgRows += sr('Inclusions', cateringPlainItems.join(', '));
        else if (cateringPkg?.desc) pkgRows += sr('Inclusions', cateringPkg.desc);
        if (cateringOffer) pkgRows += sr('Special Offer', cateringOffer.replace(/^\s*special offer\s*:\s*/i, ''));
        S.cateringCart.filter(i => i && i.pax).forEach(i => {
            total += i.price;
            pkgRows += sr(i.cat + ' (' + i.pax + ' pax)', i.dish + ' &mdash; &#8369;' + i.price.toLocaleString());
        });
        if (total === 0) pkgRows += sr('Price', 'Contact for quote');
    } else if (S.offsitePackage) {
        const catObj = OFFSITE_CATEGORIES.find(c => c.id === S.categoryId);
        total = S.offsitePackage.price;
        pkgRows += sr('Service', catObj ? catObj.name : '');
        pkgRows += sr('Package', S.offsitePackage.label);
        if (S.offsitePackage.price > 0) pkgRows += sr('Price', '&#8369;' + S.offsitePackage.price.toLocaleString());
    }

    // Itemised, never folded into the package price — customer sees
    // Subtotal, then the service charge as its own line, then Total.
    const charge = resolveServiceCharge(total, S.locationType, S.categoryId);
    const totalRowsHtml = total > 0
        ? sr('Subtotal', '&#8369;' + total.toLocaleString()) +
          sr('Service charge (' + charge.pct + '%)', '&#8369;' + charge.amount.toLocaleString()) +
          '<div class="summary-total"><span>Total</span><span>&#8369;' + charge.total.toLocaleString() + '</span></div>'
        : '<div class="summary-total"><span>Total</span><span>Contact for quote</span></div>';

    const locStr   = S.locationType === 'onsite'
        ? '&#127968; Onsite &mdash; ELI Coffee'
        : '&#128663; Offsite' + (S.venueLocation ? ' &mdash; ' + S.venueLocation : '');
    const displayEventType = S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType;

    box.innerHTML =
        '<div class="summary-section-title">Event</div>' +
        sr('Location',   locStr) +
        pkgRows +
        sr('Guests',     S.guestCount) +
        sr('Event Type', displayEventType) +
        sr('Date',       formatDisplayDate(S.eventDate) || S.eventDate) +
        sr('Time',       S.time) +
        '<hr class="summary-divider">' +
        '<div class="summary-section-title">Contact</div>' +
        sr('Name',  S.name) +
        sr('Email', S.email) +
        sr('Phone', S.phone) +
        (S.requests ? sr('Requests', S.requests) : '') +
        '<hr class="summary-divider">' +
        totalRowsHtml;

    document.getElementById('guest-warning').classList.toggle('hidden', isLoggedIn);
}

function sr(label, value) {
    return '<div class="summary-row"><span class="s-label">' + label + '</span><span class="s-value">' + value + '</span></div>';
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
    if (nameInput  && !nameInput.value.trim())  nameInput.value  = fullName;
    if (phoneInput && !phoneInput.value.trim()) phoneInput.value = phone;
    if (emailInput && !emailInput.value.trim()) emailInput.value = email;
    S.name  = nameInput?.value.trim()  || S.name;
    S.phone = phoneInput?.value.trim() || S.phone;
    S.email = emailInput?.value.trim() || S.email;
}

async function prefillReservationContactDetails() {
    const user = session?.user;
    if (!user) return;
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
            if (!S.offsiteCategory) {
                showWarningModal('Please select an offsite service category.');
                scrollToSection('sub-pkg'); return false;
            }
            if (S.offsiteCategory === 'catering') {
                if (!isCateringSelectionValid()) {
                    showWarningModal('Please select at least 1 main dish, 1 pasta, and 1 dessert for your catering package.');
                    scrollToSection('sub-pkg'); return false;
                }
            } else if (!S.offsitePackage) {
                showWarningModal('Please select a specific package before continuing.');
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
    return !!S.offsiteCategory;
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

// ── Event listeners ────────────────────────────────────────────────────
document.getElementById('nextBtn').onclick = () => {
    if (!isLoggedIn) {
        const notice = document.getElementById('resGuestNotice');
        notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        notice.classList.add('res-guest-notice--pulse');
        setTimeout(() => notice.classList.remove('res-guest-notice--pulse'), 800);
        return;
    }
    if (!validate(cur)) return;
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
            S.snackAddon      = null;
            S.offsiteCategory = '';
            S.offsitePackage  = null;
            S.cateringCart    = [];
            S.time            = '';
            syncSelectedDate('');
        }
        buildCategoryGrid();
        buildPackageStep();
        updateSectionLocks();
        buildAddonOrVenueStep();
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

contractAgreementTerms?.addEventListener('change', () => { if (contractAgreementTerms.checked) setContractPolicyMessage(''); });
contractAgreementEsign?.addEventListener('change', () => { if (contractAgreementEsign.checked) setContractPolicyMessage(''); });
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
        setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, true);
    } else {
        if (signatureTypeInput) signatureTypeInput.value = '';
        if (signatureTypePreview) signatureTypePreview.textContent = '';
    }

    setSignatureMode(nextMode);
}

sigModeDrawBtn?.addEventListener('click', () => switchSignatureMode('draw'));
sigModeTypeBtn?.addEventListener('click', () => switchSignatureMode('type'));
signatureClearBtn?.addEventListener('click', () => {
    signatureState.pad?.clear();
    setSignatureGuidePlaceholderVisible(signatureGuidePlaceholder, true);
    updateSignatureCapturedBadge();
    setSignatureStatus('');
});
signatureTypeInput?.addEventListener('input', () => {
    const text = signatureTypeInput.value.trim();
    if (signatureTypePreview) signatureTypePreview.textContent = text;
    fitSignatureTypePreview();
    updateSignatureCapturedBadge();
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
            eventDate: S.eventDate, scope: getSelectedBookingScope(), durationHours: getSelectedDurationHours()
        });
        const chosenRow = latestStartTimes.find(r => r.timeLabel === S.time);
        if (!chosenRow || !chosenRow.isAvailable) {
            availabilityState.availableStartTimes = latestStartTimes;
            buildTimeGrid();
            throw new Error('Your selected start time is no longer available. Please choose another time.');
        }

        const { data: { session: freshSession } } = await supabase.auth.getSession();
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

        if (S.locationType === 'onsite') {
            packageId  = S.miniPackage ? S.miniPackage.id : null;
            addOnId    = S.snackAddon  ? S.snackAddon.id  : null;
            totalPrice = (S.miniPackage ? S.miniPackage.price : 0) + (S.snackAddon ? S.snackAddon.price : 0);
        } else if (S.offsiteCategory === 'catering') {
            const cateringPkg = (OFFSITE_BY_CAT[S.categoryId] || [])[0];
            packageId  = cateringPkg ? cateringPkg.id : null;
            totalPrice = S.cateringCart.reduce((sum, i) => sum + i.price, 0);
        } else {
            packageId  = S.offsitePackage ? S.offsitePackage.id    : null;
            totalPrice = S.offsitePackage ? S.offsitePackage.price : 0;
        }

        // Service charge is added to the base to reach the total that
        // gets stored — everything downstream (deposit %, custom-amount
        // minimum) reads this same total_price column, so they
        // automatically compute off the post-charge figure. Snapshotted
        // alongside total_price so later default/override edits never
        // change an existing booking.
        const serviceCharge = resolveServiceCharge(totalPrice, S.locationType, S.categoryId);
        totalPrice = serviceCharge.total;

        const displayEventType = S.eventType === 'Other' ? (S.eventTypeOther || 'Other') : S.eventType;

        const { data: reservation, error: insertError } = await supabase
            .from('reservations')
            .insert({
                user_id:          userId,
                event_type:       displayEventType,
                event_date:       S.eventDate,
                event_time:       S.time,
                guest_count:      parseInt(S.guestCount),
                location_type:    S.locationType,
                venue_location:   S.venueLocation || null,
                package_id:       packageId,
                add_on_id:        addOnId,
                total_price:      totalPrice,
                service_charge_percent: serviceCharge.pct,
                service_charge_amount:  serviceCharge.amount,
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
        msg.className = 'summary-box';
        msg.style.cssText = 'text-align:center;padding:48px 20px;';
        msg.innerHTML =
            '<div style="font-size:52px;margin-bottom:16px;">&#9989;</div>' +
            '<h3 style="color:#2A1408;font-size:22px;margin-bottom:10px;font-weight:700;">Reservation Submitted!</h3>' +
            '<p style="color:#777;line-height:1.8;font-size:15px;">Thank you, <strong>' + S.name + '</strong>!<br>' +
            'Reservation Number: <strong style="color:#6B3A1F;">' + (contractResult.reservation_number || '') + '</strong><br>' +
            'Your reservation is <strong style="color:#6B3A1F;">under review</strong>.<br>' +
            'We\'ll contact you at <strong>' + S.email + '</strong> to confirm.</p>' +
            '<p style="margin-top:14px;"><a href="' + contractResult.contract_url + '" target="_blank" rel="noopener noreferrer" class="dl-btn" style="text-decoration:none;">Download your signed contract</a></p>';
        document.querySelector('.reservation-container').appendChild(msg);

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

// Resolve which package backs the catering flow the same way the rest of
// this file already does (first active package under the category whose
// name matches "cater"), then load that package's own menu — keeps the
// dish builder, the inclusions block, and the contract summary always
// pointed at the exact same package.
{
    const cateringCatObj = OFFSITE_CATEGORIES.find(c => deriveOffsiteCategoryFlag(c.name) === 'catering');
    const cateringPkg = cateringCatObj ? (OFFSITE_BY_CAT[cateringCatObj.id] || [])[0] : null;
    await loadCateringMenu(cateringPkg?.id || null);
}

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
    const paramApplied = applyUrlParams();
    cur = 1;
    showStep(cur);
    if (paramApplied) setTimeout(() => scrollToSection('sub-guests-type'), 120);
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

        draftResumeContinueBtn?.addEventListener('click', () => {
            restoreDraft();
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