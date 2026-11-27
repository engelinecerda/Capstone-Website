// Manager countersignature: the manager signs the customer-signed contract as
// part of Approve.
//
// POST JSON, Authorization: Bearer <manager session token>:
//   { reservation_id, signature_data_url (PNG data URL), password, time_zone? }
//
// What it does, in order:
//   1. Only a manager may call it (profiles.role = 'manager').
//   2. The manager's password is checked again (a throw-away auth client, so the
//      browser session is untouched). A wrong password stops here.
//   3. The contract must exist, be verified, not voided and not yet
//      countersigned (record_contract_countersignature() re-checks all of this
//      under a row lock).
//   4. The customer-signed PDF is downloaded and ONE page is appended carrying
//      the manager's drawn signature, printed name, role and signing time. The
//      customer-signed PDF itself (contract_url) is never changed: it stays as
//      the audit copy. The result is stored in countersigned_url.
//   5. The customer is notified (in-app + email).
//
// The function does NOT approve the reservation. The browser does that next
// with the usual status update; the database refuses it until the contract is
// countersigned (reservations_require_countersignature trigger).
//
// Deploy with the CLI (imports _shared/):
//   npx supabase functions deploy countersign-contract

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { MAX_SIGNATURE_BYTES, notifyCustomer, parseDataUrl } from '../_shared/id_signature_check.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CLOUDINARY_CLOUD_NAME = 'dtt707f1w';
const CLOUDINARY_UPLOAD_PRESET = 'eli_contracts';
const DEFAULT_TIME_ZONE = 'Asia/Manila';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function resolveTimeZone(candidate: unknown): string {
  const tz = typeof candidate === 'string' ? candidate.trim() : '';
  if (!tz || tz.length > 64) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-PH', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// pdf-lib's standard fonts only cover WinAnsi; strip anything else so a name
// with an unusual character can't make the page fail to render.
function sanitizeForPdf(text: string): string {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E -ÿ]/g, '')
    .trim();
}

async function uploadToCloudinary(
  bytes: Uint8Array,
  opts: { filename: string; folder: string },
): Promise<{ url: string; pages?: number }> {
  const mime = opts.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png';
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const form = new FormData();
  form.append('file', new Blob([arrayBuffer], { type: mime }), opts.filename);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  form.append('folder', opts.folder);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Cloudinary upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return { url: data.secure_url as string, pages: typeof data.pages === 'number' ? data.pages : undefined };
}

function formatStamp(date: Date, timeZone: string): string {
  return date.toLocaleString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZoneName: 'short', timeZone,
  });
}

