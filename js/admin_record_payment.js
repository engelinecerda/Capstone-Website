// js/admin_record_payment.js
// Shared logic for the manager "Record payment" action — used by both
// admin_reservation_details.js and admin_payments.js so there is exactly
// one Cloudinary upload path, one insert path, and one receipt-creation
// path for in-café payments (previously receipt creation only happened
// inside the online-payment approve flow in admin_payments.js; in-café
// rows insert already-approved and never pass through that flow, so it's
// relocated here and re-exported for admin_payments.js's own approve flow
// to keep using).

const CLOUDINARY_CONFIG = {
  cloudName: 'dtt707f1w',
  // See the matching comment in js/customer_payments.js — eli_contracts'
  // fixed Asset Folder ("contracts") silently overrides any folder param
  // sent by the client. eli_payments is a dedicated preset (Asset folder
  // "payments") so manager-recorded receipts stop landing there too.
  uploadPreset: 'eli_payments',
  folder: 'payments',
  maxFileSize: 5 * 1024 * 1024
};

export async function uploadPaymentReceipt(file) {
  if (!file) return '';

  if (file.size > CLOUDINARY_CONFIG.maxFileSize) {
    throw new Error('Receipt file must be 5MB or smaller.');
  }
  if (Number(file.size || 0) <= 0) {
    throw new Error('The selected receipt file is empty. Please choose a valid file.');
  }

  const mimeType = String(file.type || '').toLowerCase();
  const extension = `.${String(file.name || '').toLowerCase().split('.').pop()}`;
  const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']);
  const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.pdf']);

  if (!allowedMimeTypes.has(mimeType) && !allowedExtensions.has(extension)) {
    throw new Error('Please upload the receipt as a JPG, JPEG, PNG, or PDF file.');
  }

  const isPdf = mimeType === 'application/pdf' || extension === '.pdf';
  const resourceType = isPdf ? 'raw' : 'auto';

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);
  formData.append('folder', CLOUDINARY_CONFIG.folder);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/${resourceType}/upload`,
    { method: 'POST', body: formData }
  );

  if (!response.ok) {
    throw new Error('Failed to upload receipt.');
  }

  const result = await response.json();
  return result.secure_url || '';
}

function generateReceiptNumber(paymentId) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AR-${stamp}-${String(paymentId || '').slice(0, 6).toUpperCase()}`;
}

// existingReceipt: an already-fetched receipt row for this payment, if the
// caller has one cached (avoids a redundant lookup) — pass null/undefined
// otherwise and this will look it up itself before inserting.
export async function ensureReceiptForPayment(supabase, paymentId, existingReceipt = null) {
  if (existingReceipt) return existingReceipt;

  const { data: lookedUpReceipt, error: lookupError } = await supabase
    .from('receipts')
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (lookedUpReceipt) return lookedUpReceipt;

  const payload = {
    payment_id: paymentId,
    receipt_number: generateReceiptNumber(paymentId),
    issued_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('receipts')
    .insert(payload)
    .select('receipt_id, payment_id, receipt_number, issued_at')
    .single();

  if (error) throw error;
  return data;
}

function formatTimeOfDay(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

// The only source of payment methods offered when recording an in-café
// payment — no hardcoded method list anywhere. Only active, cafe_issued
// methods are valid here (customer_submitted methods need a reference
// number/proof the manager isn't the one providing).
export async function fetchCafeIssuedPaymentMethods(supabase) {
  const { data, error } = await supabase
    .from('payment_method')
    .select('payment_method_id, label, type, icon_key, evidence_source')
    .eq('is_active', true)
    .eq('evidence_source', 'cafe_issued')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

// recordedByUserId must come from the caller's own live session
// (session.user.id) — never from anything the browser could otherwise
// influence, since the RLS policy also checks recorded_by = auth.uid()
// but a clear client-side guard avoids a confusing RLS-rejection round trip.
//
// existingPaymentId present -> UPDATE that pending row in place (a queue
// row the customer already submitted as "I'll pay cash/card on arrival" —
// recording confirms what actually happened rather than creating a second,
// duplicate transaction, and preserves whatever payment_type the customer
// actually submitted instead of masking it). payment_source flips to
// 'in_cafe' on that update: the manager is now the one vouching for the
// transaction, regardless of which flow originally created the row.
// existingPaymentId absent -> INSERT a brand-new row, hardcoded
// payment_type 'partial_payment' ("Custom Amount") — reserved for a
// genuinely unplanned payment with no prior customer submission to
// confirm. Both callers (admin_reservation_details.js's Record Payment
// button, admin_payments.js's per-row one) now check for an existing
// pending cafe-issued row first and only fall through to this branch when
// none exists — see getPendingCafePayment() in admin_reservation_details.js.
export async function recordInCafePayment(supabase, {
  reservationId,
  existingPaymentId = null,
  amount,
  paymentMethodId,
  paymentMethodLabel,
  paymentMethodType,
  actualPaymentDate,
  referenceNumber,
  notes,
  receiptUrl,
  recordedByUserId
}) {
  if (!reservationId) throw new Error('No reservation was specified.');
  if (!recordedByUserId) throw new Error('Could not determine the current manager session.');
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Amount paid must be greater than zero.');
  }
  if (!paymentMethodId) {
    throw new Error('Select a payment method.');
  }
  if (!actualPaymentDate) {
    throw new Error('Select the actual payment date.');
  }

  const now = new Date();

  if (existingPaymentId) {
    const updatePayload = {
      payment_status: 'approved',
      payment_source: 'in_cafe',
      payment_method_id: paymentMethodId,
      payment_method_label: paymentMethodLabel || null,
      payment_method: paymentMethodType || null,
      amount: numericAmount,
      actual_payment_date: actualPaymentDate,
      actual_payment_time: formatTimeOfDay(now),
      recorded_by: recordedByUserId,
      verified_at: now.toISOString()
    };
    // Never overwrite an existing value with an empty one — only include
    // these when the manager actually supplied something new.
    if (referenceNumber) updatePayload.reference_number = referenceNumber;
    if (notes) updatePayload.notes = notes;
    if (receiptUrl) updatePayload.proof_url = receiptUrl;

    const { data, error } = await supabase
      .from('payment')
      .update(updatePayload)
      .eq('payment_id', existingPaymentId)
      .eq('payment_status', 'pending_review')
      .select('payment_id')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('This payment was already updated — please refresh and try again.');

    await ensureReceiptForPayment(supabase, data.payment_id);
    return data;
  }

  const payload = {
    reservation_id: reservationId,
    payment_type: 'partial_payment',
    payment_source: 'in_cafe',
    payment_method_id: paymentMethodId,
    payment_method_label: paymentMethodLabel || null,
    payment_method: paymentMethodType || null,
    amount: numericAmount,
    payment_status: 'approved',
    reference_number: referenceNumber || null,
    notes: notes || null,
    proof_url: receiptUrl || null,
    actual_payment_date: actualPaymentDate,
    actual_payment_time: formatTimeOfDay(now),
    recorded_by: recordedByUserId,
    submitted_at: now.toISOString(),
    verified_at: now.toISOString()
  };

  const { data, error } = await supabase
    .from('payment')
    .insert(payload)
    .select('payment_id')
    .single();

  if (error) throw error;

  await ensureReceiptForPayment(supabase, data.payment_id);

  return data;
}
