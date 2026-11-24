// Deterministic receipt-vs-payment comparison used by `validate-receipt`.
//
// The vision model only READS the receipt (see validate-receipt/index.ts);
// every pass / mismatch decision is made here, in plain code, against values
// the server loaded itself. Nothing in this file touches the network or the
// database, so it can be unit tested (receipt_compare_test.ts) and so a
// model hallucination can never "approve" a receipt by itself.
//
// Three outcomes per field:
//   match    - the receipt agrees with the expected value
//   mismatch - the receipt is CONFIDENTLY different (this is what blocks)
//   unclear  - unreadable / ambiguous (never blocks on its own; goes to
//              manual review instead, so a blurry photo or a model outage
//              can't lock out an honest customer)
//   skipped  - nothing to compare for this payment method

export type FieldStatus = 'match' | 'mismatch' | 'unclear' | 'skipped';
export type Verdict = 'pass' | 'mismatch' | 'needs_review';

export interface FieldResult {
  status: FieldStatus;
  message: string;
}

export interface Expected {
  amount: number;
  reference: string;
  paymentDate: string; // YYYY-MM-DD, as typed by the customer
  methodLabel: string;
  accountName: string;
  aliases: string[];
  accountNumber: string | null;
  phoneNumber: string | null;
}

export interface Extracted {
  amount: number | null;
  referenceNumber: string | null;
  paymentDate: string | null;
  methodDetected: string | null;
  receiverName: string | null;
  receiverAccountTail: string | null;
  transactionStatus: string | null; // 'success' | 'failed' | 'pending' | 'unknown'
}

export interface Comparison {
  verdict: Verdict;
  fields: Record<string, FieldResult>;
  reasons: string[];
}

// ── helpers ────────────────────────────────────────────────────────────────

// Receipt text comes from an untrusted image: strip anything that isn't a
// plain name character and cap the length before it is ever echoed back to a
// customer or stored. The browser must still render it with textContent.
export function sanitizeForDisplay(value: string | null | undefined, max = 40): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .,'*\-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeReference(value: string | null | undefined): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'sir', 'maam', 'madam', 'dr', 'engr', 'atty']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

export function tokenizeName(value: string | null | undefined): string[] {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[•●∗✱＊]/g, '*') // mask glyphs -> the ASCII wildcard
    .replace(/[^a-z0-9*\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t) && !SUFFIXES.has(t));
}

type TokenMatch = 'none' | 'weak' | 'strong';

// How well one receipt token matches one expected-name token.
//   strong - a whole word (or a masked word with 2+ visible letters)
//   weak   - only an initial ("D.")
function matchToken(receiptToken: string, expectedToken: string): TokenMatch {
  if (receiptToken.includes('*')) {
    const first = receiptToken.indexOf('*');
    const last = receiptToken.lastIndexOf('*');
    const prefix = receiptToken.slice(0, first);
    const suffix = receiptToken.slice(last + 1);
    const visible = prefix.length + suffix.length;
    if (visible === 0) return 'none';
    const fits = expectedToken.startsWith(prefix) &&
      expectedToken.endsWith(suffix) &&
      expectedToken.length >= visible;
    if (!fits) return 'none';
    return visible >= 2 ? 'strong' : 'weak';
  }
  if (receiptToken.length === 1) {
    return expectedToken.startsWith(receiptToken) ? 'weak' : 'none';
  }
  if (receiptToken === expectedToken) return receiptToken.length >= 3 ? 'strong' : 'weak';
  // Tolerate a single OCR slip on longer words only.
  if (
    receiptToken.length >= 7 && expectedToken.length >= 7 &&
    editDistance(receiptToken, expectedToken) <= 1
  ) {
    return 'strong';
  }
  return 'none';
}

function compareNameToCandidate(receiptTokens: string[], expectedName: string): FieldStatus {
  const expectedTokens = tokenizeName(expectedName);
  if (!expectedTokens.length || !receiptTokens.length) return 'unclear';

  const used = new Set<number>();
  let strong = 0;
  let unmatchedReal = 0;

  for (const rt of receiptTokens) {
    let bestIdx = -1;
    let best: TokenMatch = 'none';
    for (let idx = 0; idx < expectedTokens.length; idx++) {
      if (used.has(idx)) continue;
      const m = matchToken(rt, expectedTokens[idx]);
      if (m === 'strong') {
        best = 'strong';
        bestIdx = idx;
        break;
      }
      if (m === 'weak' && best === 'none') {
        best = 'weak';
        bestIdx = idx;
      }
    }
    if (best !== 'none') {
      used.add(bestIdx);
      if (best === 'strong') strong++;
    } else if (rt.replace(/\*/g, '').length >= 2 || rt.includes('*')) {
      // A real word (or masked word) that matches nothing in the expected
      // name. A lone unmatched initial is tolerated (middle initials).
      unmatchedReal++;
    }
  }

  if (unmatchedReal > 0) return 'mismatch';
  if (strong === 0) return 'unclear';
  return 'match';
}

