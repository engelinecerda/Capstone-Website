// Shared guard for every <input type="number"> field admin-side. The
// native min/max/step attributes only affect the input's validity state
// (and the spinner buttons) — they never stop someone from typing or
// pasting an out-of-range or absurdly precise value directly (e.g.
// "99.99999999999999999999" into a percent-off field, which a plain
// Number() conversion silently rounds to 100 instead of rejecting). This
// clamps the value to [min, max] and rounds it to `decimals` places the
// moment the field loses focus, so nothing further downstream (preview
// text, the save payload, the DB write) ever sees the raw unbounded input.
// Deliberately blur-triggered, not input-triggered, so it doesn't fight
// the user mid-keystroke (e.g. rounding "20.1" before they finish typing
// "20.15").
// min/max default to the element's own live min/max attributes when
// omitted, read at blur time rather than wire time — needed for the rare
// field (e.g. min-advance-days) whose max is itself changed at runtime to
// track a sibling field, so the bound this enforces never goes stale.
export function clampNumberInput(el, { min, max, decimals = 0 } = {}) {
  if (!el) return;
  el.addEventListener('blur', () => {
    if (el.value === '') return;
    let num = Number(el.value);
    if (!Number.isFinite(num)) {
      el.value = '';
      return;
    }
    const effectiveMin = Number.isFinite(min) ? min : (el.min !== '' ? Number(el.min) : undefined);
    const effectiveMax = Number.isFinite(max) ? max : (el.max !== '' ? Number(el.max) : undefined);
    const factor = 10 ** decimals;
    num = Math.round(num * factor) / factor;
    if (Number.isFinite(effectiveMin)) num = Math.max(effectiveMin, num);
    if (Number.isFinite(effectiveMax)) num = Math.min(effectiveMax, num);
    el.value = String(num);
  });
}

// Same clamp, applied at save time — a defense-in-depth companion for save
// handlers that read .value directly, in case blur never fired (e.g. Save
// clicked via Enter key while the field still has focus).
export function clampNumberValue(value, { min, max, decimals = 0 } = {}) {
  let num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** decimals;
  num = Math.round(num * factor) / factor;
  if (Number.isFinite(min)) num = Math.max(min, num);
  if (Number.isFinite(max)) num = Math.min(max, num);
  return num;
}
