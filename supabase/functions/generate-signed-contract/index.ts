import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb, degrees } from 'https://esm.sh/pdf-lib@1.17.1';
import {
  applyIdCheckResult,
  compareIdAndSignature,
  loadSavedIdForUser,
  MAX_ID_BYTES,
  MAX_ID_CHECK_ATTEMPTS,
  MAX_SIGNATURE_BYTES,
  parseDataUrl,
  RETRYABLE_VERDICTS,
  recordIdCheckError,
  type Verdict,
} from '../_shared/id_signature_check.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CLOUDINARY_CLOUD_NAME = 'dtt707f1w';
const CLOUDINARY_UPLOAD_PRESET = 'eli_contracts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// Used whenever a package's active contract_templates row has no
// template_body configured yet, so booking never hard-blocks on missing
// admin setup. Admins can override this per-package in admin/contracts.html.
// Structured with the same ALL-CAPS heading convention the PDF renderer
// below parses (EVENT DETAILS, then one heading per clause) so the fallback
// renders through the same rich layout as every seeded template.
const DEFAULT_TEMPLATE_BODY = `RESERVATION SERVICE AGREEMENT

This Reservation Service Agreement ("Agreement") is entered into between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client") for the event and package described below.

EVENT DETAILS
Reservation Number: {{reservation_number}}
Package: {{package_name}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Venue: {{venue}}
Guest Count: {{guest_count}}
Total Package Price: {{total_price}}

BOOKING CONFIRMATION
This reservation is confirmed upon submission of this signed Agreement and payment of the applicable reservation fee or down payment as described in the Venue's Reservation Rules.

CANCELLATION AND RESCHEDULING
Cancellation fees and rescheduling terms follow the Venue's published Cancellation and Rescheduling policies, which the Client has reviewed and agrees to as part of accepting the Terms and Conditions.

CLIENT RESPONSIBILITIES
The Client agrees to provide accurate event details, guest counts, and contact information, and to notify the Venue promptly of any changes to the reservation.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is being signed electronically, and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792). By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.`;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function formatCurrency(amount: number): string {
  return '₱' + Number(amount || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// The Edge Function runs in UTC, so date/time labels formatted without a
// time zone showed the UTC date — which can be a different calendar day from
// the one the customer signed on (e.g. signing at 7 AM in Manila is still the
// previous evening in UTC). The browser sends its own IANA time zone and the
// labels are formatted in it; an unknown/invalid value falls back to the
// business's own zone so the contract never goes out in UTC by accident.
const DEFAULT_TIME_ZONE = 'Asia/Manila';

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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'TBD';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function mergeTemplate(template: string, data: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => data[key] ?? '');
}

// Fallback Reservation Summary rows — used only if the contract_field table
// is empty/unreachable. Mirrors the seed data in
// 20260730_contract_template_structure.sql exactly.
const DEFAULT_SUMMARY_FIELDS: SummaryField[] = [
  { token: 'reservation_number', label: 'Reservation Number' },
  { token: 'customer_name', label: 'Client Name' },
  { token: 'event_type', label: 'Event Type' },
  { token: 'venue', label: 'Venue' },
  { token: 'package_name', label: 'Package' },
  { token: 'event_date', label: 'Event Date' },
  { token: 'event_time', label: 'Event Time' },
  { token: 'guest_count', label: 'Guests' },
  { token: 'total_price', label: 'Total Amount' },
];

// Fallback Layer 3 text — used only if contract_locked_clause is empty/
// unreachable. Exact wording this file already hardcoded before Layer 3
// moved into the database (kept here as a last-resort safety net, same
// pattern as DEFAULT_TEMPLATE_BODY above).
const DEFAULT_ACKNOWLEDGEMENT_BODY =
  'By signing below, the Client acknowledges having read and understood this Agreement in full and agrees to be bound by its terms.';
const DEFAULT_ELECTRONIC_SIGNATURE_CLAUSE = {
  heading: 'Electronic Signature',
  body:
    'The Client acknowledges that this Agreement is being signed electronically, and agrees that such electronic ' +
    'signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine ' +
    "Electronic Commerce Act (Republic Act No. 8792). By signing below, the Client confirms that the reservation " +
    "details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and " +
    'Data Privacy Policy.',
};

// pdf-lib's Standard 14 fonts (Helvetica) use WinAnsiEncoding (Windows-1252).
// That encoding has no peso sign, but it DOES support common "smart"
// punctuation whose Unicode code points happen to be above 0xFF — em/en
// dash, curly quotes, bullet, ellipsis, trademark, Euro, etc. (cp1252 maps
// these into its 0x80-0x9F byte range). A naive "strip anything above 0xFF"
// filter mangles that legitimate punctuation into "?". Only characters
// truly outside cp1252's repertoire (CJK, emoji, other currency symbols,
// etc.) need a fallback.
const WINANSI_SPECIAL_CODEPOINTS = new Set([
  0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022,
  0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178,
]);

function sanitizeForPdf(text: string): string {
  return Array.from(text.replace(/₱/g, 'PHP ')).map((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xFF || WINANSI_SPECIAL_CODEPOINTS.has(code)) return ch;
    return '?';
  }).join('');
}

