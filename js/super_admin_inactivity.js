import { portalSupabase as supabase } from './supabase.js';
import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';

const INACTIVITY_LIMIT = 2 * 60 * 60 * 1000;
//const INACTIVITY_LIMIT = 20 * 1000; // 20 seconds for testing

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

    let timeout;

    function resetTimer() {
        clearTimeout(timeout);
        timeout = setTimeout(async () => {
            // Stop listening for activity once the timeout has fired —
            // otherwise a click on the modal's own OK button would bubble
            // to document and reschedule a fresh timer mid-logout.
            ["click", "mousemove", "keydown", "scroll"].forEach(event => {
                document.removeEventListener(event, resetTimer);
            });
            await showInactivityModal();
            // watchAuthState()'s SIGNED_OUT listener (registered on every
            // admin page) already navigates after signOut(). Setting this
            // override instead of calling our own window.location here
            // avoids a double-redirect race — signOut() fires SIGNED_OUT
            // almost immediately, so two separate navigation calls back
            // to back is what was making this redirect feel slow.
            window.__nextSignOutRedirect = '/admin';
            await supabase.auth.signOut();
        }, INACTIVITY_LIMIT);
    }

    ["click", "mousemove", "keydown", "scroll"].forEach(event => {
        document.addEventListener(event, resetTimer);
    });

    resetTimer();
}