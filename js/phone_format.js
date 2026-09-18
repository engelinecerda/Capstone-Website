// phone_format.js — shared live-formatting for Philippine mobile numbers.
// Groups digits as 0917 562 0306, matching the spacing already used in this
// site's own static contact copy (see footers across the customer pages).
// Attach to any phone <input> so typing/pasting auto-formats as you go.

export function attachPhoneMask(input) {
  if (!input) return;

  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('maxlength', '13'); // "0917 562 0306" including spaces

  input.addEventListener('input', () => {
    const caretDigitsBefore = input.value
      .slice(0, input.selectionStart ?? input.value.length)
      .replace(/\D/g, '').length;

    const digits = input.value.replace(/\D/g, '').slice(0, 11);
    let formatted = digits;
    if (digits.length > 7) {
      formatted = digits.slice(0, 4) + ' ' + digits.slice(4, 7) + ' ' + digits.slice(7);
    } else if (digits.length > 4) {
      formatted = digits.slice(0, 4) + ' ' + digits.slice(4);
    }
    input.value = formatted;

    // Re-place the caret after the same number of digits the user had typed
    // past, so formatting mid-string doesn't fling the cursor to the end.
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < caretDigitsBefore) {
      if (/\d/.test(formatted[pos])) seen++;
      pos++;
    }
    input.setSelectionRange(pos, pos);
  });
}
