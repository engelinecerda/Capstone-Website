// system_notice.js — TEMPORARY "testing phase" notice for the customer site.
//
// Shows a closable popup, then stays quiet for SEEN_TTL_MS across the tabs and
// windows of the same browser, so opening a link in a new tab does not
// re-trigger it. It shows again when (a) that window passes, or (b) the visitor
// comes back after closing every tab of the site (a brand-new tab that finds no
// other open tab of the site counts as a new visit). A small bottom-left pill
// always remains to reopen the notice. A second pill opens the
// "Beta Testing Guide" (a step-by-step walkthrough for testers); the guide also pops up right
// after the notice is closed, at most once per GUIDE_TTL_MS (24 hours). Deliberately hardcoded and NOT
// admin-configurable: it is not a system feature, only a disclosure and a guide for the academic
// testing period.
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
  var SEEN_TTL_MS = 3 * 60 * 60 * 1000; // how long "I Understand" is remembered (3 hours)
  var GUIDE_KEY = 'eliBetaGuideSeen';
  var GUIDE_TTL_MS = 24 * 60 * 60 * 1000; // how long before the guide pops up again after the notice (24 hours)

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
    '.sn-pills{position:fixed;left:16px;bottom:calc(16px + var(--sn-lift,0px));z-index:1000;display:flex;flex-direction:column;align-items:flex-start;gap:8px}',
    '.sn-pills[hidden]{display:none}',
    '.sn-pill{display:inline-flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:8px 14px 8px 11px;border:1px solid rgba(61,26,10,.18);border-radius:999px;background:#F5E6C8;color:#5C4210;font:500 12px/1.2 "Inter",system-ui,sans-serif;box-shadow:0 4px 14px rgba(30,12,3,.18);cursor:pointer;transition:background .2s ease,transform .2s ease}',
    '.sn-pill:hover{background:#F2EBE0;transform:translateY(-1px)}',
    '.sn-pill[hidden]{display:none}',
    '.sn-pill svg{flex:none}',
    '.sn-pill .sn-short{display:none}',
    '@media (max-width:480px){.sn-dialog{padding:30px 22px 22px}.sn-title{font-size:27px}.sn-pills{left:10px;bottom:calc(10px + var(--sn-lift,0px));gap:6px}.sn-pill{gap:6px;padding:7px 11px 7px 9px;font-size:11px}.sn-pill .sn-long{display:none}.sn-pill .sn-short{display:inline}}',
    '@media (max-width:340px){.sn-pill{padding:8px}.sn-pill .sn-short{display:none}}',
    '.sn-actions{display:flex;flex-wrap:wrap;gap:10px}',
    '#sn-guide .sn-dialog{max-width:620px}',
    '.sn-dialog .sn-intro{margin-bottom:8px}',
    '.sn-steps{list-style:none;margin:0 0 18px;padding:0}',
    '.sn-step{display:flex;gap:14px;padding:14px 0;border-top:1px solid rgba(61,26,10,.12)}',
    '.sn-num{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:#3D1A0A;color:#fff;font:600 13px \"Inter\",system-ui,sans-serif}',
    '.sn-step-body{min-width:0}',
    '.sn-step h3{margin:3px 0 4px;font:600 14px/1.4 \"Inter\",system-ui,sans-serif;color:#3D1A0A}',
    '.sn-dialog .sn-step p{margin:0;font-size:13.5px;line-height:1.6}',
    '.sn-dialog .sn-step p.sn-note{margin-top:8px;padding:9px 12px;border-left:3px solid #B07D5A;background:#F5E6C8;color:#5C4210;font-size:13px}',
    '.sn-dialog .sn-step p.sn-note-warn{border-left-color:#B5432A;background:#FBE9E4;color:#7A2410;font-weight:500}',
    '@media (max-width:480px){.sn-step{gap:11px}}',
    '@media (prefers-reduced-motion:reduce){.sn-backdrop,.sn-dialog,.sn-pill{transition:none}}'
  ].join('\n');

  var ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

  var BOOK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/></svg>';

  // Beta Testing Guide content. kind: 'note' = highlighted tip, 'warn' = strong warning.
  var GUIDE_STEPS = [
    { title: 'Browse the Website as a Guest',
      text: 'You may explore the available event packages and check the calendar to see which dates are available. However, guest access is mainly for viewing packages and checking date availability.' },
    { title: 'Sign Up or Register for an Account',
      text: 'Before making a reservation, please create an account and log in to the system. An account is required to proceed with the reservation process.' },
    { title: 'Select an Event Package and Make a Reservation',
      text: 'Choose your preferred event package, select an available date and time, provide the required event details, and complete the reservation form.',
      kind: 'note',
      note: '<strong>Important:</strong> We highly recommend making your test reservation at least one day before your intended event date to allow the team sufficient time to review and approve your reservation as soon as possible.' },
    { title: 'Sign the Contract Electronically',
      text: 'At the final step of the reservation process, review the contract details and provide your electronic signature (e-signature) to submit the contract for approval.' },
    { title: 'Wait for Contract and Reservation Approval',
      text: 'After submitting your signed contract, please wait for the team to review and approve your contract and reservation. Once approved, proceed to the payment section.' },
    { title: 'Proceed to Sample Payment',
      text: 'Complete the sample payment process using the system\u2019s available payment features.',
      kind: 'warn',
      note: '<strong>IMPORTANT: NO ACTUAL OR LEGITIMATE PAYMENT IS REQUIRED.</strong> This is strictly for beta testing purposes. You may use a sample payment and sample proof of payment. Please do not transfer any real money.' },
    { title: 'Wait for Payment Approval',
      text: 'After submitting your sample payment and proof of payment, please wait for the team to review and approve your payment submission before proceeding.' },
    { title: 'Explore the System and Leave a Review',
      text: 'After completing the payment process, you may continue exploring the system\u2019s available features. Once your reservation is marked as completed, you may leave a review through the system.' },
    { title: 'Answer the Beta Testing Survey',
      text: 'After testing the system, please complete the beta testing questionnaire and provide your honest feedback about your experience. Your responses will help us evaluate the system\u2019s usability and identify areas for improvement.' }
  ];

  var STEPS_HTML = GUIDE_STEPS.map(function (st, i) {
    return '<li class="sn-step">' +
      '<span class="sn-num" aria-hidden="true">' + (i + 1) + '</span>' +
      '<div class="sn-step-body"><h3>' + st.title + '</h3><p>' + st.text + '</p>' +
      (st.note ? '<p class="sn-note' + (st.kind === 'warn' ? ' sn-note-warn' : '') + '">' + st.note + '</p>' : '') +
      '</div></li>';
  }).join('');

  var HTML =
    '<div class="sn-backdrop" id="sn-notice" hidden>' +
      '<div class="sn-dialog" role="dialog" aria-modal="true" aria-labelledby="sn-title">' +
        '<button type="button" class="sn-x" aria-label="Close notice">&times;</button>' +
        '<p class="sn-eyebrow">Important</p>' +
        '<h2 class="sn-title" id="sn-title">System Notice</h2>' +
        '<p>This website is currently being used for academic project and system testing purposes by 4th-year Information Technology students from STI Ortigas-Cainta.</p>' +
        '<p>Please be advised that the system has not yet been officially turned over to ELI Coffee and is not yet under ELI Coffee\u2019s official operation or management. The features and information presented are intended for testing, evaluation, and demonstration purposes only.</p>' +
        '<p class="sn-ack">By proceeding, you acknowledge that you are accessing a testing version of the system. Thank you for your understanding and cooperation.</p>' +
        '<div class="sn-actions"><button type="button" class="sn-btn sn-ok">I Understand</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="sn-backdrop" id="sn-guide" hidden>' +
      '<div class="sn-dialog" role="dialog" aria-modal="true" aria-labelledby="sn-guide-title">' +
        '<button type="button" class="sn-x" aria-label="Close guide">&times;</button>' +
        '<p class="sn-eyebrow">Beta Testing</p>' +
        '<h2 class="sn-title" id="sn-guide-title">Beta Testing Guide</h2>' +
        '<p class="sn-intro">Hello! Thank you for participating in the beta testing of our Web-Based Event Reservation and Management System. Please follow the steps below to test the system properly.</p>' +
        '<ol class="sn-steps">' + STEPS_HTML + '</ol>' +
        '<p class="sn-ack">Thank you for your time, cooperation, and valuable feedback!</p>' +
        '<div class="sn-actions"><button type="button" class="sn-btn sn-guide-ok">Got It</button></div>' +
      '</div>' +
    '</div>' +
    '<div class="sn-pills" hidden>' +
      '<button type="button" class="sn-pill sn-pill-notice" aria-label="Testing version notice. Click to read.">' + ICON + '<span class="sn-long">Testing version &middot; Academic project</span><span class="sn-short">Testing version</span></button>' +
      '<button type="button" class="sn-pill sn-pill-guide" aria-label="Beta testing guide. Click to read.">' + BOOK_ICON + '<span class="sn-long">Beta Testing Guide</span><span class="sn-short">Beta guide</span></button>' +
    '</div>';

  // Stores the time the notice was acknowledged. localStorage is shared across
  // tabs; if it is unavailable (some private modes) fall back to sessionStorage,
  // where the popup may reappear in new tabs, which is harmless.
  function storageGet(key, ttl) {
    var raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { /* unavailable */ }
    if (raw === null) { try { raw = sessionStorage.getItem(key); } catch (e) { /* unavailable */ } }
    var ts = parseInt(raw, 10);
    return !isNaN(ts) && ts > 0 && Date.now() - ts < ttl && ts <= Date.now() + 60000;
  }
  function storageSet(key) {
    var now = String(Date.now());
    try { localStorage.setItem(key, now); } catch (e) { /* unavailable */ }
    try { sessionStorage.setItem(key, now); } catch (e) { /* unavailable */ }
  }

  // ── "Is this a new visit?" detection ───────────────────────────────────
  // Every open tab answers a ping on a BroadcastChannel. A tab with no
  // per-tab flag (a new tab/window, or a new browser session) pings; if some
  // other tab of the site answers it is a continuing visit, if nobody answers
  // every tab was closed and this is a new visit. The per-tab flag lives in
  // sessionStorage, so it survives reloads and same-tab page navigation.
  var CHANNEL_NAME = 'eli-system-notice';
  var TAB_KEY = 'eliSystemNoticeTab';
  var PING_WAIT_MS = 400;

  function tabHasVisited() { try { return sessionStorage.getItem(TAB_KEY) === '1'; } catch (e) { return false; } }
  function markTabVisited() { try { sessionStorage.setItem(TAB_KEY, '1'); } catch (e) { /* unavailable */ } }

  function startResponder() {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
      var ch = new BroadcastChannel(CHANNEL_NAME);
      ch.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'ping') ch.postMessage({ type: 'alive' });
      });
      return ch;
    } catch (e) { return null; }
  }

  function askOtherTabs(ch, cb) {
    var done = false;
    function finish(alive) {
      if (done) return;
      done = true;
      ch.removeEventListener('message', onMsg);
      cb(alive);
    }
    function onMsg(e) { if (e.data && e.data.type === 'alive') finish(true); }
    ch.addEventListener('message', onMsg);
    ch.postMessage({ type: 'ping' });
    setTimeout(function () { finish(false); }, PING_WAIT_MS);
  }

  // hooks: { open(), showPill() }
  function decideNotice(ch, hooks) {
    if (!storageGet(SEEN_KEY, SEEN_TTL_MS)) { markTabVisited(); hooks.open(); return; }   // never acknowledged, or expired
    if (tabHasVisited()) { hooks.showPill(); return; }                // same tab, still within the window
    if (!ch) { markTabVisited(); hooks.showPill(); return; }          // no BroadcastChannel: time window only
    askOtherTabs(ch, function (alive) {
      markTabVisited();
      if (alive) hooks.showPill(); else hooks.open();                 // nobody else open = new visit
    });
  }

  function init() {
    var style = document.createElement('style');
    style.id = 'sn-styles';
    style.textContent = CSS;
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'system-notice-root';
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);

    var pills = wrap.querySelector('.sn-pills');
    var lastFocus = null;
    var current = null; // the modal currently open, if any

    // Two modals share one scroll lock, key handler and pill stack.
    function makeModal(id) {
      var backdrop = wrap.querySelector('#' + id);
      var m = { backdrop: backdrop, dialog: backdrop.querySelector('.sn-dialog'), timer: null };
      // Belt and braces: stop wheel/touch scrolling from reaching the page behind
      // the modal (iOS Safari can ignore overflow:hidden). Scrolling inside the
      // dialog itself is still allowed.
      function blockScroll(e) { if (!m.dialog.contains(e.target)) e.preventDefault(); }
      backdrop.addEventListener('wheel', blockScroll, { passive: false });
      backdrop.addEventListener('touchmove', blockScroll, { passive: false });
      return m;
    }
    var notice = makeModal('sn-notice');
    var guide = makeModal('sn-guide');

    function onKey(e) {
      if (!current) return;
      if (e.key === 'Escape') { closeModal(current); return; }
      if (e.key !== 'Tab') return;
      var f = current.dialog.querySelectorAll('button');
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function hideBackdrop(m) {
      m.backdrop.classList.remove('sn-open');
      clearTimeout(m.timer);
      m.timer = setTimeout(function () { m.backdrop.hidden = true; }, 250);
    }

    function openModal(m) {
      if (current === m) return;
      if (current) {
        hideBackdrop(current); // swapping notice <-> guide: keep the lock and focus origin
      } else {
        lastFocus = document.activeElement;
        // The site scrolls on <html> (css/styles.css sets html { overflow-y: scroll }),
        // so the lock must cover <html> as well as <body>.
        document.documentElement.classList.add('sn-lock');
        document.addEventListener('keydown', onKey);
      }
      current = m;
      pills.hidden = true;
      clearTimeout(m.timer);
      m.backdrop.hidden = false;
      void m.backdrop.offsetWidth; // let the transition run
      m.backdrop.classList.add('sn-open');
      var primary = m.dialog.querySelector('.sn-btn');
      if (primary) { try { primary.focus({ preventScroll: true }); } catch (e) { primary.focus(); } }
      m.dialog.scrollTop = 0; // the long guide must open at its first step, not at the focused button
    }

    function closeModal(m) {
      if (m === notice) {
        storageSet(SEEN_KEY);
        // The guide follows the notice automatically, but only if it has not
        // been shown in the last 24 hours (opening it from a pill never counts).
        if (!storageGet(GUIDE_KEY, GUIDE_TTL_MS)) { storageSet(GUIDE_KEY); openModal(guide); return; }
      }
      hideBackdrop(m);
      current = null;
      document.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('sn-lock');
      pills.hidden = false;
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    }

    [notice, guide].forEach(function (m) {
      m.backdrop.querySelector('.sn-x').addEventListener('click', function () { closeModal(m); });
      m.backdrop.addEventListener('click', function (e) { if (!m.dialog.contains(e.target)) closeModal(m); });
    });
    notice.dialog.querySelector('.sn-ok').addEventListener('click', function () { closeModal(notice); });
    guide.dialog.querySelector('.sn-guide-ok').addEventListener('click', function () { closeModal(guide); });
    wrap.querySelector('.sn-pill-notice').addEventListener('click', function () { openModal(notice); });
    wrap.querySelector('.sn-pill-guide').addEventListener('click', function () { openModal(guide); });

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
      pills.style.setProperty('--sn-lift', lift + 'px');
    }
    updateLift();
    window.addEventListener('resize', updateLift);
    window.addEventListener('orientationchange', updateLift);
    var liftBar = document.querySelector('.reservation-buttons');
    if (liftBar && window.ResizeObserver) new ResizeObserver(updateLift).observe(liftBar);

    decideNotice(startResponder(), { open: function () { openModal(notice); }, showPill: function () { pills.hidden = false; } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();