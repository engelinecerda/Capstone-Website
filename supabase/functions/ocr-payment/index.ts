import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GCP_KEY = Deno.env.get('GCP_VISION_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${GCP_KEY}`;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

type OcrResult = {
  raw_text: string | null;
  reference_number: string | null;
  amount: string | null;
  payment_date: string | null;
  confidence: string;
  processed_at: string;
  error: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

type ProviderKey = 'gcash' | 'maya' | 'bpi' | 'generic';

// payment.payment_method_label is a proper-cased snapshot written at
// submission time (see 20260729_payment_method_evidence_and_snapshot.sql)
// — "GCash", "Maya", "BPI", or whatever an admin named a custom method.
// Matched loosely (substring, case-insensitive) since it's free text, not
// an enum.
function detectProvider(methodLabel: string | null | undefined): ProviderKey {
  const label = String(methodLabel || '').toLowerCase();
  if (label.includes('gcash')) return 'gcash';
  if (label.includes('maya')) return 'maya';
  if (label.includes('bpi')) return 'bpi';
  return 'generic';
}

const CURRENCY_NUMBER = '([0-9][0-9,]*(?:\\.\\d{1,2})?)';
// Deliberately permissive — up to a handful of non-digit characters, not a
// specific symbol list. Cloud Vision doesn't always read ₱ correctly (a
// real GCash receipt came back with the peso sign OCR'd as "$", which a
// php|₱|p-only prefix silently failed to match, dropping a correct amount
// to null). The label anchor immediately before this ("Total Amount Sent",
// etc.) is what makes the match trustworthy — the currency glyph itself is
// just noise to skip past, not something worth validating strictly.
const CURRENCY_PREFIX = '[^\\d]{0,6}';

// Amount is extracted by anchoring on the label that precedes the ACTUAL
// total on each provider's receipt — never by grabbing the first
// peso-looking number anywhere in the OCR text. Receipts routinely
// contain other, smaller currency-formatted figures before the true
// total in reading order (a per-transaction fee line, a running balance,
// a promo amount), and matching "the first ₱/PHP/P followed by digits"
// (the previous approach) grabs whichever of those happens to come
// first — that's the exact bug this fixes (a fee line got parsed as if
// it were "Total Amount Sent").
//
// Per-provider patterns are tried first (most specific to least), then
// the generic fallback below — never the old bare-currency-symbol
// fallback, which is what let a wrong-but-confident value through in the
// first place. If nothing anchored matches, extractAmount returns null
// and the UI shows "Not detected" — an honest miss beats a wrong guess.
const AMOUNT_LABEL_PATTERNS: Record<ProviderKey, RegExp[]> = {
  gcash: [
    new RegExp(`total\\s*amount\\s*sent[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
    new RegExp(`amount\\s*sent[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
  ],
  maya: [
    new RegExp(`total\\s*amount[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
    new RegExp(`amount\\s*sent[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
  ],
  bpi: [
    new RegExp(`total\\s*debit[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
    new RegExp(`amount\\s*debited[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
  ],
  // Last-resort fallback for a provider we don't have a specific pattern
  // for (or a receipt layout that doesn't match the specific ones above)
  // — still requires a "total"/"amount ..." label immediately before the
  // number, unlike the old fallback which had no label requirement at all.
  generic: [
    new RegExp(`total\\s*amount\\s*(?:sent|paid|debited)?[:\\s]*${CURRENCY_PREFIX}${CURRENCY_NUMBER}`, 'i'),
  ],
};

function extractAmount(text: string, provider: ProviderKey): string | null {
  const patterns = provider === 'generic'
    ? AMOUNT_LABEL_PATTERNS.generic
    : [...AMOUNT_LABEL_PATTERNS[provider], ...AMOUNT_LABEL_PATTERNS.generic];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/,/g, '');
  }
  return null;
}

// Same anchoring principle as the amount: a labeled match only. The old
// code had a genericRefMatch fallback that matched *any* 9-21 digit run
// anywhere in the text with no label at all (a phone number, an account
// number, a truncated fragment) — dropped entirely, for the same reason
// the bare-currency amount fallback was dropped.
const REFERENCE_LABEL_PATTERNS: Record<ProviderKey, RegExp[]> = {
  gcash: [/ref(?:erence)?\.?\s*no\.?[:\s]*([0-9][0-9\s-]{8,20}[0-9])/i],
  maya: [/ref(?:erence)?\s*(?:no\.?|number)?[:\s]*([0-9][0-9\s-]{8,20}[0-9])/i],
  bpi: [/(?:trace|reference)\s*(?:no\.?|number)?[:\s]*([0-9][0-9\s-]{8,20}[0-9])/i],
  generic: [/ref(?:erence)?\s*(?:no\.?|number)?[:\s]*([0-9][0-9\s-]{8,20}[0-9])/i],
};

function extractReference(text: string, provider: ProviderKey): string | null {
  const patterns = provider === 'generic'
    ? REFERENCE_LABEL_PATTERNS.generic
    : [...REFERENCE_LABEL_PATTERNS[provider], ...REFERENCE_LABEL_PATTERNS.generic];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    // Preserve the matched digit run's own length rather than truncating —
    // only strip the spacing/dashes the receipt used to group it.
    const normalized = match[1].replace(/[^\d]/g, '');
    if (normalized.length >= 10 && normalized.length <= 13) return normalized;
  }
  return null;
}

function extractPaymentFields(rawText: string, methodLabel: string | null | undefined) {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const provider = detectProvider(methodLabel);

  const referenceNumber = extractReference(text, provider);
  const cleanAmount = extractAmount(text, provider);

  const dateMatch = text.match(
    /\b(\w{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{2}[/-]\d{2})\b/i,
  );

  // Character-legibility confidence only — see the "no confidence badge"
  // note in js/admin_payments.js's buildOcrPanel for why this is no
  // longer surfaced as a trust signal in the review UI. Kept here (and
  // still stored) since it's still a reasonable rough signal for "did the
  // scan find anything usable at all", just not a correctness claim.
  const found = [referenceNumber, cleanAmount, dateMatch?.[1]].filter(Boolean).length;
  const confidence = found === 3 ? 'high' : found === 2 ? 'medium' : 'low';

  return {
    reference_number: referenceNumber,
    amount: cleanAmount,
    payment_date: dateMatch?.[1] ?? null,
    confidence,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!GCP_KEY) {
    return jsonResponse({ success: false, saved: false, error: 'Missing GCP_VISION_API_KEY.' }, 500);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(
      { success: false, saved: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.' },
      500,
    );
  }

  let payment_id: string | undefined;
  let image_url: string | undefined;

  try {
    const body = await req.json();
    payment_id = body.payment_id;
    image_url = body.image_url;
  } catch {
    return jsonResponse({ success: false, saved: false, error: 'Invalid JSON body.' }, 400);
  }

  if (!payment_id || !image_url) {
    return jsonResponse(
      { success: false, saved: false, error: 'payment_id and image_url are required.' },
      400,
    );
  }

  console.log('ocr-payment started', {
    payment_id,
    image_url_host: (() => {
      try {
        return new URL(image_url).host;
      } catch {
        return 'invalid-url';
      }
    })(),
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetched up front so extractPaymentFields can pick the right
  // per-provider label patterns (GCash/Maya/BPI receipts each phrase
  // their total-amount and reference-number lines differently — see
  // detectProvider above). Missing/unreadable is not fatal: extraction
  // just falls back to the generic patterns.
  const { data: paymentRow } = await supabase
    .from('payment')
    .select('payment_method_label')
    .eq('payment_id', payment_id)
    .maybeSingle();

  let ocrResult: OcrResult;

  try {
    const visionRes = await fetch(VISION_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { source: { imageUri: image_url } },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          },
        ],
      }),
    });

    if (!visionRes.ok) {
      throw new Error(`Cloud Vision error ${visionRes.status}: ${await visionRes.text()}`);
    }

    supabase.rpc('increment_vision_usage', { p_units: 1 }).then(({ error }) => {
      if (error) console.error('ocr-payment usage tracking failed', error.message);
    });

    const visionData = await visionRes.json();
    const rawText = visionData?.responses?.[0]?.fullTextAnnotation?.text ?? '';
    const fields = extractPaymentFields(rawText, paymentRow?.payment_method_label);

    console.log('ocr-payment vision success', {
      payment_id,
      raw_text_length: rawText.length,
      confidence: fields.confidence,
    });

    ocrResult = {
      raw_text: rawText || null,
      ...fields,
      processed_at: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    console.error('ocr-payment vision failed', {
      payment_id,
      error: String((error as Error).message),
    });

    ocrResult = {
      raw_text: null,
      amount: null,
      reference_number: null,
      payment_date: null,
      confidence: 'failed',
      processed_at: new Date().toISOString(),
      error: String((error as Error).message),
    };
  }

  const { data: updatedPayment, error: dbError } = await supabase
    .from('payment')
    .update({ ocr_extracted: ocrResult })
    .eq('payment_id', payment_id)
    .select('payment_id')
    .maybeSingle();

  if (dbError) {
    console.error('ocr-payment db update failed', {
      payment_id,
      error: dbError.message,
    });

    return jsonResponse(
      {
        success: false,
        saved: false,
        ocr: ocrResult,
        error: `Failed to save OCR result to DB: ${dbError.message}`,
      },
      500,
    );
  }

  if (!updatedPayment) {
    console.error('ocr-payment payment row not found', { payment_id });

    return jsonResponse(
      {
        success: false,
        saved: false,
        ocr: ocrResult,
        error: `No payment row found for payment_id ${payment_id}.`,
      },
      404,
    );
  }

  return jsonResponse({
    success: ocrResult.error === null,
    saved: true,
    payment_id,
    ocr: ocrResult,
  });
});
