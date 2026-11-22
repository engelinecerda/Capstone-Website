// money_inputs.js — import this once on any page that has money <input>s.
// A single delegated listener turns whatever was typed into two decimals when
// the field loses focus (10 -> 10.00, 10.5 -> 10.50, 10.00 stays 10.00). It
// covers every <input data-money>, including ones rendered later by JS.
import { normalizeMoneyInput } from './money.js';

if (typeof document !== 'undefined' && !window.__moneyInputsWired) {
  window.__moneyInputsWired = true;
  document.addEventListener('focusout', (event) => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.hasAttribute('data-money')) normalizeMoneyInput(el);
  });
}
