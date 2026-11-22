// money.js — pure helpers (no DOM, no side effects): the single source of truth for how money is shown and typed.
//
// Rule: every peso amount ends with exactly two decimal places.
//   10      -> 10.00
//   10.5    -> 10.50
//   10.00   -> 10.00   (already fine, left as is)
//   1234.5  -> 1,234.50
//
// Display:  formatMoney(10)        -> "₱10.00"
//           formatMoneyNumber(10)  -> "10.00"   (no symbol, for tables/inputs)
// Inputs:   moneyInputValue(10)    -> "10.00"   (use when filling an <input>)
//           Typed values are normalised on blur by money_inputs.js, for any
//           <input data-money>.

const MONEY_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function toSafeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoneyNumber(value) {
  const n = toSafeNumber(value);
  return (n < 0 ? '-' : '') + MONEY_FORMAT.format(Math.abs(n));
}

export function formatMoney(value) {
  const n = toSafeNumber(value);
  return (n < 0 ? '-' : '') + '₱' + MONEY_FORMAT.format(Math.abs(n));
}

// For filling an <input>: blank stays blank, anything numeric becomes "0.00".
// No thousands separators, because type="number" inputs reject them.
export function moneyInputValue(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

export function normalizeMoneyInput(el) {
  if (!el || el.value === '') return;
  const formatted = moneyInputValue(el.value);
  if (formatted !== '' && formatted !== el.value) el.value = formatted;
}
