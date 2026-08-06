// privacy_content.js — powers the standalone /privacy-policy.html page.
// Reads the same canonical system_settings.data_privacy_policy row as the
// booking-flow Review & Sign agreement modal (reservations.html) and the
// admin's Terms & Legal preview (admin/config/form.html#legal) — there is
// only one copy of this text; this file just adds its own renderer/layout
// on top of it. Mirrors js/terms_content.js exactly (same parser, same
// h2-based block renderer, same retry contract) — see that file's header
// comment for why parsePolicyBody/renderPolicyBlocks aren't reused as-is.
import { customerSupabase as supabase } from './supabase.js';
import { loadPrivacyPolicyDocument } from './reservation_form_config.js';
import { parsePolicyBody } from './policy_text.js';

// Mirrors the seeded default in supabase/migrations/20260729_reservation_form_config.sql
// — shown if the admin hasn't configured this row yet (not a fetch failure).
const FALLBACK_BODY = `Policy Statement
ELI Coffee Events is committed to protecting the privacy and personal data of its users in accordance with Republic Act No. 10173, also known as the Data Privacy Act of 2012.

1. Collection of Personal Data
The system collects personal information such as name, email address, phone number, and other relevant details provided during account registration, reservation, and payment submission. Uploaded files such as proof of payment and signed contracts are also collected as part of the reservation process.

2. Purpose of Data Collection
Personal data is collected and used solely for the following purposes:
- Processing and managing reservations
- Verifying payment submissions
- Reviewing and validating contracts
- Communicating with customers regarding their reservations
- Maintaining records for administrative and operational purposes

3. Data Storage and Security
All personal data and uploaded documents are securely stored using trusted third-party services. Reasonable organizational, physical, and technical security measures are implemented to protect data against unauthorized access, alteration, disclosure, or destruction.

4. Data Sharing and Disclosure
Personal data will not be sold, shared, or disclosed to unauthorized third parties. Data may only be accessed by authorized personnel of ELI Coffee Events for operational and administrative purposes.

5. Data Retention
Personal data will be retained only for as long as necessary to fulfill the purposes stated above or as required by applicable laws and regulations. Records related to reservations, payments, and contracts may be retained for documentation and audit purposes.

6. User Rights
Users have the right to access, review, and request correction of their personal data stored in the system. Requests may be subject to verification and system limitations.

7. Use of System
By using this system and submitting personal information, the user consents to the collection, use, and processing of their data in accordance with this policy.

8. Contact and Inquiries
For any questions or concerns regarding data privacy, users may contact ELI Coffee Events through the provided contact channels.

9. Policy Updates
This Data Privacy Policy may be updated from time to time. Continued use of the system constitutes acceptance of any changes made.`;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// h2-based renderer for this page only — mirrors terms_content.js's
// renderTermsBlocks (same parsePolicyBody block shape, same <h2> depth).
function renderPrivacyBlocks(blocks) {
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
  bodyEl.innerHTML = `<div class="terms-body">${renderPrivacyBlocks(parsePolicyBody(bodyText))}</div>`;
  updatedEl.textContent = formatUpdatedDate(updatedAt);
}

function showRetry() {
  bodyEl.innerHTML = `
    <div class="terms-status">
      <p>We couldn't load the Data Privacy Policy right now.</p>
      <button type="button" class="terms-retry-btn" id="termsRetryBtn">
        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry
      </button>
    </div>`;
  document.getElementById('termsRetryBtn')?.addEventListener('click', loadPrivacy);
}

async function loadPrivacy() {
  bodyEl.innerHTML = '<p class="terms-status">Loading…</p>';
  try {
    const doc = await loadPrivacyPolicyDocument(supabase);
    if (doc && doc.body?.trim()) {
      renderContent(doc.body, doc.updatedAt);
    } else {
      // Row not configured yet (not a failure) — show the built-in default.
      renderContent(FALLBACK_BODY, null);
    }
  } catch (err) {
    showRetry();
  }
}

document.getElementById('termsBackBtn')?.addEventListener('click', () => {
  history.back();
});

loadPrivacy();
