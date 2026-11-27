// Manager "Sign and approve" dialog (Reservation Details).
//
// The manager draws a signature and confirms with their password; the
// countersign-contract edge function appends it to the customer-signed PDF.
// This module only collects the signature + password and calls the function.
// Approving the reservation stays with the caller (the database refuses it
// until the contract is countersigned).
//
// openCountersignDialog({ supabase, reservation }) resolves to
//   { signed: true, countersignedUrl }  after a successful signature, or
//   { signed: false }                   when the manager cancels.

import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';
import { setButtonSaving, isButtonSaving } from './button_saving.js';

let dialogEl = null;

function buildDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop hidden';
  wrap.id = 'countersignModal';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
    <div class="modal-card assignment-modal-card" role="dialog" aria-modal="true" aria-labelledby="countersignTitle">
      <div class="assignment-modal-header">
        <div>
          <h2 class="assignment-modal-title" id="countersignTitle">Sign and approve</h2>
          <p class="assignment-modal-subtitle" id="countersignSubtitle"></p>
        </div>
        <button type="button" class="assignment-modal-close" id="countersignClose" aria-label="Close">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="assignment-modal-body">
        <label class="countersign-label" for="countersignPad">Draw your signature</label>
        <canvas id="countersignPad" class="countersign-pad" width="1200" height="320"></canvas>
        <div class="countersign-pad-row">
          <span class="countersign-signer" id="countersignSigner"></span>
          <button type="button" class="header-action-btn" id="countersignClear">Clear</button>
        </div>
        <label class="countersign-label" for="countersignPassword">Confirm with your password</label>
        <input type="password" id="countersignPassword" class="countersign-input" autocomplete="current-password" placeholder="Enter your password">
        <p class="modal-message" id="countersignMessage" aria-live="polite"></p>
      </div>
      <div class="assignment-modal-footer">
        <button type="button" class="header-action-btn" id="countersignCancel">Cancel</button>
        <button type="button" class="header-action-btn primary" id="countersignConfirm">Sign and approve</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  return wrap;
}

function makePad(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const state = { drawing: false, last: null, drawn: false };
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  };
  canvas.addEventListener('pointerdown', (e) => {
    state.drawing = true;
    state.last = pos(e);
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.drawing) return;
    const p = pos(e);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(state.last.x, state.last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    state.last = p;
    state.drawn = true;
    canvas.dispatchEvent(new CustomEvent('pad-drawn'));
  });
  const stop = () => { state.drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    get drawn() { return state.drawn; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); state.drawn = false; },
    // Transparent PNG, cropped to the strokes so the signature fills the PDF slot.
    toPng() {
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width, minY = height, maxX = 0, maxY = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) return null;
      const pad = 12;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
      const out = document.createElement('canvas');
      out.width = maxX - minX + 1;
      out.height = maxY - minY + 1;
      out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }
  };
}

export function openCountersignDialog({ supabase, reservation, signerLabel = '' }) {
  if (!dialogEl) dialogEl = buildDialog();
  const el = dialogEl;
  const q = (id) => el.querySelector(`#${id}`);
  const canvas = q('countersignPad');
  const message = q('countersignMessage');
  const confirmBtn = q('countersignConfirm');
  const password = q('countersignPassword');

  const pad = makePad(canvas);
  pad.clear();
  password.value = '';
  message.textContent = '';
  message.classList.remove('error');
  q('countersignSubtitle').textContent =
    `You are signing the contract for ${reservation.reservation_number || 'this reservation'} as ELI's authorized representative. This also approves the reservation.`;
  q('countersignSigner').textContent = signerLabel;

  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  lockBodyScroll();

  return new Promise((resolve) => {
    const cleanups = [];
    const on = (target, type, fn) => { target.addEventListener(type, fn); cleanups.push(() => target.removeEventListener(type, fn)); };

    const finish = (result) => {
      cleanups.forEach((fn) => fn());
      pad.clear();
      password.value = '';
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
      unlockBodyScroll();
      resolve(result);
    };
    const fail = (text) => { message.textContent = text; message.classList.add('error'); };

    on(q('countersignClear'), 'click', () => { if (!isButtonSaving(confirmBtn)) pad.clear(); });
    on(canvas, 'pad-drawn', () => { message.textContent = ''; });
    const cancel = () => { if (!isButtonSaving(confirmBtn)) finish({ signed: false }); };
    on(q('countersignCancel'), 'click', cancel);
    on(q('countersignClose'), 'click', cancel);
    on(el, 'click', (e) => { if (e.target === el) cancel(); });
    on(password, 'keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });

    on(confirmBtn, 'click', async () => {
      if (isButtonSaving(confirmBtn)) return;
      if (!pad.drawn) { fail('Please draw your signature first.'); return; }
      if (!password.value) { fail('Enter your password to sign.'); return; }
      const png = pad.toPng();
      if (!png) { fail('Please draw your signature first.'); return; }

      message.textContent = '';
      message.classList.remove('error');
      setButtonSaving(confirmBtn, true, 'Signing…');
      try {
        const { data, error } = await supabase.functions.invoke('countersign-contract', {
          body: {
            reservation_id: reservation.reservation_id,
            signature_data_url: png,
            password: password.value,
            time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone
          }
        });
        // A non-2xx reply reaches us as `error`; the JSON body says why.
        let reason = data?.error || '';
        if (error && !reason) {
          try { reason = (await error.context?.json?.())?.error || ''; } catch { /* body unreadable */ }
        }
        if (error || !data?.success) {
          fail(reason || 'We could not sign the contract. Please try again.');
          return;
        }
        finish({ signed: true, countersignedUrl: data.countersigned_url || null });
      } catch (err) {
        console.error('[countersign] failed:', err);
        fail('We could not sign the contract. Please try again.');
      } finally {
        setButtonSaving(confirmBtn, false);
      }
    });

    setTimeout(() => canvas.scrollIntoView?.({ block: 'nearest' }), 0);
  });
}
