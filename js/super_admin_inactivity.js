import { portalSupabase as supabase } from './supabase.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

const INACTIVITY_LIMIT = 2 * 60 * 60 * 1000;
//const INACTIVITY_LIMIT = 20 * 1000; // 20 seconds for testing

// Timestamp of the admin's last activity, shared by every open admin tab
// through localStorage. A per-tab timer alone cannot see activity in another
// tab, never runs while a tab is closed, and pauses while the computer sleeps;
// comparing against this shared timestamp makes all of those cases follow the
// same INACTIVITY_LIMIT, counted from the last activity anywhere.
// Cleared on sign-out (below) and right before a new admin login
// (js/admin_login.js) so a stale value from an earlier session can never log a
// freshly signed-in admin straight out.
const LAST_ACTIVITY_KEY = 'eli-admin-last-activity';

// Activity (mousemove especially) fires constantly; writing at most this often
// keeps localStorage writes negligible. The timer is only ever this much early.
const ACTIVITY_WRITE_INTERVAL = 5000;

function readLastActivity() {
    try {
        const value = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch (_) {
        return null;
    }
}

function writeLastActivity(timestamp) {
    try { localStorage.setItem(LAST_ACTIVITY_KEY, String(timestamp)); } catch (_) { /* storage unavailable */ }
}

function clearLastActivity() {
    try { localStorage.removeItem(LAST_ACTIVITY_KEY); } catch (_) { /* storage unavailable */ }
}

// Injects scoped styles once. This is self-contained (not relying on
// css/modals.css or any page-specific stylesheet) because
// setupInactivityLogout() is imported into many different admin pages —
// dashboard, announcements, reservations, business profile, etc. — and
// we can't assume any particular CSS file is loaded on all of them.
// Class names are prefixed "inactivity-modal-" to avoid colliding with
// each page's own modal styles.
function injectInactivityModalStyles() {
    if (document.getElementById('inactivityModalStyles')) return;
    const style = document.createElement('style');
    style.id = 'inactivityModalStyles';
    style.textContent = `
        .inactivity-modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(30, 12, 3, 0.55);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            animation: inactivityModalFadeIn 0.2s ease;
        }
        .inactivity-modal-card {
            background: #FFFFFF;
            border-radius: 14px;
            padding: 28px 30px;
            width: 90%;
            max-width: 380px;
            box-shadow: 0 10px 30px rgba(42, 18, 8, 0.25);
            text-align: center;
            font-family: inherit;
        }
        .inactivity-modal-card h3 {
            margin: 0 0 10px;
            color: #4A2C17;
            font-size: 18px;
        }
        .inactivity-modal-card p {
            margin: 0 0 22px;
            color: #6B5A47;
            font-size: 14px;
            line-height: 1.5;
        }
        .inactivity-modal-btn {
            background: #4A2C17;
            color: #FFFFFF;
            border: none;
            border-radius: 8px;
            padding: 10px 26px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.15s ease;
        }
        .inactivity-modal-btn:hover {
            background: #6B3F23;
        }
        @keyframes inactivityModalFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
    `;
    document.head.appendChild(style);
}

// Shows the branded modal in place of a native alert() and resolves once
// the admin dismisses it, so the caller only proceeds to sign out after
// acknowledgement.
function showInactivityModal() {
    return new Promise((resolve) => {
        injectInactivityModalStyles();

        const overlay = document.createElement('div');
        overlay.className = 'inactivity-modal-overlay';
        overlay.innerHTML = `
            <div class="inactivity-modal-card" role="alertdialog" aria-modal="true" aria-labelledby="inactivityModalTitle">
                <h3 id="inactivityModalTitle">Session expired</h3>
                <p>You've been logged out due to inactivity.</p>
                <button type="button" class="inactivity-modal-btn">OK</button>
            </div>
        `;
        document.body.appendChild(overlay);
        lockBodyScroll();

        overlay.querySelector('.inactivity-modal-btn').addEventListener('click', () => {
            overlay.remove();
            unlockBodyScroll();
            resolve();
        });
    });
}

export function setupInactivityLogout(role) {
    if (role !== "admin") return;

    const ACTIVITY_EVENTS = ["click", "mousemove", "keydown", "scroll"];
    let timeout;
    let expired = false;
    let lastWritten = 0;

    // Any admin tab ending the session (manual logout, expiry, session lost)
    // clears the shared timestamp.
    supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') clearLastActivity();
    });

    function onActivity() {
        if (expired) return;
        const now = Date.now();
        if (now - lastWritten < ACTIVITY_WRITE_INTERVAL) return;
        lastWritten = now;
        writeLastActivity(now);
        schedule();
    }

    // Sets the timer for the time left since the last activity in ANY tab,
    // not a fresh full limit.
    function schedule() {
        clearTimeout(timeout);
        const last = readLastActivity() ?? Date.now();
        const remaining = INACTIVITY_LIMIT - Math.max(0, Date.now() - last);
        timeout = setTimeout(checkExpiry, Math.max(remaining, 0));
    }

    // Runs when the timer fires and whenever the tab is shown again (a timer in
    // a background tab can fire late, and does not run at all while the
    // computer sleeps). Another tab may have been active in the meantime, so
    // the shared timestamp decides, not this tab's own timer.
    function checkExpiry() {
        if (expired) return;
        const last = readLastActivity();
        if (last !== null && Date.now() - last < INACTIVITY_LIMIT) {
            schedule();
            return;
        }
        expire();
    }

    function onVisibilityChange() {
        if (document.visibilityState === 'visible') checkExpiry();
    }

    function stopListening() {
        ACTIVITY_EVENTS.forEach(event => {
            document.removeEventListener(event, onActivity);
        });
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('focus', checkExpiry);
        window.removeEventListener('pageshow', checkExpiry);
    }

    async function expire() {
        if (expired) return;
        expired = true;
        clearTimeout(timeout);
        // Stop listening for activity once the timeout has fired —
        // otherwise a click on the modal's own OK button would bubble
        // to document and reschedule a fresh timer mid-logout.
        stopListening();
        await showInactivityModal();
        // watchAuthState()'s SIGNED_OUT listener (registered on every
        // admin page) already navigates after signOut(). Setting this
        // override instead of calling our own window.location here
        // avoids a double-redirect race — signOut() fires SIGNED_OUT
        // almost immediately, so two separate navigation calls back
        // to back is what was making this redirect feel slow.
        window.__nextSignOutRedirect = '/admin';
        await supabase.auth.signOut();
    }

    ACTIVITY_EVENTS.forEach(event => {
        document.addEventListener(event, onActivity);
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', checkExpiry);
    window.addEventListener('pageshow', checkExpiry);

    // Page load: a closed tab or a long-idle session is judged against the
    // stored timestamp; with none stored, this load starts the clock.
    if (readLastActivity() === null) {
        lastWritten = Date.now();
        writeLastActivity(lastWritten);
        schedule();
    } else {
        checkExpiry();
    }
}
