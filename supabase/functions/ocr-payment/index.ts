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

function extractPaymentFields(rawText: string) {
  const text = rawText.replace(/\s+/g, ' ').trim();

  const labeledRefMatch = text.match(
    /(?:ref(?:erence)?\s*(?:no\.?|number)?[:\s]*)(([0-9][0-9\s-]{8,20}[0-9]))/i,
  );
  const genericRefMatch = text.match(/\b(\d(?:[\d\s-]{8,20}\d))\b/);
  const rawReference = labeledRefMatch?.[1] ?? genericRefMatch?.[1] ?? null;
  const normalizedReference = rawReference ? rawReference.replace(/[^\d]/g, '') : null;
  const referenceNumber = normalizedReference && normalizedReference.length >= 10 && normalizedReference.length <= 13
    ? normalizedReference
    : null;

  const amountMatch = text.match(/(?:PHP|Php|P|\u20B1)\s*([0-9,]+(?:\.\d{1,2})?)/i);
  const cleanAmount = amountMatch ? amountMatch[1].replace(/,/g, '') : null;

  const dateMatch = text.match(
    /\b(\w{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{2}[/-]\d{2})\b/i,
  );

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

    const visionData = await visionRes.json();
    const rawText = visionData?.responses?.[0]?.fullTextAnnotation?.text ?? '';
    const fields = extractPaymentFields(rawText);

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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
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
