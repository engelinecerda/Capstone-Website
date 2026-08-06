import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb, degrees } from 'https://esm.sh/pdf-lib@1.17.1';

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
const DEFAULT_SUMMARY_FIELDS: { token: string; label: string }[] = [
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
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { pdfDoc, font, boldFont, page: null, y: 0 };
  newPage(ctx);

  const now = new Date();
  const generatedDateLabel = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const signedDateLabel = generatedDateLabel;
  const signedTimeLabel = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });

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

  const packageSections = sections.filter((s) => classifySection(s.heading) === 'package' && sectionMatchesPackage(s.heading, data.packageName));
  const packageEntries = packageSections.flatMap((s) =>
    filterLinesForPackage(s.bodyLines, data.packageName).map((line) => splitDetailLine(line)),
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

  try {
    const body = await req.json();
    reservation_id = body.reservation_id;
    signature_data_url = body.signature_data_url;
    signer_name = String(body.signer_name || '').trim();
    signature_type = body.signature_type;
    agreement_view_method = body.agreement_view_method;
    agreement_viewed_at = body.agreement_viewed_at;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body.' }, 400);
  }

  if (
    !reservation_id || !signature_data_url || !signer_name || !signature_type ||
    !agreement_view_method || !agreement_viewed_at
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

  if (!['scrolled_inline', 'opened_full_view'].includes(agreement_view_method)) {
    return jsonResponse(
      { success: false, error: 'agreement_view_method must be "scrolled_inline" or "opened_full_view".' },
      400,
    );
  }

  if (!signature_data_url.startsWith('data:image/png;base64,')) {
    return jsonResponse({ success: false, error: 'signature_data_url must be a PNG data URL.' }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .select(`
        reservation_id, reservation_number, event_type, event_date, event_time, guest_count, location_type,
        venue_location, contact_name, contact_email, contact_phone, total_price,
        service_charge_percent, service_charge_amount,
        package_id, package:package_id ( package_name )
      `)
      .eq('reservation_id', reservation_id)
      .maybeSingle();

    if (reservationError) throw reservationError;
    if (!reservation) {
      return jsonResponse({ success: false, error: `No reservation found for reservation_id ${reservation_id}.` }, 404);
    }

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

    const mergeData: Record<string, string> = {
      customer_name: reservation.contact_name || '',
      package_name: packageName,
      event_type: reservation.event_type || 'TBD',
      event_date: formatDate(reservation.event_date),
      event_time: reservation.event_time || 'TBD',
      venue: venueLabel,
      reservation_number: reservationNumber,
      total_price: formatCurrency(reservation.total_price),
      // Snapshotted on the reservation at booking time (unlike deposit_percent/
      // cancellation_fee below, which read live config) — the applied rate
      // must freeze at the moment of booking, not reflect today's settings.
      service_charge_percent: String(reservation.service_charge_percent ?? 0),
      service_charge_amount: formatCurrency(reservation.service_charge_amount || 0),
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

    const signatureBytes = base64ToBytes(signature_data_url);

    const { url: signatureUrl } = await uploadToCloudinary(signatureBytes, {
      filename: `signature-${reservationNumber}.png`,
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
        fallbackVenueLabel: venueLabel,
      },
      mergeData,
      summaryFieldRows || [],
      templateClauseRows || [],
      lockedClauses,
      signatureBytes,
      sanitizeForPdf(signer_name),
    );

    // resourceType 'image' (not 'raw') — required so Cloudinary's pg_N page
    // transformation and JPEG conversion (used by verify-contract's OCR scan)
    // actually work; raw-uploaded assets never go through Cloudinary's image
    // derivation pipeline. `pages` is Cloudinary's own count of pages in the
    // uploaded PDF, snapshotted below so verify-contract can scan the last
    // page (where drawSignatureSection always places the signature) instead
    // of assuming it's on page 1.
    const { url: contractUrl, pages: contractPageCount } = await uploadToCloudinary(pdfBytes, {
      filename: `contract-${reservationNumber}.pdf`,
      folder: 'contracts',
      resourceType: 'image',
    });

    const { error: contractInsertError } = await supabase
      .from('reservation_contracts')
      .insert({
        reservation_id: reservation.reservation_id,
        template_id: template?.template_id || null,
        template_version_no: template?.version_no || null,
        contract_type: template?.contract_type || 'package_contract',
        contract_url: contractUrl,
        page_count: contractPageCount ?? null,
        rendered_body: mergedBody,
        review_status: 'pending_review',
        review_notes: null,
        reviewed_at: null,
        verified_date: null,
      });

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

    return jsonResponse({
      success: true,
      contract_url: contractUrl,
      reservation_number: reservationNumber,
    });
  } catch (error) {
    console.error('generate-signed-contract error', { reservation_id, error: String((error as Error).message) });
    return jsonResponse({ success: false, error: String((error as Error).message) }, 500);
  }
});
