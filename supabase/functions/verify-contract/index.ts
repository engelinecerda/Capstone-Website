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

type VisionVertex = { x?: number; y?: number };

type VisionBlock = {
  blockType?: string;
  confidence?: number;
  paragraphs?: VisionParagraph[];
  boundingBox?: { vertices?: VisionVertex[] };
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
 * Converts a Cloudinary PDF URL to a JPEG URL by injecting a pg_N page
 * transformation. GCP Vision cannot read PDFs directly.
 * Example (page = 3):
 *   .../upload/v123/contracts/signed.pdf
 *   → .../upload/pg_3/v123/contracts/signed.jpg
 *
 * `page` should be the contract's last page — buildContractPdf() in
 * generate-signed-contract always draws the signature section last, so the
 * signature is never on page 1 of a multi-page contract. Defaults to 1 for
 * contracts uploaded before page_count started being tracked.
 */
function toImageUrl(contractUrl: string, page = 1): string {
  if (!contractUrl) return contractUrl;
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  if (contractUrl.toLowerCase().includes('.pdf')) {
    return contractUrl
      .replace('/upload/', `/upload/pg_${safePage}/`)
      .replace(/\.pdf$/i, '.jpg');
  }
  return contractUrl;
}

/**
 * True if a text block's bounding box is meaningfully tilted rather than
 * axis-aligned. Contract pages are rendered programmatically (buildContractPdf
 * → Cloudinary image conversion), so every printed line is a perfectly
 * horizontal rectangle — Vision confirms this empirically (0.0°–0.3° on real
 * contracts). A handwritten/cursive signature stroke is the one thing that
 * produces a rotated OCR block, since Vision still tries to box it as "text"
 * but follows the ink's natural slant. This is a much more reliable signal
 * than OCR confidence, which can land on either side of a threshold by
 * chance (a real signature was seen scoring 0.824, just above the old 0.80
 * cutoff) and than LABEL_DETECTION, which is tuned for photographed scenes
 * and never returns handwriting/signature labels for a document screenshot.
 */
function isSkewedBlock(vertices: VisionVertex[] | undefined): boolean {
  if (!vertices || vertices.length < 2) return false;
  const [p0, p1] = vertices;
  const dx = (p1.x ?? 0) - (p0.x ?? 0);
  const dy = (p1.y ?? 0) - (p0.y ?? 0);
  if (dx === 0 && dy === 0) return false;
  const angleDeg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  const deviationFromHorizontal = Math.min(angleDeg, Math.abs(180 - angleDeg));
  return deviationFromHorizontal > 5;
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
async function detectSignature(
  imageUrl: string,
  supabase: ReturnType<typeof createClient>,
): Promise<{
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

  supabase.rpc('increment_vision_usage', { p_units: 2 }).then(({ error }) => {
    if (error) console.error('verify-contract usage tracking failed', error.message);
  });

  const data = await res.json();
  const result = data?.responses?.[0] ?? {};

  // Vision returns per-image errors inside responses[0].error rather than
  // failing the HTTP call — e.g. when imageUri didn't resolve to a real
  // image (a broken Cloudinary transform, a 404, an unreadable format).
  // Left unchecked, this silently reads as empty annotations → "not signed"
  // instead of the actual scan failure it is.
  if (result.error) {
    throw new Error(`GCP Vision could not read the image: ${result.error.message || JSON.stringify(result.error)}`);
  }

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

  // A block whose blockType is TEXT but whose box is rotated — see
  // isSkewedBlock() for why this is the most reliable of the four signals.
  const skewedBlocks = blocks.filter(
    (b) => b.blockType === 'TEXT' && isSkewedBlock(b.boundingBox?.vertices),
  );
  const hasSkewedBlock = skewedBlocks.length > 0;

  const signed = hasSignatureLabel || hasLowConfidenceBlock || hasLowConfidenceWord || hasSkewedBlock;
  const confidence: 'high' | 'medium' | 'none' = (hasSignatureLabel || hasSkewedBlock)
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
    hasSkewedBlock,
    skewedBlockCount: skewedBlocks.length,
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
  let page_count: number | undefined;

  try {
    const body = await req.json();
    reservation_id = body.reservation_id;
    contract_url = body.contract_url;
    page_count = typeof body.page_count === 'number' ? body.page_count : undefined;
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const imageUrl = toImageUrl(contract_url, page_count ?? 1);
    const { signed, confidence, detectedLabels } = await detectSignature(imageUrl, supabase);

    console.log('verify-contract detection result', { reservation_id, signed, confidence, detectedLabels });

    if (!signed) {
      // Persist the negative result — this trigger fires via pg_net's
      // fire-and-forget http_post, so nothing else ever reads this
      // response. Without writing it back, review_notes stays empty and
      // the admin UI's regex-based state (js/admin_reservation_details.js's
      // renderSignatureCheckPanel) defaults to "not yet scanned" forever,
      // indistinguishable from a scan that never ran at all. review_status
      // stays 'pending_review' — this is not a rejection, just an
      // inconclusive automatic check; a Manager can still verify manually.
      await supabase
        .from('reservation_contracts')
        .update({
          reviewed_at: new Date().toISOString(),
          review_notes: `Automatic scan: signature not detected (confidence: ${confidence}). Open the contract to check manually.`,
        })
        .eq('reservation_id', reservation_id)
        .not('contract_url', 'is', null);

      return jsonResponse({
        verified: false,
        reason: 'No handwritten signature detected in the uploaded contract.',
        confidence,
        detectedLabels,
      });
    }

    // Auto-verify: update reservation_contracts and advance reservation status
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

    // Same reasoning as the !signed branch above — without this, a Vision
    // API failure (bad image URL, quota, network) leaves review_notes empty
    // and the contract stuck reading "not yet scanned" forever, with no
    // trail explaining why the scan never resolved. Best-effort: if this
    // write itself fails, the error response below still goes out.
    if (reservation_id) {
      try {
        await supabase
          .from('reservation_contracts')
          .update({
            reviewed_at: new Date().toISOString(),
            review_notes: `Automatic scan could not complete (${String((err as Error).message)}). Signature not detected automatically — open the contract to check manually.`,
          })
          .eq('reservation_id', reservation_id)
          .not('contract_url', 'is', null);
      } catch { /* best-effort only, the 500 response below still reports the real error */ }
    }

    return jsonResponse({ verified: false, error: String((err as Error).message) }, 500);
  }
});