// Wraps text to a width using the font's own measurements.
function wrapText(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function appendCountersignaturePage(
  pdfBytes: Uint8Array,
  opts: {
    signaturePng: Uint8Array;
    signerName: string;
    reservationNumber: string;
    customerName: string;
    customerSignedAt: string;
    signedAtLabel: string;
  },
): Promise<{ bytes: Uint8Array; pages: number }> {
  const pdf = await PDFDocument.load(pdfBytes);
  const first = pdf.getPage(0);
  const { width, height } = first.getSize();
  const page = pdf.addPage([width, height]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.13, 0.13, 0.13);
  const muted = rgb(0.4, 0.4, 0.4);
  const margin = 56;
  const contentWidth = width - margin * 2;
  let y = height - margin - 10;

  const heading = 'COUNTERSIGNATURE';
  page.drawText(heading, { x: (width - bold.widthOfTextAtSize(heading, 18)) / 2, y, size: 18, font: bold, color: ink });
  y -= 22;
  const sub = `Contract ${opts.reservationNumber}`;
  page.drawText(sub, { x: (width - font.widthOfTextAtSize(sub, 10)) / 2, y, size: 10, font, color: muted });
  y -= 34;

  const statement =
    `ELI Coffee Events has reviewed the contract signed by ${opts.customerName} on ${opts.customerSignedAt} ` +
    `and countersigns it through its authorized representative below. ` +
    `With this signature the contract is signed by both parties and is in effect.`;
  for (const line of wrapText(sanitizeForPdf(statement), font, 11, contentWidth)) {
    page.drawText(line, { x: margin, y, size: 11, font, color: ink });
    y -= 16;
  }
  y -= 30;

  // Signature, same drawn style as the customer's.
  const image = await pdf.embedPng(opts.signaturePng);
  const maxW = 200;
  const maxH = 70;
  const scale = Math.min(maxW / image.width, maxH / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  y -= h;
  page.drawImage(image, { x: margin, y, width: w, height: h });
  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + 260, y }, thickness: 0.8, color: ink });
  y -= 16;
  page.drawText(sanitizeForPdf(opts.signerName), { x: margin, y, size: 12, font: bold, color: ink });
  y -= 15;
  page.drawText('Authorized representative, ELI Coffee Events (Manager)', { x: margin, y, size: 10, font, color: muted });
  y -= 14;
  page.drawText(`Signed ${sanitizeForPdf(opts.signedAtLabel)}`, { x: margin, y, size: 10, font, color: muted });

  const note = 'The page before this one is the contract as signed by the customer.';
  page.drawText(note, { x: margin, y: margin, size: 8.5, font, color: muted });

  return { bytes: await pdf.save(), pages: pdf.getPageCount() };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return jsonResponse({ success: false, error: 'Server is not configured.' }, 500);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Caller must be a manager ------------------------------------------------
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  const { data: callerData, error: callerError } = await supabase.auth.getUser(token);
  if (callerError || !callerData?.user) {
    return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
  }
  const caller = callerData.user;

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, last_name')
    .eq('user_id', caller.id)
    .maybeSingle();
  if (String(profile?.role ?? '').toLowerCase() !== 'manager') {
    return jsonResponse({ success: false, error: 'Only a manager can sign a contract.' }, 403);
  }

  // 2. Request ------------------------------------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body.' }, 400);
  }
  const reservationId = typeof body.reservation_id === 'string' ? body.reservation_id.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const timeZone = resolveTimeZone(body.time_zone);
  if (!UUID_RE.test(reservationId)) {
    return jsonResponse({ success: false, error: 'Invalid reservation.' }, 400);
  }
  if (!password) {
    return jsonResponse({ success: false, error: 'Enter your password to sign.' }, 400);
  }
  const sig = parseDataUrl(body.signature_data_url, ['image/png'], MAX_SIGNATURE_BYTES);
  if (!sig) {
    return jsonResponse({ success: false, error: 'Please draw your signature.' }, 400);
  }

  // 3. Password check (separate client: nothing about the browser session changes)
  if (!caller.email) {
    return jsonResponse({ success: false, error: 'Your account has no email to confirm with.' }, 400);
  }
  const verifier = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: signIn, error: signInError } = await verifier.auth.signInWithPassword({
    email: caller.email,
    password,
  });
  if (signInError || signIn?.user?.id !== caller.id) {
    return jsonResponse({ success: false, error: 'That password is not correct.', code: 'bad_password' }, 401);
  }
  // No signOut() here: its default scope is 'global' and would revoke the
  // manager's real browser session. This client never persists a session.

  try {
    // 4. Contract must be ready ---------------------------------------------------
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .select('reservation_id, reservation_number, user_id, status')
      .eq('reservation_id', reservationId)
      .maybeSingle();
    if (reservationError) throw reservationError;
    if (!reservation) return jsonResponse({ success: false, error: 'Reservation not found.' }, 404);

    const { data: contract, error: contractError } = await supabase
      .from('reservation_contracts')
      .select('contract_url, review_status, verified_date, countersigned_at, voided_at')
      .eq('reservation_id', reservationId)
      .maybeSingle();
    if (contractError) throw contractError;
    if (!contract?.contract_url) {
      return jsonResponse({ success: false, error: 'The customer has not signed a contract yet.' }, 409);
    }
    if (contract.voided_at) {
      return jsonResponse({ success: false, error: 'This contract was voided.' }, 409);
    }
    if (contract.countersigned_at) {
      return jsonResponse({ success: true, already_signed: true });
    }
    const verified = String(contract.review_status ?? '').toLowerCase() === 'verified' || !!contract.verified_date;
    if (!verified) {
      return jsonResponse({ success: false, error: 'The contract must be verified before it can be signed.' }, 409);
    }

    const { data: customerSignature } = await supabase
      .from('contract_signatures')
      .select('signer_name, signed_at')
      .eq('reservation_id', reservationId)
      .eq('signer_role', 'customer')
      .order('signed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: customerProfile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('user_id', reservation.user_id)
      .maybeSingle();
    const customerName = sanitizeForPdf(
      customerSignature?.signer_name ||
        [customerProfile?.first_name, customerProfile?.last_name].filter(Boolean).join(' ') ||
        'the customer',
    );
    const customerSignedAt = customerSignature?.signed_at
      ? formatStamp(new Date(customerSignature.signed_at), timeZone)
      : 'the signing date';

    // 5. Build the countersigned PDF ------------------------------------------------
    const pdfResponse = await fetch(contract.contract_url);
    if (!pdfResponse.ok) throw new Error(`Could not read the signed contract (${pdfResponse.status}).`);
    const customerPdf = new Uint8Array(await pdfResponse.arrayBuffer());

    const signerName = sanitizeForPdf(
      [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || caller.email,
    );
    const reservationNumber = String(reservation.reservation_number || reservationId);
    const now = new Date();
    const signaturePng = base64ToBytes(sig.data);

    const { bytes: sealedPdf, pages } = await appendCountersignaturePage(customerPdf, {
      signaturePng,
      signerName,
      reservationNumber,
      customerName,
      customerSignedAt,
      signedAtLabel: formatStamp(now, timeZone),
    });

    const stamp = Date.now();
    const { url: signatureUrl } = await uploadToCloudinary(signaturePng, {
      filename: `manager-signature-${reservationNumber}-${stamp}.png`,
      folder: 'contracts/signatures',
    });
    const { url: countersignedUrl } = await uploadToCloudinary(sealedPdf, {
      filename: `contract-${reservationNumber}-countersigned-${stamp}.pdf`,
      folder: 'contracts',
    });

    // 6. Record it (re-checks the rules under a row lock) ------------------------------
    const { error: recordError } = await supabase.rpc('record_contract_countersignature', {
      p_reservation_id: reservationId,
      p_countersigned_url: countersignedUrl,
      p_page_count: pages,
      p_signer_id: caller.id,
      p_signer_name: signerName,
      p_signature_url: signatureUrl,
    });
    if (recordError) {
      return jsonResponse({ success: false, error: recordError.message || 'Could not record the signature.' }, 409);
    }

    // 7. Tell the customer (best effort; never undoes the signature) --------------------
    try {
      await notifyCustomer(
        supabase,
        reservation.user_id,
        reservationId,
        'Your contract is fully signed',
        `ELI has countersigned your contract for reservation ${reservationNumber}. The fully signed copy is available on your reservation.`,
      );
    } catch (notifyError) {
      console.error('countersign notify failed', { error: String((notifyError as Error).message) });
    }

    return jsonResponse({
      success: true,
      countersigned_url: countersignedUrl,
      signer_name: signerName,
      signed_at: now.toISOString(),
    });
  } catch (error) {
    console.error('countersign-contract failed', { error: String((error as Error).message) });
    return jsonResponse({ success: false, error: 'We could not sign the contract. Please try again.' }, 500);
  }
});