function wrapText(text: string, font: any, fontSize: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function base64ToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function uploadToCloudinary(
  bytes: Uint8Array,
  opts: { filename: string; folder: string; resourceType: 'image' | 'raw' },
): Promise<{ url: string; pages?: number }> {
  const form = new FormData();
  // mime must reflect the actual file bytes, not resourceType — the contract
  // PDF now uploads as resourceType 'image' too (see call site comment) so it
  // can no longer be inferred from resourceType alone.
  const mime = opts.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png';
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: mime });
  form.append('file', blob, opts.filename);
  form.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  form.append('folder', opts.folder);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${opts.resourceType}/upload`,
    { method: 'POST', body: form },
  );

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return { url: data.secure_url as string, pages: typeof data.pages === 'number' ? data.pages : undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract text parsing — turns the flat, merged template_body text into
// structured sections without ever touching how it's stored or merged. Every
// seeded template (and DEFAULT_TEMPLATE_BODY above) follows one convention:
// a title line or two, a blank line, an intro sentence, then one ALL-CAPS
// heading per concept with its body directly below.
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateSection {
  heading: string;
  bodyLines: string[];
}

function isAllCapsHeading(line: string): boolean {
  return line.length > 0 && line.length < 60 && line === line.toUpperCase() && /[A-Z]/.test(line);
}

function parseTemplateSections(bodyText: string): { intro: string[]; sections: TemplateSection[] } {
  const lines = bodyText.split('\n').map((l) => l.trim());
  const intro: string[] = [];
  const sections: TemplateSection[] = [];
  let phase: 'title' | 'intro' | 'sections' = 'title';
  let current: TemplateSection | null = null;

  for (const line of lines) {
    if (!line) continue;
    if (phase === 'title') {
      if (isAllCapsHeading(line)) continue;
      phase = 'intro';
    }
    if (phase === 'intro') {
      if (isAllCapsHeading(line)) {
        phase = 'sections';
      } else {
        intro.push(line);
        continue;
      }
    }
    if (isAllCapsHeading(line)) {
      current = { heading: line, bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  return { intro, sections };
}

type SectionKind = 'venue' | 'package' | 'terms' | 'skip';

function classifySection(heading: string): SectionKind {
  const h = heading.toUpperCase();
  if (h.includes('EVENT DETAILS') || h.includes('ORDER DETAILS')) return 'skip';
  if (h.includes('VENUE DETAILS')) return 'venue';
  if (h.startsWith('PACKAGE') || h === 'INCLUSIONS' || h.includes('CATERING PACKAGE') || h === 'PRICING') return 'package';
  return 'terms';
}

// Some sections/lines name a specific package tier (e.g. "STANDARD CATERING
// PACKAGE", "VIP Plus (₱3,999) — ..."). Only the tier actually booked should
// appear — everything else is filtered out by checking whether a tier
// keyword found in the heading/line also appears in the booked package name.
const TIER_KEYWORDS = ['essential', 'standard', 'basic', 'plus', 'max', 'lite'];

function tierWordsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return TIER_KEYWORDS.filter((kw) => lower.includes(kw));
}

function sectionMatchesPackage(heading: string, packageName: string): boolean {
  const headingTierWords = tierWordsIn(heading);
  if (!headingTierWords.length) return true;
  const pkgLower = packageName.toLowerCase();
  return headingTierWords.some((kw) => pkgLower.includes(kw));
}

function lineMatchesPackage(line: string, packageName: string): boolean {
  const lineTierWords = tierWordsIn(line);
  if (!lineTierWords.length) return true;
  const pkgLower = packageName.toLowerCase();
  return lineTierWords.some((kw) => pkgLower.includes(kw));
}

function filterLinesForPackage(lines: string[], packageName: string): string[] {
  const filtered = lines.filter((l) => lineMatchesPackage(l, packageName));
  return filtered.length ? filtered : lines;
}

// Unicode Private Use Area character — used as a temporary placeholder for
// thousands-separator commas (see splitDetailLine below). Never appears in
// real template text, so it's safe as a round-trip marker.
const THOUSANDS_COMMA_MASK = '';

// Splits a line like "VIP Lite (₱2,999) — 2 hours use of VIP Lounge, ₱2,000
// Food & Drinks Credit." into a short label ("VIP Lite (₱2,999)") and a list
// of individual checklist-friendly items. Lines with no em-dash (already
// one-item-per-line source text, or a plain comma list) get no label.
function splitDetailLine(line: string): { label: string; items: string[] } {
  const dashParts = line.split(/\s[—–]\s/);
  const label = dashParts.length >= 2 ? dashParts[0].trim() : '';
  const rest = (dashParts.length >= 2 ? dashParts.slice(1).join(' — ') : line).replace(/\.$/, '').trim();
  if (!rest) return { label, items: [] };

  // Thousands-separator commas (e.g. "28,000") have no space after them,
  // unlike list-separating commas ("item one, item two"). Mask them as a
  // single unit first so the split below can't be confused by a
  // coincidentally-3-digit number right after a real list separator
  // (e.g. "PHP 28,000, 100 pax: PHP 48,000").
  const masked = rest.replace(/\d{1,3}(,\d{3})+/g, (m) => m.split(',').join(THOUSANDS_COMMA_MASK));
  const items = masked
    // Only ", and X" (comma-preceded — a real list separator) gets folded
    // into a plain comma; a bare "and" inside a two-word item name like
    // "food and drinks" has no preceding comma and is left untouched.
    .replace(/,\s+and\s+/gi, ', ')
    // Split on commas AND sentence-ending periods (some seeded paragraphs
    // run two sentences together, e.g. "...water. Full buffet setup...").
    .split(/[,.]\s+/)
    .map((s) => s.trim().split(THOUSANDS_COMMA_MASK).join(','))
    .filter(Boolean);
  return { label, items: items.length ? items : [rest] };
}

// Older templates have the package price and extension rate typed into the
// text (e.g. "VIP Lite (PHP 2,999)", "Extension Hour: PHP 800 per hour"), which
// goes stale the moment a price is edited. For those lines the PDF swaps in the
// booked package price and the package's real extension rate. Lines that use
// {{package_price}} / {{extension_price}} are already correct and pass through
// unchanged (the replacement writes the same value).
const PESO_AMOUNT = String.raw`(?:₱|PHP\s?)\s?\d[\d,]*(?:\.\d+)?`;

function applyLivePackagePricing(
  entries: { label: string; items: string[] }[],
  packagePrice: number,
  extensionPrice: number,
): { label: string; items: string[] }[] {
  const priceInParens = new RegExp(String.raw`\(\s*${PESO_AMOUNT}\s*\)`);
  const extensionLine = /^extension\s+hour\b/i;
  return entries.map((entry) => {
    const label = packagePrice > 0
      ? entry.label.replace(priceInParens, `(${formatCurrency(packagePrice)})`)
      : entry.label;
    const items = entry.items.flatMap((item) => {
      if (!extensionLine.test(item)) return [item];
      // No extension rate on the package: drop the line rather than print a
      // price the café no longer charges.
      if (!(extensionPrice > 0)) return [];
      return [`Extension Hour: ${formatCurrency(extensionPrice)} per hour`];
    });
    return { label, items };
  }).filter((entry) => entry.label || entry.items.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF layout constants + drawing context
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_TOP = 60;
const MARGIN_BOTTOM = 60;
const MARGIN_LEFT = 55;
const MARGIN_RIGHT = 55;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const LABEL_COLUMN_WIDTH = 165;

const COLOR_TEXT = rgb(0.11, 0.08, 0.03);
const COLOR_MUTED = rgb(0.45, 0.4, 0.35);
const COLOR_ACCENT = rgb(0.42, 0.23, 0.13);
const COLOR_DIVIDER = rgb(0.8, 0.74, 0.66);
const COLOR_WATERMARK = rgb(0.9, 0.87, 0.82);

const FONT_SIZE_TITLE = 19;
const FONT_SIZE_SUBTITLE = 12;
const FONT_SIZE_SECTION = 12.5;
const FONT_SIZE_BODY = 10.5;
const FONT_SIZE_LABEL = 10;
const FONT_SIZE_SMALL = 8.5;

const LINE_HEIGHT_BODY = 14;
const LINE_HEIGHT_LABEL = 13.5;

interface Ctx {
  pdfDoc: any;
  font: any;
  boldFont: any;
  page: any;
  y: number;
}

function drawWatermark(ctx: Ctx) {
  const text = 'ELI COFFEE';
  const size = 58;
  const width = ctx.boldFont.widthOfTextAtSize(text, size);
  ctx.page.drawText(text, {
    x: (PAGE_WIDTH - width) / 2,
    y: PAGE_HEIGHT / 2 - size / 2,
    size,
    font: ctx.boldFont,
    color: COLOR_WATERMARK,
    rotate: degrees(30),
  });
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.y = PAGE_HEIGHT - MARGIN_TOP;
  drawWatermark(ctx);
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN_BOTTOM) newPage(ctx);
}

function moveDown(ctx: Ctx, amount: number) {
  ctx.y -= amount;
}

function drawDivider(ctx: Ctx) {
  ensureSpace(ctx, 10);
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: ctx.y },
    thickness: 0.75,
    color: COLOR_DIVIDER,
  });
  moveDown(ctx, 14);
}

function drawSectionHeading(ctx: Ctx, title: string) {
  // Reserve room for the heading PLUS at least one line of body content —
  // otherwise a heading can land alone at the very bottom of a page with its
  // entire section pushed to the next page, leaving a stranded heading above
  // a large blank gap before the footer.
  ensureSpace(ctx, FONT_SIZE_SECTION + 24 + LINE_HEIGHT_BODY);
  moveDown(ctx, 4);
  ctx.page.drawText(title.toUpperCase(), {
    x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_SECTION, font: ctx.boldFont, color: COLOR_ACCENT,
  });
  moveDown(ctx, FONT_SIZE_SECTION + 6);
  drawDivider(ctx);
}

function drawParagraph(ctx: Ctx, text: string, opts: { size?: number; font?: any; color?: any; lineHeight?: number } = {}) {
  if (!text) return;
  const safeText = sanitizeForPdf(text);
  const size = opts.size ?? FONT_SIZE_BODY;
  const font = opts.font ?? ctx.font;
  const color = opts.color ?? COLOR_TEXT;
  const lineHeight = opts.lineHeight ?? LINE_HEIGHT_BODY;
  for (const line of wrapText(safeText, font, size, CONTENT_WIDTH)) {
    ensureSpace(ctx, lineHeight);
    ctx.page.drawText(line, { x: MARGIN_LEFT, y: ctx.y, size, font, color });
    moveDown(ctx, lineHeight);
  }
}

// Every dynamic string ends up routed through here (or drawParagraph /
// drawChecklistItem) before it ever reaches wrapText/drawText — pdf-lib
// throws on unencodable characters (e.g. "₱") during BOTH width measurement
// and drawing, so sanitizing has to happen before wrapText runs, not just
// before drawText.
function drawLabelValueRow(ctx: Ctx, label: string, value: string) {
  const safeLabel = sanitizeForPdf(label);
  const safeValue = sanitizeForPdf(value || 'Not specified');
  const valueLines = wrapText(safeValue, ctx.font, FONT_SIZE_LABEL, CONTENT_WIDTH - LABEL_COLUMN_WIDTH);
  ensureSpace(ctx, LINE_HEIGHT_LABEL * valueLines.length);
  ctx.page.drawText(safeLabel, { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.boldFont, color: COLOR_MUTED });
  valueLines.forEach((line, i) => {
    if (i > 0) ensureSpace(ctx, LINE_HEIGHT_LABEL);
    ctx.page.drawText(line, { x: MARGIN_LEFT + LABEL_COLUMN_WIDTH, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.font, color: COLOR_TEXT });
    moveDown(ctx, LINE_HEIGHT_LABEL);
  });
}

function drawCheckmark(ctx: Ctx, x: number, yBaseline: number) {
  const size = 6.5;
  ctx.page.drawLine({ start: { x, y: yBaseline + size * 0.35 }, end: { x: x + size * 0.38, y: yBaseline }, thickness: 1.4, color: COLOR_ACCENT });
  ctx.page.drawLine({ start: { x: x + size * 0.38, y: yBaseline }, end: { x: x + size, y: yBaseline + size * 0.75 }, thickness: 1.4, color: COLOR_ACCENT });
}

function drawChecklistItem(ctx: Ctx, text: string) {
  const textX = MARGIN_LEFT + 18;
  const lines = wrapText(sanitizeForPdf(text), ctx.font, FONT_SIZE_BODY, CONTENT_WIDTH - 18);
  ensureSpace(ctx, LINE_HEIGHT_BODY * lines.length);
  drawCheckmark(ctx, MARGIN_LEFT + 2, ctx.y + 2.5);
  lines.forEach((line, i) => {
    if (i > 0) ensureSpace(ctx, LINE_HEIGHT_BODY);
    ctx.page.drawText(line, { x: textX, y: ctx.y, size: FONT_SIZE_BODY, font: ctx.font, color: COLOR_TEXT });
    moveDown(ctx, LINE_HEIGHT_BODY);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers — one function per document section, matching the
// requested modular structure. Each is independent and only touches ctx.
// ─────────────────────────────────────────────────────────────────────────────

function drawHeader(ctx: Ctx, meta: { contractNumber: string; status: string; generatedDate: string }) {
  const businessText = 'ELI COFFEE EVENTS CAFE';
  ctx.page.drawText(businessText, {
    x: MARGIN_LEFT + (CONTENT_WIDTH - ctx.boldFont.widthOfTextAtSize(businessText, FONT_SIZE_SUBTITLE)) / 2,
    y: ctx.y, size: FONT_SIZE_SUBTITLE, font: ctx.boldFont, color: COLOR_ACCENT,
  });
  moveDown(ctx, FONT_SIZE_SUBTITLE + 12);

  const titleText = 'EVENT RESERVATION AGREEMENT';
  ctx.page.drawText(titleText, {
    x: MARGIN_LEFT + (CONTENT_WIDTH - ctx.boldFont.widthOfTextAtSize(titleText, FONT_SIZE_TITLE)) / 2,
    y: ctx.y, size: FONT_SIZE_TITLE, font: ctx.boldFont, color: COLOR_TEXT,
  });
  moveDown(ctx, FONT_SIZE_TITLE + 20);

  const cols: [string, string][] = [
    ['Contract No.', meta.contractNumber],
    ['Status', meta.status],
    ['Generated', meta.generatedDate],
  ];
  const colWidth = CONTENT_WIDTH / cols.length;
  cols.forEach(([label, value], i) => {
    const x = MARGIN_LEFT + colWidth * i;
    ctx.page.drawText(label.toUpperCase(), { x, y: ctx.y, size: FONT_SIZE_SMALL, font: ctx.boldFont, color: COLOR_MUTED });
    ctx.page.drawText(sanitizeForPdf(value), { x, y: ctx.y - 13, size: FONT_SIZE_LABEL, font: ctx.font, color: COLOR_TEXT });
  });
  moveDown(ctx, 36);
  drawDivider(ctx);
}

function drawAgreementIntroduction(ctx: Ctx, introText: string) {
  if (!introText) return;
  drawSectionHeading(ctx, 'Agreement');
  drawParagraph(ctx, introText);
  moveDown(ctx, 8);
}

function drawReservationSummary(ctx: Ctx, rows: [string, string][]) {
  drawSectionHeading(ctx, 'Reservation Summary');
  for (const [label, value] of rows) drawLabelValueRow(ctx, label, value);
  moveDown(ctx, 8);
}

// ── Price Breakdown / Additional Requests ──────────────────────────────────
// Mirrors js/contract_breakdown.js (the customer's preview and the admin's
// preview) — keep the rows and wording in sync with it. The Reservation
// Summary only carries the Total Amount; these two sections show how it was
// reached and list what the customer asked for beyond the package.
//
// Order of operations (same as the booking form): package (+ add-on) +
// additional guests − removed inclusions − discount = Subtotal; + service
// charge (on the subtotal); + offsite transport fee (never discounted, no
// service charge) = Total.
interface BreakdownRow {
  label: string;
  detail: string;
  amount: string;
  strong?: boolean;
}

interface BreakdownInput {
  packageName: string;
  packageAmount: number;
  addOnName: string;
  addOnAmount: number;
  additionalHeads: number;
  additionalHeadPrice: number;
  additionalHeadCharge: number;
  removedInclusions: { name: string; credit: number }[];
  discountLabel: string;
  discountPercent: number;
  discountAmount: number;
  subtotal: number;
  servicePercent: number;
  serviceAmount: number;
  transportFee: number;
  transportKm: number;
  total: number;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function buildBreakdownRows(v: BreakdownInput): BreakdownRow[] {
  const money = (n: number) => formatCurrency(round2(n));
  const minus = (n: number) => '-' + formatCurrency(round2(n));
  const rows: BreakdownRow[] = [];

  rows.push({ label: 'Package', detail: v.packageName, amount: money(v.packageAmount) });
  if (round2(v.addOnAmount) > 0) rows.push({ label: 'Add-on', detail: v.addOnName, amount: money(v.addOnAmount) });
  if (v.additionalHeads > 0) {
    rows.push({
      label: 'Additional Guests',
      detail: `${v.additionalHeads} x ${money(v.additionalHeadPrice)}`,
      amount: money(v.additionalHeadCharge),
    });
  }
  for (const inc of v.removedInclusions) {
    rows.push({ label: 'Removed Inclusion', detail: inc.name, amount: round2(inc.credit) > 0 ? minus(inc.credit) : money(0) });
  }
  if (round2(v.discountAmount) > 0) {
    const pct = v.discountPercent > 0 ? `${v.discountPercent}% off` : '';
    const detail = v.discountLabel ? (pct ? `${v.discountLabel} (${pct})` : v.discountLabel) : pct;
    rows.push({ label: 'Discount', detail, amount: minus(v.discountAmount) });
  }

  const hasServiceCharge = round2(v.serviceAmount) > 0;
  const hasTransport = round2(v.transportFee) > 0;
  if (hasServiceCharge || hasTransport) rows.push({ label: 'Subtotal', detail: '', amount: money(v.subtotal), strong: true });
  if (hasServiceCharge) rows.push({ label: 'Service Charge', detail: `${v.servicePercent}%`, amount: money(v.serviceAmount) });
  if (hasTransport) {
    rows.push({ label: 'Transport Fee', detail: v.transportKm > 0 ? `${v.transportKm} km` : '', amount: money(v.transportFee) });
  }
  rows.push({ label: 'Total Amount', detail: '', amount: money(v.total), strong: true });
  return rows;
}

// Custom requests are not priced when the contract is signed — the café
// quotes them afterwards and they are charged only if the customer accepts —
// so the contract lists them and says they sit outside the Total Amount.
function buildRequestRows(notes: string, customRequests: string[]): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const cleanNotes = String(notes || '').replace(/\s+/g, ' ').trim();
  if (cleanNotes) rows.push({ label: 'Special Requests', value: cleanNotes });
  if (customRequests.length) {
    rows.push({ label: 'Custom Requests', value: customRequests.join('; ') });
    rows.push({
      label: 'Custom Request Pricing',
      value: 'Quoted separately by the café and charged only if the Client accepts the quote. Not included in the Total Amount above.',
    });
  }
  return rows;
}

const BREAKDOWN_AMOUNT_WIDTH = 105;

function drawPriceBreakdown(ctx: Ctx, rows: BreakdownRow[]) {
  if (!rows.length) return;
  drawSectionHeading(ctx, 'Price Breakdown');
  const detailX = MARGIN_LEFT + LABEL_COLUMN_WIDTH;
  const detailWidth = CONTENT_WIDTH - LABEL_COLUMN_WIDTH - BREAKDOWN_AMOUNT_WIDTH;
  const rightEdge = MARGIN_LEFT + CONTENT_WIDTH;

  for (const row of rows) {
    // A rule above the Total, so the closing figure reads as the sum.
    if (row.label === 'Total Amount') {
      ensureSpace(ctx, LINE_HEIGHT_LABEL + 14);
      moveDown(ctx, 2);
      drawDivider(ctx);
    }
    const valueFont = row.strong ? ctx.boldFont : ctx.font;
    const detailLines = wrapText(sanitizeForPdf(row.detail || ''), valueFont, FONT_SIZE_LABEL, detailWidth);
    ensureSpace(ctx, LINE_HEIGHT_LABEL * detailLines.length);

    ctx.page.drawText(sanitizeForPdf(row.label), {
      x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.boldFont, color: row.strong ? COLOR_TEXT : COLOR_MUTED,
    });
    const safeAmount = sanitizeForPdf(row.amount);
    ctx.page.drawText(safeAmount, {
      x: rightEdge - valueFont.widthOfTextAtSize(safeAmount, FONT_SIZE_LABEL),
      y: ctx.y, size: FONT_SIZE_LABEL, font: valueFont, color: COLOR_TEXT,
    });
    detailLines.forEach((line, i) => {
      if (i > 0) ensureSpace(ctx, LINE_HEIGHT_LABEL);
      ctx.page.drawText(line, { x: detailX, y: ctx.y, size: FONT_SIZE_LABEL, font: valueFont, color: COLOR_TEXT });
      moveDown(ctx, LINE_HEIGHT_LABEL);
    });
  }
  moveDown(ctx, 8);
}

function drawAdditionalRequests(ctx: Ctx, rows: { label: string; value: string }[]) {
  if (!rows.length) return;
  drawSectionHeading(ctx, 'Additional Requests');
  for (const row of rows) drawLabelValueRow(ctx, row.label, row.value);
  moveDown(ctx, 8);
}

function drawSelectedPackage(ctx: Ctx, entries: { label: string; items: string[] }[]) {
  if (!entries.length) return;
  drawSectionHeading(ctx, 'Selected Package');
  for (const entry of entries) {
    if (entry.label) {
      ensureSpace(ctx, LINE_HEIGHT_LABEL + 4);
      ctx.page.drawText(sanitizeForPdf(entry.label), { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.boldFont, color: COLOR_TEXT });
      moveDown(ctx, LINE_HEIGHT_LABEL + 4);
    }
    for (const item of entry.items) drawChecklistItem(ctx, item);
    moveDown(ctx, 6);
  }
}

function drawVenueInformation(ctx: Ctx, entries: { label: string; items: string[] }[]) {
  if (!entries.length) return;
  drawSectionHeading(ctx, 'Venue Information');
  for (const entry of entries) {
    if (entry.label) drawLabelValueRow(ctx, 'Venue Name', entry.label);
    for (const item of entry.items) {
      const idx = item.indexOf(':');
      if (idx > -1) {
        drawLabelValueRow(ctx, item.slice(0, idx).trim(), item.slice(idx + 1).trim());
      } else {
        drawParagraph(ctx, item);
      }
    }
  }
  moveDown(ctx, 8);
}

function drawTermsAndConditions(ctx: Ctx, clauses: TemplateSection[]) {
  if (!clauses.length) return;
  drawSectionHeading(ctx, 'Terms and Conditions');
  clauses.forEach((clause, index) => {
    ensureSpace(ctx, LINE_HEIGHT_LABEL + 4);
    ctx.page.drawText(`${index + 1}. ${sanitizeForPdf(clause.heading)}`, { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.boldFont, color: COLOR_TEXT });
    moveDown(ctx, LINE_HEIGHT_LABEL + 2);
    drawParagraph(ctx, clause.bodyLines.join(' '));
    moveDown(ctx, 8);
  });
}

async function drawSignatureSection(
  ctx: Ctx,
  signatureBytes: Uint8Array,
  signerName: string,
  signedDateLabel: string,
  signedTimeLabel: string,
  acknowledgementText: string,
) {
  drawSectionHeading(ctx, 'Client Acknowledgement');
  drawParagraph(ctx, acknowledgementText);
  moveDown(ctx, 16);

  const sigImage = await ctx.pdfDoc.embedPng(signatureBytes);
  const sigMaxWidth = 200;
  const sigScale = Math.min(sigMaxWidth / sigImage.width, 1);
  const sigDims = sigImage.scale(sigScale);

  ensureSpace(ctx, sigDims.height + 78);
  ctx.page.drawImage(sigImage, { x: MARGIN_LEFT, y: ctx.y - sigDims.height, width: sigDims.width, height: sigDims.height });
  moveDown(ctx, sigDims.height + 8);

  ctx.page.drawLine({ start: { x: MARGIN_LEFT, y: ctx.y }, end: { x: MARGIN_LEFT + 220, y: ctx.y }, thickness: 0.75, color: COLOR_DIVIDER });
  moveDown(ctx, 15);

  ctx.page.drawText(sanitizeForPdf(signerName), { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_LABEL, font: ctx.boldFont, color: COLOR_TEXT });
  moveDown(ctx, 14);
  ctx.page.drawText('Electronically Signed', { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_SMALL, font: ctx.font, color: COLOR_MUTED });
  moveDown(ctx, 12);
  ctx.page.drawText(signedDateLabel, { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_SMALL, font: ctx.font, color: COLOR_MUTED });
  moveDown(ctx, 12);
  ctx.page.drawText(signedTimeLabel, { x: MARGIN_LEFT, y: ctx.y, size: FONT_SIZE_SMALL, font: ctx.font, color: COLOR_MUTED });
}

// Applied last, once total page count is known — every page gets the same
// footer with correct "Page X of N" numbering.
function drawFooters(pdfDoc: any, font: any) {
  const pages = pdfDoc.getPages();
  const total = pages.length;
  pages.forEach((page: any, i: number) => {
    const y = 34;
    page.drawLine({ start: { x: MARGIN_LEFT, y: y + 26 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: y + 26 }, thickness: 0.5, color: COLOR_DIVIDER });
    page.drawText('ELI Coffee Events Cafe Binangonan, Binangonan, Rizal', { x: MARGIN_LEFT, y: y + 12, size: FONT_SIZE_SMALL, font, color: COLOR_MUTED });
    page.drawText('This document was electronically generated.', { x: MARGIN_LEFT, y, size: FONT_SIZE_SMALL, font, color: COLOR_MUTED });
    const pageLabel = `Page ${i + 1} of ${total}`;
    const pageLabelWidth = font.widthOfTextAtSize(pageLabel, FONT_SIZE_SMALL);
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN_RIGHT - pageLabelWidth, y: y + 12, size: FONT_SIZE_SMALL, font, color: COLOR_MUTED });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

interface ContractData {
  reservationNumber: string;
  customerName: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  guestCount: string;
  packageName: string;
  totalPrice: string;
  packagePrice: number;
  extensionPrice: number;
  fallbackVenueLabel: string;
}

interface SummaryField {
  token: string;
  label: string;
  is_visible?: boolean;
}

interface StructuredClause {
  heading: string;
  body: string;
}

interface LockedClauses {
  acknowledgement?: StructuredClause;
  electronic_signature?: StructuredClause;
}

async function buildContractPdf(
  mergedTemplateBody: string,
  data: ContractData,
  mergeData: Record<string, string>,
  summaryFields: SummaryField[],
  templateClauses: StructuredClause[],
  lockedClauses: LockedClauses,
  signatureBytes: Uint8Array,
  signerName: string,
  timeZone: string,
  breakdownRows: BreakdownRow[],
  requestRows: { label: string; value: string }[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { pdfDoc, font, boldFont, page: null, y: 0 };
  newPage(ctx);

  const now = new Date();
  const generatedDateLabel = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric', timeZone: timeZone });
  const signedDateLabel = generatedDateLabel;
  // timeZoneName makes the zone explicit on the PDF (e.g. "GMT+8") so the
  // time is unambiguous wherever the contract is read.
  const signedTimeLabel = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: timeZone });

  drawHeader(ctx, { contractNumber: data.reservationNumber, status: 'SIGNED', generatedDate: generatedDateLabel });

  const { intro, sections } = parseTemplateSections(mergedTemplateBody);
  drawAgreementIntroduction(ctx, intro.join(' '));

  const venueSections = sections.filter((s) => classifySection(s.heading) === 'venue');
  const venueEntries = venueSections.flatMap((s) => s.bodyLines.map((line) => splitDetailLine(line)));
  const specificVenueName = venueEntries.find((e) => e.label)?.label || data.fallbackVenueLabel;

  // Layer 1 — Reservation Summary rows, driven by contract_field
  // (visibility/label/order); falls back to the fixed default list if the
  // table is empty/unreachable. "venue" is special-cased to the more
  // specific parsed venue name, matching the pre-existing behavior.
  const summaryValues: Record<string, string> = { ...mergeData, venue: specificVenueName };
  const fieldsToRender = summaryFields.length ? summaryFields : DEFAULT_SUMMARY_FIELDS;
  const summaryRows: [string, string][] = fieldsToRender
    .filter((f) => f.is_visible !== false)
    .map((f) => [f.label, summaryValues[f.token] ?? '']);
  drawReservationSummary(ctx, summaryRows);

  // Price Breakdown + Additional Requests — system sections, not template
  // text, so every contract shows its computation whatever the template says.
  drawPriceBreakdown(ctx, breakdownRows);
  drawAdditionalRequests(ctx, requestRows);

  const packageSections = sections.filter((s) => classifySection(s.heading) === 'package' && sectionMatchesPackage(s.heading, data.packageName));
  const packageEntries = applyLivePackagePricing(
    packageSections.flatMap((s) =>
      filterLinesForPackage(s.bodyLines, data.packageName).map((line) => splitDetailLine(line)),
    ),
    data.packagePrice,
    data.extensionPrice,
  );
  drawSelectedPackage(ctx, packageEntries);

  drawVenueInformation(ctx, venueEntries);

  // Layer 2/3 — Terms and Conditions. A template with structured clauses
  // (contract_template_clause rows) uses them directly, token-merged, and
  // always appends the global locked Electronic Signature clause at the end
  // (structured templates no longer carry it as free text). A template with
  // no structured clauses yet keeps rendering exactly as today — parsed
  // straight out of template_body, Electronic Signature included wherever
  // its free text already puts it — so nothing changes for it.
  let termsClauses: TemplateSection[];
  if (templateClauses.length) {
    termsClauses = templateClauses.map((c) => ({
      heading: c.heading,
      bodyLines: mergeTemplate(c.body, mergeData).split('\n').map((l) => l.trim()).filter(Boolean),
    }));
    const esClause = lockedClauses.electronic_signature || DEFAULT_ELECTRONIC_SIGNATURE_CLAUSE;
    termsClauses.push({
      heading: esClause.heading,
      bodyLines: mergeTemplate(esClause.body, mergeData).split('\n').map((l) => l.trim()).filter(Boolean),
    });
  } else {
    termsClauses = sections.filter((s) => classifySection(s.heading) === 'terms');
  }
  drawTermsAndConditions(ctx, termsClauses);

  // Client Acknowledgement paragraph was never template_body-derived for any
  // template (structured or not) — switching its source to contract_locked_clause
  // is a pure refactor, same text either way unless an admin edits it.
  const acknowledgementText = mergeTemplate(
    lockedClauses.acknowledgement?.body || DEFAULT_ACKNOWLEDGEMENT_BODY,
    mergeData,
  );
  await drawSignatureSection(ctx, signatureBytes, signerName, signedDateLabel, signedTimeLabel, acknowledgementText);

  drawFooters(pdfDoc, font);

  return pdfDoc.save();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ success: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.' }, 500);
  }

  let reservation_id: string | undefined;
  let signature_data_url: string | undefined;
  let signer_name: string | undefined;
  let signature_type: string | undefined;
  let agreement_view_method: string | undefined;
  let agreement_viewed_at: string | undefined;
  let time_zone = DEFAULT_TIME_ZONE;
  let id_image_data_url: unknown;
  let use_saved_id = false;
  let resign = false;
  let clientCustomRequests: string[] = [];

  try {
    const body = await req.json();
    id_image_data_url = body.id_image_data_url;
    use_saved_id = body.use_saved_id === true;
    resign = body.resign === true;
    // Titles of the custom requests the customer typed on the form. They are
    // only saved after the contract is made, so they arrive with this call;
    // text only, trimmed and capped. Used when the database has none yet.
    clientCustomRequests = Array.isArray(body.custom_requests)
      ? body.custom_requests.map((t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 10)
      : [];
    reservation_id = body.reservation_id;
    signature_data_url = body.signature_data_url;
    signer_name = String(body.signer_name || '').trim();
    signature_type = body.signature_type;
    agreement_view_method = body.agreement_view_method;
    agreement_viewed_at = body.agreement_viewed_at;
    time_zone = resolveTimeZone(body.time_zone);
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body.' }, 400);
  }

  // A re-sign (resign: true) reuses the agreement-view record from the
  // customer's original signing — the contract text they read is unchanged —
  // so those two fields are only required for a first submission.
  if (
    !reservation_id || !signature_data_url || !signer_name || !signature_type ||
    (!resign && (!agreement_view_method || !agreement_viewed_at))
  ) {
    return jsonResponse(
      {
        success: false,
        error: 'reservation_id, signature_data_url, signer_name, signature_type, agreement_view_method, ' +
          'and agreement_viewed_at are required.',
      },
      400,
    );
  }

  if (!['drawn', 'typed'].includes(signature_type)) {
    return jsonResponse({ success: false, error: 'signature_type must be "drawn" or "typed".' }, 400);
  }

  if (!resign && !['scrolled_inline', 'opened_full_view'].includes(agreement_view_method as string)) {
    return jsonResponse(
      { success: false, error: 'agreement_view_method must be "scrolled_inline" or "opened_full_view".' },
      400,
    );
  }

  if (!signature_data_url.startsWith('data:image/png;base64,')) {
    return jsonResponse({ success: false, error: 'signature_data_url must be a PNG data URL.' }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ID-vs-signature check (see supabase/functions/_shared/id_signature_check.ts).
  // The customer's ID comes from one of two places:
  //   * id_image_data_url — a photo the browser just sent (their first ID, or a
  //                         replacement); the browser also saves it to their
  //                         profile
  //   * use_saved_id      — the ID already saved on their profile (private
  //                         `customer-ids` bucket), read here with the service
  //                         role using the verified caller id
  // The signature on it is compared with the e-signature right after the
  // contract is created:
  //   match    -> contract verified
  //   no match -> contract stays pending, the customer is notified and can
  //               replace their ID or re-sign (resign: true, below)
  // With neither, the contract is created exactly as before (the legacy
  // verify-contract scan / manual review applies).
  const sentIdImage = id_image_data_url !== undefined && id_image_data_url !== null;
  const wantsIdCheck = sentIdImage || use_saved_id;
  let idImage = sentIdImage
    ? parseDataUrl(id_image_data_url, ['image/jpeg', 'image/png', 'image/webp'], MAX_ID_BYTES)
    : null;
  const sigImage = wantsIdCheck
    ? parseDataUrl(signature_data_url, ['image/png'], MAX_SIGNATURE_BYTES)
    : null;
  if (wantsIdCheck && !sigImage) {
    return jsonResponse({ success: false, error: 'A valid signature image is required.' }, 400);
  }
  if (sentIdImage && !idImage) {
    return jsonResponse({ success: false, error: 'A valid ID image is required.' }, 400);
  }
  if (resign && !wantsIdCheck) {
    return jsonResponse({ success: false, error: 'Re-signing requires your ID.' }, 400);
  }

  // The ID check spends vision quota and re-signing replaces a contract, so
  // both need a real signed-in user who owns the reservation (checked below).
  let callerId: string | null = null;
  if (wantsIdCheck) {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return jsonResponse({ success: false, error: 'Please sign in to continue.' }, 401);
    }
    callerId = userData.user.id;
  }

  // No photo in the request -> use the ID saved on the caller's profile.
  if (use_saved_id && !idImage) {
    try {
      idImage = await loadSavedIdForUser(supabase, callerId!);
    } catch (loadError) {
      console.error('saved id load failed', { error: String((loadError as Error).message) });
    }
    if (!idImage) {
      return jsonResponse(
        {
          success: false,
          code: 'no_saved_id',
          error: 'We couldn\u2019t find a valid ID saved on your profile. Please upload it on My Profile and try again.',
        },
        409,
      );
    }
  }

  try {
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .select(`
        reservation_id, reservation_number, user_id, event_type, event_date, event_time, guest_count, location_type,
        venue_location, contact_name, contact_email, contact_phone, total_price,
        service_charge_percent, service_charge_amount,
        discount_percent, discount_amount, discount_label,
        additional_heads, additional_head_price, additional_head_charge,
        inclusion_adjustment, inclusion_snapshot,
        transport_fee, transport_distance_km,
        special_requests,
        package_id, package:package_id ( package_name, extension_price ),
        add_on:add_on_id ( package_name, price )
      `)
      .eq('reservation_id', reservation_id)
      .maybeSingle();

    if (reservationError) throw reservationError;
    if (!reservation) {
      return jsonResponse({ success: false, error: `No reservation found for reservation_id ${reservation_id}.` }, 404);
    }

    if (wantsIdCheck && reservation.user_id !== callerId) {
      return jsonResponse({ success: false, error: `No reservation found for reservation_id ${reservation_id}.` }, 404);
    }

    // ── Re-sign: only for a contract still pending after a failed ID check ──
    if (resign) {
      const { data: pending } = await supabase
        .from('reservation_contracts')
        .select('review_status, id_check_status, id_check_attempts')
        .eq('reservation_id', reservation.reservation_id)
        .maybeSingle();

      if (!pending) {
        return jsonResponse({ success: false, error: 'No contract found for this reservation.' }, 404);
      }
      if (pending.review_status !== 'pending_review') {
        return jsonResponse({ success: false, error: 'This contract has already been reviewed.' }, 409);
      }
      const retryable = [...RETRYABLE_VERDICTS, 'error'] as string[];
      if (!pending.id_check_status || !retryable.includes(pending.id_check_status)) {
        return jsonResponse({ success: false, error: 'This contract doesn\u2019t need to be signed again.' }, 409);
      }
      if (Number(pending.id_check_attempts ?? 0) >= MAX_ID_CHECK_ATTEMPTS) {
        return jsonResponse(
          {
            success: false,
            error: 'You\u2019ve used all automatic checks. Our team will review your contract by hand.',
            attempts_left: 0,
          },
          429,
        );
      }

      // Printed name + agreement-view record carry over from the original
      // signing (what the customer actually read and signed as).
      const { data: priorSignature } = await supabase
        .from('contract_signatures')
        .select('signer_name, agreement_view_method, agreement_viewed_at')
        .eq('reservation_id', reservation.reservation_id)
        .eq('signer_role', 'customer')
        .order('signed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!priorSignature?.agreement_view_method || !priorSignature?.agreement_viewed_at) {
        return jsonResponse(
          { success: false, error: 'The original signing record is incomplete. Please contact us.' },
          409,
        );
      }
      signer_name = priorSignature.signer_name || signer_name;
      agreement_view_method = priorSignature.agreement_view_method;
      agreement_viewed_at = priorSignature.agreement_viewed_at;

      // Compare FIRST. A signature that still doesn't match never replaces
      // anything, so no PDF is built for it.
      let verdict: Verdict;
      try {
        verdict = await compareIdAndSignature(idImage!, sigImage!);
      } catch (checkError) {
        console.error('resign id check failed', { reservation_id, error: String((checkError as Error).message) });
        return jsonResponse(
          { success: false, error: 'We could not check your ID right now. Please try again.' },
          502,
        );
      }
      if (verdict !== 'match') {
        const result = await applyIdCheckResult(supabase, {
          reservationId: reservation.reservation_id,
          reservationNumber: reservation.reservation_number,
          userId: reservation.user_id,
          verdict,
          notify: false,
        });
        return jsonResponse({
          success: true,
          verdict,
          verified: false,
          attempts_left: result.attemptsLeft,
        });
      }
    }

    // First submission: start the comparison now so it runs while the PDF is
    // being built. A service failure is captured (not thrown) and recorded
    // after the contract exists.
    const initialCheck: Promise<{ verdict?: Verdict; failed?: boolean }> | null =
      wantsIdCheck && !resign
        ? compareIdAndSignature(idImage!, sigImage!).then(
          (verdict) => ({ verdict }),
          (checkError) => {
            console.error('id check failed', { reservation_id, error: String((checkError as Error).message) });
            return { failed: true };
          },
        )
        : null;

    const { data: template } = await supabase
      .from('contract_templates')
      .select('template_id, version_no, contract_type, template_body')
      .eq('package_id', reservation.package_id)
      .eq('is_active', true)
      .order('version_no', { ascending: false })
      .limit(1)
      .maybeSingle();

    // NIL_UUID: contract_template_clause.template_id is `not null` — when no
    // active template exists, query a UUID that can never match a real row
    // instead of passing null/empty-string (which PostgREST would reject as
    // an invalid uuid), so this always safely resolves to zero rows.
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';

    const [
      { data: templateClauseRows },
      { data: lockedClauseRows },
      { data: summaryFieldRows },
      { data: paymentRulesRow },
      { data: downPaymentTypeRow },
      { data: termsRow },
      { data: privacyRow },
    ] = await Promise.all([
      supabase.from('contract_template_clause').select('heading, body, sort_order')
        .eq('template_id', template?.template_id || NIL_UUID).order('sort_order', { ascending: true }),
      supabase.from('contract_locked_clause').select('key, heading, body'),
      supabase.from('contract_field').select('token, label, is_visible, sort_order')
        .eq('section', 'summary').order('sort_order', { ascending: true }),
      supabase.from('system_settings').select('setting_value').eq('setting_key', 'payment_rules').maybeSingle(),
      supabase.from('payment_type').select('percent_of_total').eq('code', 'down_payment').maybeSingle(),
      supabase.from('system_settings').select('setting_value').eq('setting_key', 'terms_and_conditions').maybeSingle(),
      supabase.from('system_settings').select('setting_value').eq('setting_key', 'data_privacy_policy').maybeSingle(),
    ]);

    const venueLabel = reservation.location_type === 'offsite'
      ? (reservation.venue_location || 'Customer-provided venue')
      : 'ELI Coffee Events Cafe Binangonan (Onsite)';

    const reservationNumber = reservation.reservation_number as string;
    const signedAtLabel = new Date().toLocaleString('en-PH', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      timeZoneName: 'short', timeZone: time_zone,
    });

    const packageName = reservation.package?.package_name || 'Selected Package';

    // Fee/terms tokens — same sources the admin-facing config pages read/write
    // (payment_rules for cancellation/reschedule fees, payment_type for the
    // down-payment percent, system_settings for the Terms & Legal tab text).
    let paymentRules: Record<string, unknown> = {};
    try { paymentRules = paymentRulesRow?.setting_value ? JSON.parse(paymentRulesRow.setting_value) : {}; } catch { /* use default */ }
    const isOffsite = reservation.location_type === 'offsite';
    const cancellationFee = Number(
      paymentRules[isOffsite ? 'cancellation_fee_offsite' : 'cancellation_fee_onsite'] ?? (isOffsite ? 2000 : 500),
    );
    const rescheduleFee = Number(paymentRules['reschedule_fee'] ?? 3000);
    const depositPercent = downPaymentTypeRow?.percent_of_total ?? 50;

    let termsBody = '';
    try { termsBody = termsRow?.setting_value ? (JSON.parse(termsRow.setting_value).body || '') : ''; } catch { /* leave blank */ }
    let privacyBody = '';
    try { privacyBody = privacyRow?.setting_value ? (JSON.parse(privacyRow.setting_value).body || '') : ''; } catch { /* leave blank */ }

    // Price Breakdown. Everything comes from what was frozen on the
    // reservation at booking, so a later price change never alters it. The
    // package line is what remains of the subtotal after the itemised lines
    // (add-on, additional guests, removed inclusions, discount), so the rows
    // always add up to the Total Amount even for menu-priced packages.
    const totalAmount = Number(reservation.total_price || 0);
    const transportFeeAmount = (reservation.transport_distance_km != null || Number(reservation.transport_fee) > 0)
      ? Number(reservation.transport_fee || 0) : 0;
    const serviceChargeAmount = Number(reservation.service_charge_amount || 0);
    const subtotalAmount = round2(totalAmount - transportFeeAmount - serviceChargeAmount);
    const discountAmountValue = reservation.discount_amount != null ? Number(reservation.discount_amount) : 0;
    const inclusionCreditValue = Number(reservation.inclusion_adjustment) > 0 ? Number(reservation.inclusion_adjustment) : 0;
    const additionalHeadsValue = Number(reservation.additional_heads) > 0 ? Number(reservation.additional_heads) : 0;
    const additionalHeadChargeValue = additionalHeadsValue > 0 ? Number(reservation.additional_head_charge || 0) : 0;
    const packagePlusAddOn = round2(subtotalAmount + discountAmountValue + inclusionCreditValue - additionalHeadChargeValue);
    const addOnPrice = Number(reservation.add_on?.price || 0);
    const addOnAmountValue = reservation.add_on && addOnPrice > 0 && addOnPrice < packagePlusAddOn ? addOnPrice : 0;
    const removedInclusionRows = Array.isArray(reservation.inclusion_snapshot)
      ? reservation.inclusion_snapshot
          .filter((i: { removed?: boolean }) => i?.removed)
          .map((i: { name?: string; credit?: number }) => ({ name: String(i.name || ''), credit: Number(i.credit || 0) }))
      : [];

    // The package's own price as frozen on this booking (what remains of the
    // subtotal after add-on, guests, removed inclusions and discount) and its
    // per-hour extension rate. The Selected Package lines read these, so a
    // price edited on the Packages page shows up without retyping the template.
    const packageBasePrice = round2(packagePlusAddOn - addOnAmountValue);
    const extensionRate = Number(reservation.package?.extension_price || 0);

    const mergeData: Record<string, string> = {
      customer_name: reservation.contact_name || '',
      package_name: packageName,
      event_type: reservation.event_type || 'TBD',
      event_date: formatDate(reservation.event_date),
      event_time: reservation.event_time || 'TBD',
      venue: venueLabel,
      reservation_number: reservationNumber,
      total_price: formatCurrency(reservation.total_price),
      package_price: packageBasePrice > 0 ? formatCurrency(packageBasePrice) : '',
      extension_price: extensionRate > 0 ? formatCurrency(extensionRate) : '',
      // Snapshotted on the reservation at booking time (unlike deposit_percent/
      // cancellation_fee below, which read live config) — the applied rate
      // must freeze at the moment of booking, not reflect today's settings.
      service_charge_percent: String(reservation.service_charge_percent ?? 0),
      service_charge_amount: formatCurrency(reservation.service_charge_amount || 0),
      // Same frozen-at-booking treatment — blank (never a live-recomputed
      // value) when this booking had no discount applied.
      discount_percent: reservation.discount_percent != null ? String(reservation.discount_percent) : '',
      discount_amount: reservation.discount_amount != null ? formatCurrency(reservation.discount_amount) : '',
      discount_label: reservation.discount_label || '',
      // Same frozen-at-booking, blank-when-not-applicable treatment as
      // discount_* above — additional_heads is 0 (not null) when unused, so
      // check for > 0 rather than != null.
      additional_heads: reservation.additional_heads > 0 ? String(reservation.additional_heads) : '',
      additional_head_price: reservation.additional_heads > 0 ? formatCurrency(reservation.additional_head_price || 0) : '',
      additional_head_charge: reservation.additional_heads > 0 ? formatCurrency(reservation.additional_head_charge || 0) : '',
      // Offsite transport fee: blank unless a distance-based fee was priced
      // for this booking (onsite, or the fee was off at booking time).
      transport_fee: reservation.transport_distance_km != null ? formatCurrency(reservation.transport_fee || 0) : '',
      transport_distance_km: reservation.transport_distance_km != null ? String(Number(reservation.transport_distance_km)) : '',
      // Customizable inclusions: blank unless the customer removed something,
      // so a template line using these only prints for bookings that need it.
      inclusion_adjustment: Number(reservation.inclusion_adjustment) > 0 ? formatCurrency(reservation.inclusion_adjustment) : '',
      removed_inclusions: Array.isArray(reservation.inclusion_snapshot)
        ? reservation.inclusion_snapshot.filter((i: { removed?: boolean }) => i?.removed).map((i: { name?: string }) => i.name).join(', ')
        : '',
      guest_count: String(reservation.guest_count || ''),
      contact_email: reservation.contact_email || '',
      contact_phone: reservation.contact_phone || '',
      signed_date: signedAtLabel,
      reschedule_fee: formatCurrency(rescheduleFee),
      cancellation_fee: formatCurrency(cancellationFee),
      deposit_percent: String(depositPercent),
      terms_and_conditions: termsBody,
      data_privacy_policy: privacyBody,
    };

    const templateBody = template?.template_body || DEFAULT_TEMPLATE_BODY;
    const mergedBody = sanitizeForPdf(mergeTemplate(templateBody, mergeData));

    const lockedClauses: LockedClauses = {};
    (lockedClauseRows || []).forEach((c) => {
      if (c.key === 'acknowledgement' || c.key === 'electronic_signature') {
        lockedClauses[c.key as 'acknowledgement' | 'electronic_signature'] = { heading: c.heading, body: c.body };
      }
    });

    const breakdownRows: BreakdownRow[] = subtotalAmount > 0
      ? buildBreakdownRows({
          packageName,
          packageAmount: packagePlusAddOn - addOnAmountValue,
          addOnName: reservation.add_on?.package_name || '',
          addOnAmount: addOnAmountValue,
          additionalHeads: additionalHeadsValue,
          additionalHeadPrice: Number(reservation.additional_head_price || 0),
          additionalHeadCharge: additionalHeadChargeValue,
          removedInclusions: removedInclusionRows,
          discountLabel: reservation.discount_label || '',
          discountPercent: reservation.discount_percent != null ? Number(reservation.discount_percent) : 0,
          discountAmount: discountAmountValue,
          subtotal: subtotalAmount,
          servicePercent: Number(reservation.service_charge_percent || 0),
          serviceAmount: serviceChargeAmount,
          transportFee: transportFeeAmount,
          transportKm: reservation.transport_distance_km != null ? Number(reservation.transport_distance_km) : 0,
          total: totalAmount,
        })
      : [];

    // Additional Requests: the customer's notes plus any custom requests.
    // Custom requests are read from the database when it has them (a re-sign
    // happens after they were saved); on a first signing they are not saved
    // yet, so the titles sent with the request are used. Best-effort — a
    // failure here must never block the contract.
    let customRequestTitles: string[] = clientCustomRequests;
    try {
      const { data: customRequestRows } = await supabase
        .from('reservation_custom_requests')
        .select('title')
        .eq('reservation_id', reservation.reservation_id)
        .neq('status', 'declined')
        .order('created_at', { ascending: true });
      if (customRequestRows?.length) {
        customRequestTitles = customRequestRows.map((r: { title: string }) => String(r.title || '').trim()).filter(Boolean);
      }
    } catch (customRequestError) {
      console.error('custom request lookup failed', { error: String((customRequestError as Error).message) });
    }
    const requestRows = buildRequestRows(reservation.special_requests || '', customRequestTitles);

    const signatureBytes = base64ToBytes(signature_data_url);

    const { url: signatureUrl } = await uploadToCloudinary(signatureBytes, {
      filename: `signature-${reservationNumber}${resign ? `-resign-${Date.now()}` : ''}.png`,
      folder: 'contracts/signatures',
      resourceType: 'image',
    });

    const pdfBytes = await buildContractPdf(
      mergedBody,
      {
        reservationNumber,
        customerName: mergeData.customer_name || 'Customer',
        eventType: mergeData.event_type,
        eventDate: mergeData.event_date,
        eventTime: mergeData.event_time,
        guestCount: mergeData.guest_count,
        packageName,
        totalPrice: mergeData.total_price,
        packagePrice: packageBasePrice,
        extensionPrice: extensionRate,
        fallbackVenueLabel: venueLabel,
      },
      mergeData,
      summaryFieldRows || [],
      templateClauseRows || [],
      lockedClauses,
      signatureBytes,
      sanitizeForPdf(signer_name),
      time_zone,
      breakdownRows,
      requestRows,
    );

    // resourceType 'image' (not 'raw') — required so Cloudinary's pg_N page
    // transformation and JPEG conversion (used by verify-contract's OCR scan)
    // actually work; raw-uploaded assets never go through Cloudinary's image
    // derivation pipeline. `pages` is Cloudinary's own count of pages in the
    // uploaded PDF, snapshotted below so verify-contract can scan the last
    // page (where drawSignatureSection always places the signature) instead
    // of assuming it's on page 1.
    const { url: contractUrl, pages: contractPageCount } = await uploadToCloudinary(pdfBytes, {
      filename: `contract-${reservationNumber}${resign ? `-resign-${Date.now()}` : ''}.pdf`,
      folder: 'contracts',
      resourceType: 'image',
    });

    // ── Re-sign: swap the new PDF + signature into the pending contract ─────
    if (resign) {
      const { error: replaceError } = await supabase.rpc('replace_pending_contract', {
        p_reservation_id: reservation.reservation_id,
        p_contract_url: contractUrl,
        p_rendered_body: mergedBody,
        p_page_count: contractPageCount ?? null,
      });
      if (replaceError) throw replaceError;

      // Keep the earlier signature rows as history; readers take the latest.
      const { error: resignSignatureError } = await supabase
        .from('contract_signatures')
        .insert({
          reservation_id: reservation.reservation_id,
          signer_role: 'customer',
          signer_name,
          signature_type,
          signature_image_url: signatureUrl,
          agreement_view_method,
          agreement_viewed_at,
        });
      if (resignSignatureError) throw resignSignatureError;

      const result = await applyIdCheckResult(supabase, {
        reservationId: reservation.reservation_id,
        reservationNumber: reservationNumber,
        userId: reservation.user_id,
        verdict: 'match',
        notify: false,
      });

      return jsonResponse({
        success: true,
        verdict: 'match',
        verified: result.verified,
        attempts_left: result.attemptsLeft,
        contract_url: contractUrl,
        reservation_number: reservationNumber,
      });
    }

    const { data: existingContract, error: existingContractError } = await supabase
      .from('reservation_contracts')
      .select('reservation_id')
      .eq('reservation_id', reservation.reservation_id)
      .maybeSingle();

    if (existingContractError) throw existingContractError;

    if (existingContract) {
      return jsonResponse(
        { success: false, error: 'A signed contract has already been submitted for this reservation.' },
        409,
      );
    }

    const contractPayload = {
      reservation_id: reservation.reservation_id,
      template_id: template?.template_id || null,
      template_version_no: template?.version_no || null,
      contract_type: template?.contract_type || 'package_contract',
      contract_url: contractUrl,
      page_count: contractPageCount ?? null,
      rendered_body: mergedBody,
      review_status: 'pending_review',
      verified_date: null,
      review_notes: null,
      reviewed_at: null,
      // 'checking' tells verify-contract (fired by the insert trigger) to stand
      // aside: approval for this contract comes from the ID comparison below,
      // not from "is there handwriting on the page".
      id_check_status: initialCheck ? 'checking' : null,
    };

    const { error: contractInsertError } = await supabase
      .from('reservation_contracts')
      .insert(contractPayload);

    if (contractInsertError) throw contractInsertError;

    const { error: signatureInsertError } = await supabase
      .from('contract_signatures')
      .insert({
        reservation_id: reservation.reservation_id,
        signer_role: 'customer',
        signer_name,
        signature_type,
        signature_image_url: signatureUrl,
        agreement_view_method,
        agreement_viewed_at,
      });

    if (signatureInsertError) throw signatureInsertError;

    // ── ID check outcome ────────────────────────────────────────────────────
    // The booking and contract already exist either way. Match -> verified;
    // anything else -> stays pending and the customer is notified.
    let idCheck: Record<string, unknown> | undefined;
    if (initialCheck) {
      const outcome = await initialCheck;
      if (outcome.verdict) {
        const result = await applyIdCheckResult(supabase, {
          reservationId: reservation.reservation_id,
          reservationNumber,
          userId: reservation.user_id,
          verdict: outcome.verdict,
          notify: true,
        });
        idCheck = {
          verdict: outcome.verdict,
          verified: result.verified,
          attempts_left: result.attemptsLeft,
        };
      } else {
        // Service trouble, not a mismatch: a person reviews it; the customer
        // isn't told their signature failed.
        await recordIdCheckError(supabase, reservation.reservation_id);
        idCheck = { verdict: 'error', verified: false };
      }
    }

    return jsonResponse({
      success: true,
      contract_url: contractUrl,
      reservation_number: reservationNumber,
      ...(idCheck ? { id_check: idCheck } : {}),
    });
  } catch (error) {
    console.error('generate-signed-contract error', { reservation_id, error: String((error as Error).message) });
    return jsonResponse({ success: false, error: String((error as Error).message) }, 500);
  }
});