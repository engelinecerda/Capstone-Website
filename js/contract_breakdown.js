// contract_breakdown.js — the "Price Breakdown" and "Additional Requests"
// sections of the contract.
//
// The Reservation Summary only carries one figure (Total Amount). These two
// sections spell out how that figure was reached and list anything the
// customer asked for beyond the package, so the signed contract itself shows
// the computation — not only the reservation summary in the system.
//
// Used by the customer's Review & Sign preview (js/reservations.js) and the
// admin's Contract Template preview (js/admin_contract_template.js).
// supabase/functions/generate-signed-contract/index.ts (the signed PDF, the
// authoritative render) runs in Deno and cannot import this file, so it
// mirrors the same rows and wording — keep the two in sync if this changes
// (same convention as js/merge_tokens.js and js/contract_render.js).
//
// Order of operations (same as the booking form and the server):
//   package (+ add-on) + additional guests
//   − removed inclusions − discount            = Subtotal
//   + service charge (on the subtotal)
//   + offsite transport fee (never discounted, no service charge)  = Total
//
// Lines are written as "Label: detail — amount" so the full-screen reader's
// existing "Label: Value" detection turns each block into a list.

export const BREAKDOWN_HEADING = 'PRICE BREAKDOWN';
export const REQUESTS_HEADING = 'ADDITIONAL REQUESTS';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// v: {
//   packageName, packageAmount, addOnName, addOnAmount,
//   additionalHeads, additionalHeadPrice, additionalHeadCharge,
//   removedInclusions: [{ name, credit }],
//   discountLabel, discountPercent, discountAmount,
//   subtotal, servicePercent, serviceAmount,
//   transportFee, transportKm, total
// }
// fmt: peso formatter. Returns [{ label, detail, amount, strong }].
export function buildBreakdownRows(v, fmt) {
  const money = (n) => fmt(round2(n));
  const minus = (n) => '\u2212' + fmt(round2(n));
  const rows = [];

  rows.push({ label: 'Package', detail: v.packageName || '', amount: money(v.packageAmount) });

  if (round2(v.addOnAmount) > 0) {
    rows.push({ label: 'Add-on', detail: v.addOnName || '', amount: money(v.addOnAmount) });
  }

  if (Number(v.additionalHeads) > 0) {
    rows.push({
      label: 'Additional Guests',
      detail: `${v.additionalHeads} \u00D7 ${money(v.additionalHeadPrice)}`,
      amount: money(v.additionalHeadCharge),
    });
  }

  for (const inc of v.removedInclusions || []) {
    rows.push({
      label: 'Removed Inclusion',
      detail: inc.name || '',
      amount: round2(inc.credit) > 0 ? minus(inc.credit) : money(0),
    });
  }

  if (round2(v.discountAmount) > 0) {
    const pct = Number(v.discountPercent) > 0 ? `${Number(v.discountPercent)}% off` : '';
    const detail = v.discountLabel ? (pct ? `${v.discountLabel} (${pct})` : v.discountLabel) : pct;
    rows.push({ label: 'Discount', detail, amount: minus(v.discountAmount) });
  }

  const hasServiceCharge = round2(v.serviceAmount) > 0;
  const hasTransport = round2(v.transportFee) > 0;

  if (hasServiceCharge || hasTransport) {
    rows.push({ label: 'Subtotal', detail: '', amount: money(v.subtotal), strong: true });
  }
  if (hasServiceCharge) {
    rows.push({ label: 'Service Charge', detail: `${Number(v.servicePercent) || 0}%`, amount: money(v.serviceAmount) });
  }
  if (hasTransport) {
    rows.push({
      label: 'Transport Fee',
      detail: Number(v.transportKm) > 0 ? `${Number(v.transportKm)} km` : '',
      amount: money(v.transportFee),
    });
  }

  rows.push({ label: 'Total Amount', detail: '', amount: money(v.total), strong: true });
  return rows;
}

// Custom requests are not priced when the contract is signed — the café quotes
// them afterwards and they are charged only if the customer accepts — so the
// contract lists them and says they are outside the Total Amount.
export function buildRequestRows({ notes, customRequests }) {
  const rows = [];
  const cleanNotes = String(notes || '').replace(/\s+/g, ' ').trim();
  const titles = (customRequests || []).map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);

  if (cleanNotes) rows.push({ label: 'Special Requests', detail: cleanNotes, amount: '' });
  if (titles.length) {
    rows.push({ label: 'Custom Requests', detail: titles.join('; '), amount: '' });
    rows.push({
      label: 'Custom Request Pricing',
      detail: 'Quoted separately by the caf\u00E9 and charged only if the Client accepts the quote. Not included in the Total Amount above.',
      amount: '',
    });
  }
  return rows;
}

function rowToLine(row) {
  const value = row.detail && row.amount ? `${row.detail} \u2014 ${row.amount}` : (row.detail || row.amount);
  return `${row.label}: ${value}`;
}

// The contract's plain-text form (both previews render from text). Empty
// string when there is nothing to show, so callers can filter it out.
export function formatBreakdownText(rows) {
  return rows.length ? `${BREAKDOWN_HEADING}\n${rows.map(rowToLine).join('\n')}` : '';
}

export function formatRequestsText(rows) {
  return rows.length ? `${REQUESTS_HEADING}\n${rows.map(rowToLine).join('\n')}` : '';
}
