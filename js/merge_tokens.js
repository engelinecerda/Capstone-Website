// merge_tokens.js — shared {{token}} merge engine.
// Extracted from js/admin_contract_template.js so the contract editor and
// the Notifications Configuration message editor use the exact same
// resolver — {{customer_name}} must resolve identically in both, or they
// drift and get debugged twice. Mirrors supabase/functions/generate-signed-
// contract/index.ts's mergeTemplate() and the plpgsql equivalent in
// supabase/migrations/20260808_notification_config.sql's
// render_notification_template(); keep all three in sync if the token
// vocabulary changes.

export const TOKEN_INFO = {
  customer_name: 'Client name from the reservation',
  package_name: 'Booked package name',
  event_type: 'Selected event type',
  event_date: 'Event date',
  event_time: 'Event time',
  venue: 'Venue name',
  reservation_number: 'Reservation / contract number',
  total_price: 'Total package price',
  guest_count: 'Guest count',
  contact_email: "Client's email",
  contact_phone: "Client's phone number",
  signed_date: 'Date and time the contract is signed',
  reschedule_fee: 'Reschedule fee — Payment Options → Payment Rules',
  cancellation_fee: 'Cancellation fee (onsite/offsite) — Payment Options → Payment Rules',
  deposit_percent: 'Down payment percentage — Payment Options → Payment Types',
  terms_and_conditions: "The café's Terms & Conditions text — Terms & Legal tab",
  data_privacy_policy: "The café's Data Privacy Policy text — Terms & Legal tab",
  amount_paid: 'Total amount paid so far on this reservation',
  remaining_balance: 'Outstanding balance still owed on this reservation',
  rejection_reason: 'Why a payment was rejected — Payment Rejected notice only',
};

export const SAMPLE_RESERVATION = {
  customer_name: 'Juan Dela Cruz',
  package_name: 'VIP Lounge Package',
  event_type: 'Birthday Party',
  event_date: 'August 15, 2026',
  event_time: '2:00 PM – 6:00 PM',
  venue: 'ELI Coffee Events Cafe Binangonan (Onsite)',
  reservation_number: 'ELI-260815-001',
  total_price: '₱28,000.00',
  guest_count: '50',
  contact_email: 'juan@example.com',
  contact_phone: '0917-123-4567',
  signed_date: 'August 1, 2026, 3:45 PM',
  amount_paid: '₱14,000.00',
  remaining_balance: '₱14,000.00',
  rejection_reason: 'Receipt image was unreadable',
};

export const TOKEN_REGEX = /\{\{\s*(\w+)\s*\}\}/g;

export function mergeTokens(text, values) {
  return String(text || '').replace(TOKEN_REGEX, (_m, key) => (key in values ? values[key] : `{{${key}}}`));
}

export function findUnknownTokens(text) {
  const found = new Set();
  let match;
  const re = new RegExp(TOKEN_REGEX);
  while ((match = re.exec(String(text || '')))) {
    if (!(match[1] in TOKEN_INFO)) found.add(match[1]);
  }
  return [...found];
}
