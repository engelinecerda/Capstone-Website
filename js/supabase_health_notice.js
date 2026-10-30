// supabase_health_notice.js — "service issue" notice for the whole site: the
// customer pages and the admin / manager / staff portals (admin/, board/).
//
// Watches whether the site's own Supabase project is answering. When it has
// failed 3 checks in a row, a popup (same look and behaviour as the System
// Notice: backdrop, page locked, Esc / backdrop click / button to close) says
// some features (login, reservations, payments) may not work right now. It pops
// up once per outage; closing it leaves a small pill at the bottom-right that
// reopens it. When Supabase answers again, the popup and pill remove themselves,
// no refresh needed. If the outage comes back within RELAPSE_WINDOW_MS of a
// recovery that the visitor had already seen and closed, it returns as the pill
// only (no second popup); after that much stability, the next outage gets the
// full popup again. If the System Notice or Beta Testing Guide is open at that
// moment, this popup waits until it is closed instead of stacking on top of it.
//
// How a check is judged (one tiny read of the public `business_contact` table,
// the same one the footer already reads):
//   - answers within CHECK_TIMEOUT_MS, any status below 500  -> healthy, even if slow
//   - no answer within CHECK_TIMEOUT_MS, a network error, or a 5xx -> one failure
//   - FAILS_TO_ALERT failures in a row -> show the notice (a healthy check resets the count)
//   - the visitor's own connection being down (navigator.onLine === false) is
//     never counted: that is not a Supabase problem, so the notice stays quiet.
//
// Cadence: healthy = one check per HEALTHY_INTERVAL_MS, which depends on who
// is using the page (customers are the biggest crowd and the quickest to give
// up, so they get the shortest gap; each staff tab is one of few):
//   customer pages ................ 2.5 min
//   admin / manager (/admin/*) .... 3 min
//   staff (/board/*) .............. 3.5 min
// After a failure the
// gap between checks follows RETRY_LADDER_MS (5s, 10s, 30s, then 60s and stays
// there). The two short gaps are the quick confirmation retries that lead to
// the third failure (and so the notice) within seconds; the long gaps are the
// sustained part of an outage, so a struggling server is not hit harder by
// every open tab. The ladder keeps applying while the notice is showing, and
// resets after the first healthy check. Every gap gets random jitter (see
// jittered()) so tabs that started together drift apart instead of probing in
// the same second. Checks only run while the tab is visible; a hidden tab
// catches up the moment it is shown again.
//
// Deliberately separate from js/system_notice.js (the testing-phase disclosure,
// which is removed when testing ends). This file is a permanent feature.
//
// To REMOVE: delete this file and the two lines tagged "SUPABASE-HEALTH"
// (a comment + a <script>) near the end of <body> in every .html file that
// carries them (customer pages at the root, admin/, board/):
//   grep -rl "SUPABASE-HEALTH" --include=*.html .
(function () {
  'use strict';
  if (window.__eliSupabaseHealthLoaded) return;
  window.__eliSupabaseHealthLoaded = true;

  // Staff accounts are refused on the /admin pages and customers never see
  // either portal, so the first path segment identifies the audience.
  function healthyIntervalFor(pathname) {
    var path = String(pathname || '').toLowerCase();
    if (/^\/board(\/|$)/.test(path)) return STAFF_HEALTHY_INTERVAL_MS;
    if (/^\/admin(\/|$)/.test(path)) return ADMIN_HEALTHY_INTERVAL_MS;
    return CUSTOMER_HEALTHY_INTERVAL_MS;
  }

  // ── Tunables ───────────────────────────────────────────────────────────
  var CHECK_TIMEOUT_MS = 5000;         // a check slower than this counts as failed
  var FAILS_TO_ALERT = 3;              // consecutive failed checks before the notice shows
  var CUSTOMER_HEALTHY_INTERVAL_MS = 150000; // customer pages: gap between checks while everything is fine (2.5 min)
  var ADMIN_HEALTHY_INTERVAL_MS = 180000;    // admin / manager portal, /admin/* (3 min)
  var STAFF_HEALTHY_INTERVAL_MS = 210000;    // staff portal, /board/* (3.5 min)
  // Only the healthy gap differs per portal; the failure ladder below is the
  // same everywhere so an outage is confirmed just as fast for everyone.
  var HEALTHY_INTERVAL_MS = healthyIntervalFor(location.pathname);
  var RETRY_LADDER_MS = [5000, 10000, 30000, 60000]; // gaps after consecutive failures; the last one repeats
  var JITTER = 0.2;                    // every gap is randomised by +/- this fraction
  var FIRST_CHECK_DELAY_MS = 3000;     // let the page finish loading before the first check
  var DISMISS_TTL_MS = 30 * 60 * 1000; // a closed notice stays a pill across page loads for this long
  var RELAPSE_WINDOW_MS = 10 * 60 * 1000; // an outage returning within this long after a seen-and-closed one is pill-only

  // Keep in sync with DEFAULT_SUPABASE_URL / DEFAULT_SUPABASE_KEY in js/supabase.js
  // (that file is an ES module and does not export them for a plain script).
  var SUPABASE_URL = 'https://gznemevovvcfjnuwsixl.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM';

  // Same localhost-only override js/supabase.js honours, so local testing against
  // another project checks that project instead.
  try {
    var host = String(location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      var ov = JSON.parse(localStorage.getItem('eli-supabase-override') || 'null');
      if (ov && typeof ov.url === 'string' && typeof ov.key === 'string' && ov.url.trim() && ov.key.trim()) {
        SUPABASE_URL = ov.url.trim();
        SUPABASE_KEY = ov.key.trim();
      }
    }
  } catch (e) { /* no override */ }

  var CHECK_URL = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/business_contact?select=id&limit=1';
  var DISMISS_KEY = 'eliSupabaseHealthDismissed';
  var RECOVERED_KEY = 'eliSupabaseHealthRecovered';

  // ── Styles / markup (same look as the System Notice) ───────────────────
  var CSS = [
    '.sh-backdrop{position:fixed;inset:0;z-index:10060;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(30,12,3,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .25s ease}',
    '.sh-backdrop.sh-open{opacity:1}',
    '.sh-backdrop[hidden]{display:none}',
    'html.sh-lock,html.sh-lock body{overflow:hidden !important}',
    'html.sh-lock{scrollbar-gutter:stable}',
    '.sh-dialog{position:relative;width:100%;max-width:520px;max-height:calc(100vh - 40px);overflow-y:auto;box-sizing:border-box;padding:36px 36px 28px;background:#FAF8F4;color:#1E0D04;border-top:4px solid #B5432A;box-shadow:0 24px 60px rgba(30,12,3,.4);overscroll-behavior:contain;font-family:"Inter",system-ui,sans-serif;transform:translateY(12px);transition:transform .25s ease}',
    '.sh-backdrop.sh-open .sh-dialog{transform:none}',
    '.sh-eyebrow{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#B5432A}',
    '.sh-title{margin:0 0 16px;padding-right:24px;font-family:"Cormorant Garamond",Georgia,serif;font-size:32px;font-weight:500;line-height:1.1;color:#3D1A0A}',
    '.sh-dialog p{margin:0 0 12px;font-size:14px;line-height:1.65;color:#5A3420}',
    '.sh-dialog p.sh-ack{margin-bottom:22px;font-weight:500;color:#3D1A0A}',
    '.sh-btn{display:inline-block;padding:12px 26px;border:0;background:#3D1A0A;color:#fff;font:600 12px "Inter",system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:background .2s ease}',
    '.sh-btn:hover{background:#6B3820}',
    '.sh-x{position:absolute;top:10px;right:12px;width:34px;height:34px;border:0;background:transparent;color:#6B3820;font-size:24px;line-height:1;cursor:pointer}',
    '.sh-x:hover{color:#1E0C03}',
    '.sh-btn:focus-visible,.sh-x:focus-visible,.sh-pill:focus-visible{outline:2px solid #B07D5A;outline-offset:2px}',
    '.sh-pill{position:fixed;right:16px;bottom:calc(16px + var(--sh-lift,0px) + var(--sh-stack,0px));z-index:1001;display:inline-flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:8px 14px 8px 11px;border:1px solid rgba(181,67,42,.35);border-radius:999px;background:#FBE9E4;color:#7A2410;font:500 12px/1.2 "Inter",system-ui,sans-serif;box-shadow:0 4px 14px rgba(30,12,3,.18);cursor:pointer;transition:background .2s ease,transform .2s ease}',
    '.sh-pill:hover{background:#F7D9D0;transform:translateY(-1px)}',
    '.sh-pill[hidden]{display:none}',
    '.sh-pill svg{flex:none}',
    '.sh-pill .sh-short{display:none}',
    '@media (max-width:480px){.sh-dialog{padding:30px 22px 22px}.sh-title{font-size:27px}.sh-pill{right:10px;bottom:calc(10px + var(--sh-lift,0px) + var(--sh-stack,0px));gap:6px;padding:7px 11px 7px 9px;font-size:11px}.sh-pill .sh-long{display:none}.sh-pill .sh-short{display:inline}}',
    '@media (prefers-reduced-motion:reduce){.sh-backdrop,.sh-dialog,.sh-pill{transition:none}}',
    '@media print{.sh-backdrop,.sh-pill{display:none !important}}'
  ].join('\n');

  var ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

  var HTML =
    '<div class="sh-backdrop" hidden>' +
      '<div class="sh-dialog" role="dialog" aria-modal="true" aria-labelledby="sh-title">' +
        '<button type="button" class="sh-x" aria-label="Close notice">&times;</button>' +
        '<p class="sh-eyebrow">Service Notice</p>' +
        '<h2 class="sh-title" id="sh-title">Some features may not work right now</h2>' +
        '<p>We are experiencing connection issues with our servers, which is temporarily affecting all system operations. Please try again shortly.</p>' +
        '<p class="sh-ack">This notice will disappear on its own once the connection is restored.</p>' +
        '<div class="sh-actions"><button type="button" class="sh-btn sh-ok">Got It</button></div>' +
      '</div>' +
    '</div>' +
    '<button type="button" class="sh-pill" aria-label="Service notice. Some features may not work right now. Click to read." hidden>' + ICON + '<span class="sh-long">Service issue &middot; Some features may not work</span><span class="sh-short">Service issue</span></button>';

  // ── State ──────────────────────────────────────────────────────────────
  var fails = 0;            // consecutive failed checks
  var backoffStep = 0;      // position on RETRY_LADDER_MS; only a healthy check resets it
  var alerting = false;     // an outage is on (popup, pill, or popup waiting its turn)
  var dismissed = false;    // visitor closed the popup during this outage
  var modalOpen = false;    // the popup is on screen
  var waitTimer = null;     // polls until the System Notice popups are closed
  var lastFocus = null;
  var running = false;      // a check is in flight
  var timer = null;
  var pendingWhileHidden = false;
  var ui = null;            // { wrap, backdrop, dialog, pill }
  var observedPills = null;

  function recent(key, ttl) {
    var raw = null;
    try { raw = sessionStorage.getItem(key); } catch (e) { /* unavailable */ }
    var ts = parseInt(raw, 10);
    return !isNaN(ts) && ts > 0 && Date.now() - ts < ttl && ts <= Date.now() + 60000;
  }
  function put(key) { try { sessionStorage.setItem(key, String(Date.now())); } catch (e) { /* unavailable */ } }
  function drop(key) { try { sessionStorage.removeItem(key); } catch (e) { /* unavailable */ } }

  // ── The health check ───────────────────────────────────────────────────
  // cb('ok' | 'fail' | 'skip'). 'skip' = not Supabase's fault (visitor offline)
  // or the browser can't run the check; it is neither a failure nor a success.
  function probe(cb) {
    if (typeof fetch !== 'function' || navigator.onLine === false) { cb('skip'); return; }
    var done = false;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () {
      finish('fail');
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
    }, CHECK_TIMEOUT_MS);
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(t);
      // The visitor lost their own connection mid-check: not Supabase's problem.
      if (result === 'fail' && navigator.onLine === false) result = 'skip';
      cb(result);
    }
    fetch(CHECK_URL, {
      method: 'GET',
      headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      // Any answer below 500 (even 401/404) means Supabase is up and responding.
      finish(res.status >= 500 ? 'fail' : 'ok');
      try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore */ }
    }, function () {
      finish('fail');
    });
  }

  // +/- JITTER around ms, so tabs do not probe in lockstep.
  function jittered(ms) {
    return Math.round(ms * (1 - JITTER + Math.random() * 2 * JITTER));
  }

  // Gap before the next retry: the ladder step we are on, then one step further.
  function retryGap() {
    var gap = RETRY_LADDER_MS[Math.min(backoffStep, RETRY_LADDER_MS.length - 1)];
    backoffStep++;
    return gap;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, jittered(ms));
  }

  function tick() {
    if (document.hidden) { pendingWhileHidden = true; return; } // resumes on visibilitychange
    run();
  }

  function run() {
    if (running) return;
    running = true;
    probe(function (result) {
      running = false;
      handle(result);
    });
  }

  function handle(result) {
    if (result === 'skip') {
      // Not Supabase's fault (visitor offline): no failure counted, and the
      // ladder does not advance, but an ongoing outage is still rechecked.
      fails = 0;
      schedule(alerting ? RETRY_LADDER_MS[Math.min(backoffStep, RETRY_LADDER_MS.length - 1)] : HEALTHY_INTERVAL_MS);
      return;
    }
    if (result === 'ok') {
      fails = 0;
      backoffStep = 0;
      if (alerting) setAlert(false);
      schedule(HEALTHY_INTERVAL_MS);
      return;
    }
    fails++;
    if (fails >= FAILS_TO_ALERT && !alerting) setAlert(true);
    schedule(retryGap());
  }

  // ── The notice ─────────────────────────────────────────────────────────
  function buildUi() {
    if (ui) return ui;
    var style = document.createElement('style');
    style.id = 'sh-styles';
    style.textContent = CSS;
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'supabase-health-root';
    wrap.innerHTML = HTML;
    document.body.appendChild(wrap);

    ui = {
      wrap: wrap,
      backdrop: wrap.querySelector('.sh-backdrop'),
      dialog: wrap.querySelector('.sh-dialog'),
      pill: wrap.querySelector('.sh-pill'),
      hideTimer: null
    };

    // Stop wheel/touch scrolling from reaching the page behind the popup (iOS
    // Safari can ignore overflow:hidden). Scrolling inside the dialog still works.
    function blockScroll(e) { if (!ui.dialog.contains(e.target)) e.preventDefault(); }
    ui.backdrop.addEventListener('wheel', blockScroll, { passive: false });
    ui.backdrop.addEventListener('touchmove', blockScroll, { passive: false });

    wrap.querySelector('.sh-x').addEventListener('click', userClose);
    wrap.querySelector('.sh-ok').addEventListener('click', userClose);
    ui.backdrop.addEventListener('click', function (e) { if (!ui.dialog.contains(e.target)) userClose(); });
    ui.pill.addEventListener('click', openModal);

    window.addEventListener('resize', updateOffsets);
    window.addEventListener('orientationchange', updateOffsets);
    var bar = document.querySelector('.reservation-buttons');
    if (bar && window.ResizeObserver) new ResizeObserver(updateOffsets).observe(bar);
    return ui;
  }

  // Keep the pill clear of (a) the reservation form's fixed Back/Next bar and (b)
  // on small screens, the System Notice pills, which sit bottom-left and would
  // otherwise run into it.
  function updateOffsets() {
    if (!ui) return;
    var lift = 0;
    var bar = document.querySelector('.reservation-buttons');
    if (bar) {
      var cs = window.getComputedStyle(bar);
      if (cs.position === 'fixed' && cs.display !== 'none') lift = bar.offsetHeight;
    }
    var stack = 0;
    var snPills = document.querySelector('#system-notice-root .sn-pills');
    if (snPills && !snPills.hidden && window.matchMedia && window.matchMedia('(max-width:480px)').matches) {
      stack = snPills.offsetHeight + 8;
    }
    ui.wrap.style.setProperty('--sh-lift', lift + 'px');
    ui.wrap.style.setProperty('--sh-stack', stack + 'px');

    // The System Notice pills hide while its popup is open and come back after,
    // so re-measure whenever that changes.
    if (snPills && snPills !== observedPills && window.MutationObserver) {
      observedPills = snPills;
      new MutationObserver(updateOffsets).observe(snPills, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  // True while the System Notice or the Beta Testing Guide popup is on screen.
  function systemPopupOpen() {
    var list = document.querySelectorAll('#system-notice-root .sn-backdrop');
    for (var i = 0; i < list.length; i++) if (!list[i].hidden) return true;
    return false;
  }

  function onKey(e) {
    if (!modalOpen) return;
    if (e.key === 'Escape') { userClose(); return; }
    if (e.key !== 'Tab') return;
    var f = ui.dialog.querySelectorAll('button');
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openModal() {
    if (!alerting || modalOpen) return;
    buildUi();
    modalOpen = true;
    lastFocus = document.activeElement;
    document.documentElement.classList.add('sh-lock');
    document.addEventListener('keydown', onKey);
    ui.pill.hidden = true;
    clearTimeout(ui.hideTimer);
    ui.backdrop.hidden = false;
    void ui.backdrop.offsetWidth; // let the transition run
    ui.backdrop.classList.add('sh-open');
    var primary = ui.dialog.querySelector('.sh-btn');
    if (primary) { try { primary.focus({ preventScroll: true }); } catch (e) { primary.focus(); } }
    ui.dialog.scrollTop = 0;
  }

  // Shared by "visitor closed it" and "outage ended". Does not touch the pill.
  function hideModal() {
    if (!modalOpen) return;
    modalOpen = false;
    ui.backdrop.classList.remove('sh-open');
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(function () { ui.backdrop.hidden = true; }, 250);
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('sh-lock');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
  }

  // The visitor closed the popup: remember that for this outage, leave the pill.
  function userClose() {
    if (!modalOpen) return;
    dismissed = true;
    put(DISMISS_KEY);
    hideModal();
    ui.pill.hidden = false;
    updateOffsets();
  }

  function showPill() {
    if (!alerting) return;
    buildUi();
    ui.pill.hidden = false;
    updateOffsets();
  }

  // Auto-open, but never on top of the System Notice / Beta Testing Guide: wait
  // until the visitor has closed it, then show this one.
  function openWhenClear() {
    if (!alerting || dismissed || modalOpen) { stopWaiting(); return; }
    if (systemPopupOpen()) {
      if (!waitTimer) waitTimer = setInterval(openWhenClear, 500);
      return;
    }
    stopWaiting();
    openModal();
  }
  function stopWaiting() { if (waitTimer) { clearInterval(waitTimer); waitTimer = null; } }

  function setAlert(on) {
    if (on) {
      alerting = true;
      // Pill only (no popup) when the visitor already closed it during this
      // outage (on this page or an earlier one in this tab), or when this is a
      // quick relapse after an outage they had seen and closed.
      if (dismissed || recent(DISMISS_KEY, DISMISS_TTL_MS) || recent(RECOVERED_KEY, RELAPSE_WINDOW_MS)) {
        dismissed = true;
        put(DISMISS_KEY);
        showPill();
      } else {
        openWhenClear();
      }
      return;
    }
    // Recovered. Only an outage the visitor actually closed counts as "seen";
    // one that cleared on its own unread leaves no relapse window behind.
    var seen = dismissed || recent(DISMISS_KEY, DISMISS_TTL_MS);
    alerting = false;
    dismissed = false;
    drop(DISMISS_KEY);
    if (seen) put(RECOVERED_KEY); else drop(RECOVERED_KEY);
    stopWaiting();
    if (ui) { hideModal(); ui.pill.hidden = true; }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pendingWhileHidden) {
      pendingWhileHidden = false;
      run();
    }
  });
  window.addEventListener('offline', function () { fails = 0; });
  window.addEventListener('online', function () {
    fails = 0;
    backoffStep = 0;
    if (!running && !document.hidden) schedule(1500); // re-verify soon after the connection returns
  });

  var started = false;
  function start() {
    if (started) return;
    started = true;
    schedule(FIRST_CHECK_DELAY_MS);
  }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();