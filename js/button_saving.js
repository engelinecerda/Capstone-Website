// button_saving.js — the 'saving' state for buttons that write to the server.
//
// While a write runs the button shows a spinner and 'Saving…' (or a label you
// pass), keeps its width, and ignores clicks; afterwards it gets its own label
// back. The button is NOT `disabled` (that would dim it like an unavailable
// action), so a button's own disabled/enabled logic keeps working. The styles
// are injected once from here, so a page only needs to import this file.
//
//   import { withSaving, bindSaving, setButtonSaving, isButtonSaving } from './button_saving.js';
//
//   bindSaving(saveBtn, saveSettings);          // click handler that returns a promise
//   bindSaving(form, handler, { submit: true }) // <form>: uses its submit button
//   await withSaving(btn, async () => { ... }); // wrap any async block
//   setButtonSaving(btn, true) / (btn, false)   // manual, e.g. around a confirm dialog
//
// Dialogs that run a callback instead of returning a promise (the settings
// 'confirm changes' pop-up) use triggerButton(): the Save button that opened
// the dialog, so the spinner starts when the change is confirmed.

const STYLE_ID = 'btn-saving-style';

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
@keyframes btn-saving-spin { to { transform: rotate(360deg); } }
.is-saving { pointer-events: none; cursor: progress; opacity: 0.85; }
.is-saving::before {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 8px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  vertical-align: -2px;
  animation: btn-saving-spin 0.7s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .is-saving::before { animation-duration: 2s; } }`;
  document.head.appendChild(style);
}

export function isButtonSaving(btn) {
  return !!btn?.classList?.contains('is-saving');
}

export function setButtonSaving(btn, saving, label = 'Saving…') {
  if (!btn) return;
  if (saving) {
    if (isButtonSaving(btn)) return;
    ensureStyle();
    btn.dataset.idleLabel = btn.textContent;
    btn.style.minWidth = btn.offsetWidth + 'px';   // keep the width so the row doesn't jump
    btn.textContent = label;
    btn.classList.add('is-saving');
    btn.setAttribute('aria-busy', 'true');
  } else if (isButtonSaving(btn)) {
    btn.textContent = btn.dataset.idleLabel ?? btn.textContent;
    btn.style.minWidth = '';
    btn.classList.remove('is-saving');
    btn.removeAttribute('aria-busy');
  }
}

export async function withSaving(btn, fn, label) {
  if (isButtonSaving(btn)) return undefined;
  setButtonSaving(btn, true, label);
  try { return await fn(); } finally { setButtonSaving(btn, false); }
}

// Click handler (or form submit handler) that shows the saving state until the
// handler's promise settles. Missing elements are skipped, like `?.addEventListener`.
export function bindSaving(target, handler, { submit = false, label } = {}) {
  if (!target) return;
  if (submit) {
    target.addEventListener('submit', (e) => {
      const btn = e.submitter || target.querySelector('button[type="submit"]');
      return withSaving(btn, () => handler(e), label);
    });
  } else {
    target.addEventListener('click', (e) => withSaving(target, () => handler(e), label));
  }
}

// The last <button> that was clicked, remembered so a dialog opened from a
// Save handler can find the button to put into the saving state.
let lastClicked = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button') : null;
    if (b) lastClicked = b;
  }, true);
}
export function triggerButton() {
  return lastClicked && lastClicked.isConnected ? lastClicked : null;
}
