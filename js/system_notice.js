// system_notice.js — TEMPORARY "testing phase" notice for the customer site.
//
// Shows a closable popup once per browser session (on whichever public page
// the visitor lands on first), then leaves a small bottom-left pill that
// reopens the notice. Deliberately hardcoded and NOT admin-configurable: it
// is not a system feature, only a disclosure for the academic testing period.
//
// TO REMOVE once testing is over (self-contained, nothing else depends on it):
//   1. Delete this file (js/system_notice.js).
//   2. Delete the two lines tagged "SYSTEM-NOTICE" (a comment + a <script>)
//      near the end of <body> in each root-level .html file:
//        grep -rl "SYSTEM-NOTICE" --include=*.html .
(function () {
  'use strict';
  if (window.__eliSystemNoticeLoaded) return;
  window.__eliSystemNoticeLoaded = true;

  var SEEN_KEY = 'eliSystemNoticeSeen';

  var CSS = [
    '.sn-backdrop{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(30,12,3,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .25s ease}',
    '.sn-backdrop.sn-open{opacity:1}',
    'html.sn-lock,html.sn-lock body{overflow:hidden !important}',
    'html.sn-lock{scrollbar-gutter:stable}',
    '.sn-backdrop[hidden]{display:none}',
    '.sn-dialog{position:relative;width:100%;max-width:520px;max-height:calc(100vh - 40px);overflow-y:auto;box-sizing:border-box;padding:36px 36px 28px;background:#FAF8F4;color:#1E0D04;border-top:4px solid #3D1A0A;box-shadow:0 24px 60px rgba(30,12,3,.4);overscroll-behavior:contain;font-family:"Inter",system-ui,sans-serif;transform:translateY(12px);transition:transform .25s ease}',
    '.sn-backdrop.sn-open .sn-dialog{transform:none}',
    '.sn-eyebrow{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#B07D5A}',
    '.sn-title{margin:0 0 16px;font-family:"Cormorant Garamond",Georgia,serif;font-size:32px;font-weight:500;line-height:1.1;color:#3D1A0A}',
    '.sn-dialog p{margin:0 0 12px;font-size:14px;line-height:1.65;color:#5A3420}',
    '.sn-dialog p.sn-ack{margin-bottom:22px;font-weight:500;color:#3D1A0A}',
    '.sn-btn{display:inline-block;padding:12px 26px;border:0;background:#3D1A0A;color:#fff;font:600 12px "Inter",system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:background .2s ease}',
    '.sn-btn:hover{background:#6B3820}',
    '.sn-x{position:absolute;top:10px;right:12px;width:34px;height:34px;border:0;background:transparent;color:#6B3820;font-size:24px;line-height:1;cursor:pointer}',
    '.sn-x:hover{color:#1E0C03}',
    '.sn-btn:focus-visible,.sn-x:focus-visible,.sn-pill:focus-visible{outline:2px solid #B07D5A;outline-offset:2px}',
    '.sn-pill{position:fixed;left:16px;bottom:calc(16px + var(--sn-lift,0px));z-index:1000;display:inline-flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:8px 14px 8px 11px;border:1px solid rgba(61,26,10,.18);border-radius:999px;background:#F5E6C8;color:#5C4210;font:500 12px/1.2 "Inter",system-ui,sans-serif;box-shadow:0 4px 14px rgba(30,12,3,.18);cursor:pointer;transition:background .2s ease,transform .2s ease}',
    '.sn-pill:hover{background:#F2EBE0;transform:translateY(-1px)}',
    '.sn-pill[hidden]{display:none}',
    '.sn-pill svg{flex:none}',
    '.sn-pill .sn-short{display:none}',
    '@media (max-width:480px){.sn-dialog{padding:30px 22px 22px}.sn-title{font-size:27px}.sn-pill{left:10px;bottom:calc(10px + var(--sn-lift,0px));gap:6px;padding:7px 11px 7px 9px;font-size:11px}.sn-pill .sn-long{display:none}.sn-pill .sn-short{display:inline}}',
    '@media (max-width:340px){.sn-pill{padding:8px}.sn-pill .sn-short{display:none}}',
    '@media (prefers-reduced-motion:reduce){.sn-backdrop,.sn-dialog,.sn-pill{transition:none}}'
  ].join('\n');

  var ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  var HTML =
    '<div class="sn-backdrop" hidden>' +
      '<div class="sn-dialog" role="dialog" aria-modal="true" aria-labelledby="sn-title">' +
        '<button type="button" class="sn-x" aria-label="Close notice">&times;</button>' +
        '<p class="sn-eyebrow">Important</p>' +
        '<h2 class="sn-title" id="sn-title">System Notice</h2>' +
        '<p>This website is currently being used for academic project and system testing purposes by 4th-year Information Technology students from STI Ortigas-Cainta.</p>' +
        '<p>Please be advised that the system has not yet been officially turned over to ELI Coffee and is not yet under ELI Coffee\u2019s official operation or management. The features and information presented are intended for testing, evaluation, and demonstration purposes only.</p>' +
        '<p class="sn-ack">By proceeding, you acknowledge that you are accessing a testing version of the system. Thank you for your understanding and cooperation.</p>' +
        '<button type="button" class="sn-btn">I Understand</button>' +
      '</div>' +
    '</div>' +
    '<button type="button" class="sn-pill" hidden aria-label="Testing version notice. Click to read.">' + ICON + '<span class="sn-long">Testing version &middot; Academic project</span><span class="sn-short">Testing version</span></button>';

  function storageGet() { try { return sessionStorage.getItem(SEEN_KEY); } catch (e) { return null; } }
  function storageSet() { try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: popup may reappear, harmless */ } }

  function init() {
    var style = document.createElement('style');
    style.id = 'sn-styles';
    style.textContent = CSS;
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'system-notice-root';
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);

    var backdrop = wrap.querySelector('.sn-backdrop');
    var dialog = wrap.querySelector('.sn-dialog');
    var pill = wrap.querySelector('.sn-pill');
    var closeBtn = wrap.querySelector('.sn-x');
    var okBtn = wrap.querySelector('.sn-btn');
    var lastFocus = null;

    // Belt and braces: stop wheel/touch scrolling from reaching the page behind
    // the modal (iOS Safari can ignore overflow:hidden). Scrolling inside the
    // dialog itself is still allowed.
    function blockScroll(e) { if (!dialog.contains(e.target)) e.preventDefault(); }

    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      var f = [closeBtn, okBtn];
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function open() {
      lastFocus = document.activeElement;
      // The site scrolls on <html> (css/styles.css sets html { overflow-y: scroll }),
      // so the lock must cover <html> as well as <body>.
      document.documentElement.classList.add('sn-lock');
      pill.hidden = true;
      backdrop.hidden = false;
      void backdrop.offsetWidth; // let the transition run
      backdrop.classList.add('sn-open');
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('wheel', blockScroll, { passive: false });
      backdrop.addEventListener('touchmove', blockScroll, { passive: false });
      okBtn.focus();
    }

    function close() {
      storageSet();
      document.removeEventListener('keydown', onKey);
      backdrop.removeEventListener('wheel', blockScroll);
      backdrop.removeEventListener('touchmove', blockScroll);
      backdrop.classList.remove('sn-open');
      document.documentElement.classList.remove('sn-lock');
      setTimeout(function () { backdrop.hidden = true; }, 250);
      pill.hidden = false;
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }

    closeBtn.addEventListener('click', close);
    okBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) { if (!dialog.contains(e.target)) close(); });
    pill.addEventListener('click', open);

    // Pages with a fixed bottom action bar on small screens (e.g. the
    // reservation form's Back/Next bar) would otherwise be covered by the
    // pill, so lift the pill by that bar's height.
    function updateLift() {
      var bar = document.querySelector('.reservation-buttons');
      var lift = 0;
      if (bar) {
        var cs = window.getComputedStyle(bar);
        if (cs.position === 'fixed' && cs.display !== 'none') lift = bar.offsetHeight;
      }
      pill.style.setProperty('--sn-lift', lift + 'px');
    }
    updateLift();
    window.addEventListener('resize', updateLift);
    window.addEventListener('orientationchange', updateLift);
    var liftBar = document.querySelector('.reservation-buttons');
    if (liftBar && window.ResizeObserver) new ResizeObserver(updateLift).observe(liftBar);

    if (storageGet()) { pill.hidden = false; } else { open(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();