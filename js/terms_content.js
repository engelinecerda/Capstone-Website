// terms_content.js — powers the standalone /terms-and-conditions.html page.
// Reads the same canonical system_settings.terms_and_conditions row as the
// booking-flow Review & Sign agreement modal (reservations.html) and the
// admin's Terms & Legal preview (admin/config/form.html#legal) — there is
// only one copy of this text; this file just adds its own renderer/layout
// on top of it. Uses parsePolicyBody from the shared js/policy_text.js
// module (same parser About uses) rather than reservation_form_config.js's
// own copy, since that one's output shape is coupled to the agreement
// modal's specific renderer, which this page doesn't reuse — headings here
// render as <h2> (this page's only other heading is the <h1> title), where
// the shared renderPolicyBlocks emits <h4> (correct for About's own nested
// heading hierarchy, wrong for this page's).
import { customerSupabase as supabase } from './supabase.js';
import { loadTermsDocument } from './reservation_form_config.js';
import { parsePolicyBody } from './policy_text.js';

// Mirrors the seeded default in supabase/migrations/20260729_reservation_form_config.sql
// — shown if the admin hasn't configured this row yet (not a fetch failure).
const FALLBACK_BODY = `1. Reservation Agreement
By submitting a reservation, the customer confirms that all provided information is accurate and agrees to comply with the policies stated in this system. A reservation is considered pending until reviewed and approved by the administrator.

2. Package and Services
The selected package includes the agreed services such as catering setup, food and beverage inclusions, event setup, and assigned staff. Specific inclusions depend on the chosen package and are displayed during the reservation process.
Additional costs such as crew meals and transportation fees may apply depending on the event location and requirements.

3. Payment Terms
Reservations may be confirmed through any of the following:
- Full Payment
- 50% Down Payment
- Reservation Fee
Any reservation fee paid will be deducted from the total package amount. The remaining balance must be settled before the specified payment deadline.
All submitted payments are subject to verification by the administrator. Customers must provide accurate payment details and valid proof of payment.

4. Non-Refundable Policy
All payments made are strictly non-refundable. Once a payment is submitted and verified, it cannot be reversed or refunded under any circumstances.

5. Rescheduling Policy
Customers may request to reschedule their reservation depending on availability. A rescheduling fee of P3,000 will be required. The requested date must be available and is subject to approval by the administrator.

6. Cancellation Policy
In the event of cancellation, all payments made will remain non-refundable. Cancellation requests may still be recorded in the system for documentation and administrative purposes.

7. Contract Submission
Customers are required to submit a signed contract as part of the reservation process. The system may allow resubmission of contracts if revisions are requested by the administrator. Submitted contracts are subject to review and approval.

8. Electronic Transactions and Signatures
This system complies with Republic Act No. 8792, also known as the Electronic Commerce Act of 2000, which recognizes the legal validity of electronic data messages, electronic documents, and electronic signatures.
All electronic records, including reservation details, submitted contracts, and uploaded documents, are considered legally binding and equivalent to their paper-based counterparts.
By submitting a reservation and signing the contract electronically, the customer acknowledges and agrees that their electronic signature represents their identity and intent to enter into a binding agreement with ELI Coffee Events.

9. System Usage
By using this system, the customer agrees not to provide false information, misuse the platform, or submit invalid or fraudulent payment records. The administrator reserves the right to reject, cancel, or take appropriate action on reservations that violate system policies.

10. Data Privacy
Customer information such as name, contact details, and uploaded documents will be securely stored and used solely for reservation processing, communication, and administrative purposes in accordance with applicable data privacy regulations.

11. Agreement
By checking the agreement box and submitting the reservation, the customer confirms that they have read, understood, and agreed to all the terms and conditions stated above.`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// h2-based renderer for this page only — see the module comment above for
// why this doesn't reuse the shared renderPolicyBlocks (which emits <h4>).
function renderTermsBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'heading') return `<h2>${escapeHtml(block.text)}</h2>`;
    if (block.type === 'list') return `<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
    return `
      ${block.heading ? `<h2>${escapeHtml(block.heading)}</h2>` : ''}
      ${block.paragraph ? `<p>${escapeHtml(block.paragraph)}</p>` : ''}
      ${block.items.length ? `<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
    `;
  }).join('');
}

function formatUpdatedDate(isoString) {
  if (!isoString) return '';
  try {
    const formatted = new Date(isoString).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return `Last updated ${formatted}.`;
  } catch {
    return '';
  }
}

const bodyEl = document.getElementById('termsBody');
const updatedEl = document.getElementById('termsUpdated');

function renderContent(bodyText, updatedAt) {
  bodyEl.innerHTML = `<div class="terms-body">${renderTermsBlocks(parsePolicyBody(bodyText))}</div>`;
  updatedEl.textContent = formatUpdatedDate(updatedAt);
}

function showRetry() {
  bodyEl.innerHTML = `
    <div class="terms-status">
      <p>We couldn't load the Terms &amp; Conditions right now.</p>
      <button type="button" class="terms-retry-btn" id="termsRetryBtn">
        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry
      </button>
    </div>`;
  document.getElementById('termsRetryBtn')?.addEventListener('click', loadTerms);
}

async function loadTerms() {
  bodyEl.innerHTML = '<p class="terms-status">Loading…</p>';
  try {
    const doc = await loadTermsDocument(supabase);
    if (doc && doc.body?.trim()) {
      renderContent(doc.body, doc.updatedAt);
    } else {
      // Row not configured yet (not a failure) — show the built-in default.
      renderContent(FALLBACK_BODY, null);
    }
  } catch (err) {
    console.warn('[terms_content] loadTermsDocument failed:', err?.message || err);
    showRetry();
  }
}

document.getElementById('termsBackBtn')?.addEventListener('click', () => {
  history.back();
});

loadTerms();
