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

// Labels GCP Vision returns when handwriting or ink-based marks are present
const SIGNATURE_LABELS = new Set([
  'handwriting',
  'writing',
  'autograph',
  'signature',
  'pen',
  'ink',
  'manuscript',
  'hand writing',
  'calligraphy',
  'ballpoint pen',
  'pencil',
  'marker pen',
  'felt pen',
  'sketch',
  'doodle',
  'notation',
  'cursive',
  'letter',
  'note',
]);

type VisionBlock = {
  blockType?: string;
  confidence?: number;
  paragraphs?: VisionParagraph[];
};

type VisionParagraph = {
  words?: VisionWord[];
};

type VisionWord = {
  confidence?: number;
};

type VisionPage = {
  blocks?: VisionBlock[];
};

type LabelAnnotation = {
  description?: string;
  score?: number;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

/**
 * Converts a Cloudinary PDF URL to a JPEG URL by injecting the pg_1
 * transformation. GCP Vision cannot read PDFs directly.
 * Example:
 *   .../upload/v123/contracts/signed.pdf
 *   → .../upload/pg_1/v123/contracts/signed.jpg
 */
function toImageUrl(contractUrl: string): string {
  if (!contractUrl) return contractUrl;
  if (contractUrl.toLowerCase().includes('.pdf')) {
    return contractUrl
      .replace('/upload/', '/upload/pg_1/')
      .replace(/\.pdf$/i, '.jpg');
  }
  return contractUrl;
}

/**
 * Calls GCP Vision with LABEL_DETECTION and DOCUMENT_TEXT_DETECTION.
 *
 * Signed contracts are detected by:
 *   1. Label check      — GCP Vision returns handwriting-related labels.
 *   2. Block check      — A text block confidence < 0.80 suggests handwriting.
 *   3. Word check       — Any individual word with confidence < 0.60 strongly
 *                         suggests a cursive or handwritten word (e.g. a signature).
 */
async function detectSignature(imageUrl: string): Promise<{
  signed: boolean;
  confidence: 'high' | 'medium' | 'none';
  detectedLabels: string[];
  debugInfo: Record<string, unknown>;
}> {
  const res = await fetch(VISION_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { source: { imageUri: imageUrl } },
          features: [
            { type: 'LABEL_DETECTION', maxResults: 50 },
            { type: 'DOCUMENT_TEXT_DETECTION' },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`GCP Vision error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const result = data?.responses?.[0] ?? {};

  // --- Label detection ---
  const detectedLabels: string[] = (result.labelAnnotations ?? []).map(
    (l: LabelAnnotation) => String(l.description ?? '').toLowerCase(),
  );
  const hasSignatureLabel = detectedLabels.some((l) => SIGNATURE_LABELS.has(l));

  // --- Block and word confidence checks ---
  const pages: VisionPage[] = result.fullTextAnnotation?.pages ?? [];
  const blocks = pages.flatMap((p) => p.blocks ?? []);

  // Block with confidence < 0.80 suggests handwritten content
  const hasLowConfidenceBlock = blocks.some(
    (b) =>
      b.blockType === 'TEXT' &&
      typeof b.confidence === 'number' &&
      b.confidence < 0.80,
  );

  // Individual word with confidence < 0.60 strongly suggests a handwritten word/signature
  const allWords = blocks.flatMap((b) =>
    (b.paragraphs ?? []).flatMap((p) => p.words ?? [])
  );
  const lowConfidenceWords = allWords.filter(
    (w) => typeof w.confidence === 'number' && w.confidence < 0.60
  );
  const hasLowConfidenceWord = lowConfidenceWords.length > 0;

  const signed = hasSignatureLabel || hasLowConfidenceBlock || hasLowConfidenceWord;
  const confidence: 'high' | 'medium' | 'none' = hasSignatureLabel
    ? 'high'
    : (hasLowConfidenceBlock || hasLowConfidenceWord)
    ? 'medium'
    : 'none';

  const debugInfo = {
    totalBlocks: blocks.length,
    totalWords: allWords.length,
    lowConfidenceWordCount: lowConfidenceWords.length,
    hasLowConfidenceBlock,
    hasLowConfidenceWord,
    hasSignatureLabel,
  };

  return { signed, confidence, detectedLabels: detectedLabels.slice(0, 15), debugInfo };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!GCP_KEY) {
    return jsonResponse({ verified: false, error: 'Missing GCP_VISION_API_KEY.' }, 500);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ verified: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.' }, 500);
  }

  let reservation_id: string | undefined;
  let contract_url: string | undefined;

  try {
    const body = await req.json();
    reservation_id = body.reservation_id;
    contract_url = body.contract_url;
  } catch {
    return jsonResponse({ verified: false, error: 'Invalid JSON body.' }, 400);
  }

  if (!reservation_id || !contract_url) {
    return jsonResponse(
      { verified: false, error: 'reservation_id and contract_url are required.' },
      400,
    );
  }

  console.log('verify-contract started', { reservation_id });

  try {
    const imageUrl = toImageUrl(contract_url);
    const { signed, confidence, detectedLabels } = await detectSignature(imageUrl);

    console.log('verify-contract detection result', { reservation_id, signed, confidence, detectedLabels });

    if (!signed) {
      return jsonResponse({
        verified: false,
        reason: 'No handwritten signature detected in the uploaded contract.',
        confidence,
        detectedLabels,
      });
    }

    // Auto-verify: update reservation_contracts and advance reservation status
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const now = new Date().toISOString();

    const { error: contractError } = await supabase
      .from('reservation_contracts')
      .update({
        review_status: 'verified',
        verified_date: now,
        reviewed_at: now,
        review_notes: `Auto-verified: signature detected (confidence: ${confidence})`,
      })
      .eq('reservation_id', reservation_id)
      .not('contract_url', 'is', null);

    if (contractError) throw contractError;

    // Advance reservation to for_finalization only if currently awaiting contract
    await supabase
      .from('reservations')
      .update({ status: 'for_finalization' })
      .eq('reservation_id', reservation_id)
      .in('status', ['for_contract_signing', 'pending_review']);

    console.log('verify-contract auto-verified', { reservation_id });

    return jsonResponse({
      verified: true,
      reservation_id,
      confidence,
      message: 'Contract auto-verified. Reservation advanced to For Finalization.',
    });
  } catch (err) {
    console.error('verify-contract error', { reservation_id, error: String(err) });
    return jsonResponse({ verified: false, error: String((err as Error).message) }, 500);
  }
});
