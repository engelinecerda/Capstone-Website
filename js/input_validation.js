// input_validation.js — shared client-side input rules for customer forms
// (signup, reservations, profile). Each validate* function returns '' when
// the value is acceptable, otherwise a user-facing message. The attach*
// helpers restrict what can be typed or pasted so bad values never reach
// the submit handler. Server-side constraints remain the source of truth.

const NAME_START = /^\p{L}/u;
const NAME_BODY = /^[\p{L}\p{M} .'’-]+$/u;
const NAME_STRIP = /[^\p{L}\p{M} .'’-]/gu;

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export function validatePersonName(value, { label = 'Name', required = true, max = 50 } = {}) {
  const v = String(value ?? '').trim();
  if (!v) return required ? `${label} is required.` : '';
  if (v.length > max) return `${label} must be ${max} characters or fewer.`;
  if (!NAME_START.test(v) || !NAME_BODY.test(v)) {
    return `${label} can only contain letters, spaces, hyphens, apostrophes and periods.`;
  }
  return '';
}

export function validateEmailAddress(value) {
  const v = String(value ?? '').trim();
  if (!v) return 'Email address is required.';
  if (v.length > 254) return 'Email address is too long.';
  const [local = ''] = v.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || v.includes('..') || !EMAIL_PATTERN.test(v)) {
    return 'Please enter a valid email address.';
  }
  return '';
}

// Philippine mobile numbers: 11 digits (the phone mask already groups them
// as 0917 562 0306). No prefix check, because newer networks use prefixes
// that don't start with 09 (e.g., Dito's 0895-0898).
export function validatePhoneNumber(value, { required = false } = {}) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return required ? 'Phone number is required.' : '';
  if (digits.length !== 11) {
    return 'Enter a valid 11-digit mobile number (e.g., 0917 562 0306).';
  }
  return '';
}

// Strips characters a name can't contain as the user types or pastes.
export function attachNameGuard(input) {
  if (!input) return;
  input.addEventListener('input', () => {
    const before = input.value;
    const cleaned = before.replace(NAME_STRIP, '').replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
    if (cleaned === before) return;
    const caret = input.selectionStart ?? before.length;
    input.value = cleaned;
    const pos = Math.max(0, caret - (before.length - cleaned.length));
    input.setSelectionRange(pos, pos);
  });
}

// Turns +63 / 63 prefixed pasted numbers into the local 09… form before
// the phone mask runs.
export function attachPhonePasteNormalizer(input) {
  if (!input) return;
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const digits = text.replace(/\D/g, '');
    if (/^63\d{10}$/.test(digits)) {
      e.preventDefault();
      input.value = '0' + digits.slice(2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// Whole-number-only guard for <input type="number">: blocks e / + - . on
// keydown, reduces pasted text to digits, caps length, and stops the mouse
// wheel from silently changing a focused field.
export function attachIntegerGuard(input, { maxDigits = 4 } = {}) {
  if (!input) return;
  input.addEventListener('keydown', (e) => {
    if (['e', 'E', '+', '-', '.', ','].includes(e.key)) e.preventDefault();
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const digits = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, maxDigits);
    input.value = digits;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('input', () => {
    if (input.value.length > maxDigits) input.value = input.value.slice(0, maxDigits);
  });
  input.addEventListener('wheel', () => {
    if (document.activeElement === input) input.blur();
  }, { passive: true });
}

// Keeps emojis, spaces and other non-ASCII characters out of an email field
// as the user types or pastes. The Windows/macOS emoji pickers insert text
// through IME-style composition events, so this also blocks the insert in
// beforeinput and re-cleans on compositionend, input, change and blur.
// (type="email" inputs don't expose a caret position, so if something is
// stripped the caret moves to the end.)
export function attachEmailGuard(input) {
  if (!input) return;
  const BAD = /[^\x21-\x7E]/g;
  const clean = () => {
    const before = input.value;
    const cleaned = before.replace(BAD, '');
    if (cleaned !== before) input.value = cleaned;
  };
  input.addEventListener('beforeinput', (e) => {
    if (typeof e.data === 'string' && BAD.test(e.data)) e.preventDefault();
    BAD.lastIndex = 0;
  });
  ['input', 'compositionend', 'change', 'blur'].forEach((evt) => input.addEventListener(evt, clean));
}