export function compareReceiverName(
  receiverName: string | null,
  accountName: string,
  aliases: string[],
): FieldStatus {
  // A token that is only mask characters carries no information.
  const receiptTokens = tokenizeName(receiverName).filter((t) => t.replace(/\*/g, '') !== '');
  if (!receiptTokens.length) return 'unclear';
  const candidates = [accountName, ...aliases].filter((c) => c && c.trim());
  const results = candidates.map((c) => compareNameToCandidate(receiptTokens, c));
  if (results.includes('match')) return 'match';
  if (results.includes('unclear')) return 'unclear';
  return 'mismatch';
}

function digitsOnly(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

// Receipts mask the recipient number (e.g. "+63 917 *** 4567"), so only the
// last few digits are comparable. Needs at least 3 visible digits to count.
export function compareAccountTail(
  receiptTail: string | null,
  accountNumber: string | null,
  phoneNumber: string | null,
): 'match' | 'mismatch' | 'unknown' {
  const tail = digitsOnly(receiptTail);
  if (tail.length < 3) return 'unknown';
  const known = [digitsOnly(accountNumber), digitsOnly(phoneNumber)].filter((d) => d.length >= 3);
  if (!known.length) return 'unknown';
  return known.some((d) => d.endsWith(tail) || (tail.length > 4 && d.endsWith(tail.slice(-4))))
    ? 'match'
    : 'mismatch';
}

const KNOWN_PROVIDERS = ['gcash', 'maya', 'bpi'];

function providerOf(text: string | null | undefined): string | null {
  const t = String(text ?? '').toLowerCase().replace(/[\s_-]/g, '').replace('paymaya', 'maya');
  return KNOWN_PROVIDERS.find((p) => t.includes(p)) ?? null;
}

function parseDateKey(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  // Receipts are printed in Philippine time; avoid shifting the day by UTC.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayDiff(a: string, b: string): number {
  const toDays = (k: string) => Math.round(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 86_400_000);
  return Math.abs(toDays(a) - toDays(b));
}

const peso = (n: number) => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── main entry point ───────────────────────────────────────────────────────

export function compareReceipt(expected: Expected, extracted: Extracted): Comparison {
  const fields: Record<string, FieldResult> = {};

  // Receiver — the strongest anti-misdirection check. Account digits are the
  // primary signal; the name is fuzzy because wallets mask it.
  const nameStatus = compareReceiverName(extracted.receiverName, expected.accountName, expected.aliases);
  const tailStatus = compareAccountTail(extracted.receiverAccountTail, expected.accountNumber, expected.phoneNumber);
  const shownName = sanitizeForDisplay(extracted.receiverName);
  const wantedName = sanitizeForDisplay(expected.accountName, 60);

  if (tailStatus === 'mismatch') {
    fields.receiver = {
      status: 'mismatch',
      message: 'This receipt was sent to a different account number than the one shown for this payment method.',
    };
  } else if (nameStatus === 'mismatch' && tailStatus !== 'match') {
    fields.receiver = {
      status: 'mismatch',
      message: shownName
        ? `The receipt shows "${shownName}" as the receiver, but this payment must be sent to ${wantedName}.`
        : `The receiver on the receipt doesn't match ${wantedName}.`,
    };
  } else if (nameStatus === 'mismatch' && tailStatus === 'match') {
    // Name looks different but the account digits agree: could be a name the
    // wallet shows differently. Don't block; ask a human.
    fields.receiver = {
      status: 'unclear',
      message: 'The account number matches, but the receiver name on the receipt looks different.',
    };
  } else if (nameStatus === 'match') {
    fields.receiver = { status: 'match', message: 'Receiver matches.' };
  } else if (nameStatus === 'unclear' && tailStatus === 'match') {
    fields.receiver = { status: 'match', message: 'Receiver account number matches.' };
  } else {
    fields.receiver = {
      status: 'unclear',
      message: "We couldn't read the receiver on the receipt clearly.",
    };
  }

  // Amount — below what is due blocks; at or above passes.
  if (extracted.amount === null || !Number.isFinite(extracted.amount)) {
    fields.amount = { status: 'unclear', message: "We couldn't read the amount on the receipt clearly." };
  } else if (Math.round(extracted.amount * 100) < Math.round(expected.amount * 100)) {
    fields.amount = {
      status: 'mismatch',
      message: `The receipt shows ${peso(extracted.amount)}, but this payment is ${peso(expected.amount)}.`,
    };
  } else {
    fields.amount = { status: 'match', message: 'Amount matches.' };
  }

  // Reference number — one-character differences are treated as OCR doubt.
  const wantRef = normalizeReference(expected.reference);
  const gotRef = normalizeReference(extracted.referenceNumber);
  if (!gotRef) {
    fields.reference = { status: 'unclear', message: "We couldn't read the reference number on the receipt clearly." };
  } else if (gotRef === wantRef || (wantRef.length >= 8 && (gotRef.includes(wantRef) || wantRef.includes(gotRef)) && gotRef.length >= 8)) {
    fields.reference = { status: 'match', message: 'Reference number matches.' };
  } else if (editDistance(gotRef, wantRef) <= 1) {
    fields.reference = {
      status: 'unclear',
      message: 'The reference number on the receipt is almost the same as the one you entered. Please double-check it.',
    };
  } else {
    fields.reference = {
      status: 'mismatch',
      message: "The reference number on the receipt doesn't match the one you entered.",
    };
  }

  // Date — allow one day either way (late-night transfers, time zones).
  const wantDate = parseDateKey(expected.paymentDate);
  const gotDate = parseDateKey(extracted.paymentDate);
  if (!gotDate || !wantDate) {
    fields.date = { status: 'unclear', message: "We couldn't read the date on the receipt clearly." };
  } else if (dayDiff(gotDate, wantDate) <= 1) {
    fields.date = { status: 'match', message: 'Payment date matches.' };
  } else {
    fields.date = {
      status: 'mismatch',
      message: `The receipt is dated ${gotDate}, but you entered ${wantDate}.`,
    };
  }

  // Payment method — only for providers we can recognise on a receipt;
  // custom-named methods have no reliable label to compare.
  const wantProvider = providerOf(expected.methodLabel);
  const gotProvider = providerOf(extracted.methodDetected);
  if (!wantProvider) {
    fields.method = { status: 'skipped', message: 'Not compared for this payment method.' };
  } else if (!gotProvider) {
    fields.method = { status: 'unclear', message: "We couldn't tell which app or bank the receipt is from." };
  } else if (gotProvider !== wantProvider) {
    fields.method = {
      status: 'mismatch',
      message: `This looks like a ${gotProvider.toUpperCase()} receipt, but you chose ${sanitizeForDisplay(expected.methodLabel, 30)}.`,
    };
  } else {
    fields.method = { status: 'match', message: 'Payment method matches.' };
  }

  // Transaction status — only a clearly failed/pending receipt blocks.
  const status = String(extracted.transactionStatus ?? '').toLowerCase();
  if (status === 'failed' || status === 'pending') {
    fields.transaction = {
      status: 'mismatch',
      message: status === 'failed'
        ? 'The receipt shows that this transaction failed.'
        : 'The receipt shows that this transaction is still pending.',
    };
  } else if (status === 'success') {
    fields.transaction = { status: 'match', message: 'Transaction completed.' };
  } else {
    fields.transaction = { status: 'skipped', message: 'Transaction status not shown.' };
  }

  return summarize(fields);
}

// Fields that must be READABLE for an automatic pass. Date, method and
// transaction status are checked when present but don't gate a pass.
const REQUIRED_READABLE = ['receiver', 'amount', 'reference'];

export function summarize(fields: Record<string, FieldResult>): Comparison {
  const mismatched = Object.entries(fields).filter(([, f]) => f.status === 'mismatch');
  if (mismatched.length) {
    return { verdict: 'mismatch', fields, reasons: mismatched.map(([, f]) => f.message) };
  }
  const unclear = REQUIRED_READABLE.filter((k) => fields[k]?.status === 'unclear');
  if (unclear.length) {
    return { verdict: 'needs_review', fields, reasons: unclear.map((k) => fields[k].message) };
  }
  return { verdict: 'pass', fields, reasons: [] };
}
