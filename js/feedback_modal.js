// js/feedback_modal.js
// Single shared modal for all customer-facing user feedback (success,
// error, warning, info, and confirm-style yes/no dialogs) — replaces
// console-only messaging and native alert()/confirm() calls across the
// site. Lazily injects its own markup + stylesheet into the page on first
// use (same pattern as the admin hamburger menu in
// js/admin_sidebar_counts.js), so no HTML file needs to carry modal markup.

const ICON_CLASS = {
    success: 'ti-circle-check',
    error: 'ti-circle-x',
    warning: 'ti-alert-triangle',
    info: 'ti-info-circle'
};

let dom = null;
let activeResolve = null;
let lastFocusedEl = null;
let dismissible = true;

function ensureIconFont() {
    const hasTabler = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .some((link) => link.href.includes('tabler-icons'));
    if (hasTabler) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css';
    document.head.appendChild(link);
}

function ensureStylesheet() {
    if (document.querySelector('link[data-feedback-modal]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/feedback_modal.css';
    link.setAttribute('data-feedback-modal', '');
    document.head.appendChild(link);
}

function trapFocus(event) {
    const focusable = dom.card.querySelectorAll(
        'button:not([hidden]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function resolveAndClose(result) {
    if (!dom) return;
    dom.backdrop.classList.remove('is-open');
    dom.backdrop.setAttribute('aria-hidden', 'true');
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
        lastFocusedEl.focus();
    }
    const resolve = activeResolve;
    activeResolve = null;
    if (resolve) resolve(result);
}

function ensureDom() {
    if (dom) return dom;
    ensureStylesheet();
    ensureIconFont();

    const backdrop = document.createElement('div');
    backdrop.className = 'fm-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.innerHTML = `
        <div class="fm-card" tabindex="-1">
            <div class="fm-icon" aria-hidden="true"><i class="ti"></i></div>
            <h2 class="fm-title" id="fm-modal-title"></h2>
            <p class="fm-message" id="fm-modal-message"></p>
            <div class="fm-actions">
                <button type="button" class="fm-btn fm-btn-secondary fm-cancel-btn" hidden></button>
                <button type="button" class="fm-btn fm-btn-primary fm-confirm-btn"></button>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    dom = {
        backdrop,
        card: backdrop.querySelector('.fm-card'),
        icon: backdrop.querySelector('.fm-icon'),
        iconGlyph: backdrop.querySelector('.fm-icon i'),
        title: backdrop.querySelector('.fm-title'),
        message: backdrop.querySelector('.fm-message'),
        cancelBtn: backdrop.querySelector('.fm-cancel-btn'),
        confirmBtn: backdrop.querySelector('.fm-confirm-btn')
    };

    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop && dismissible) resolveAndClose(false);
    });
    backdrop.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && dismissible) {
            event.preventDefault();
            resolveAndClose(false);
            return;
        }
        if (event.key === 'Tab') trapFocus(event);
    });
    dom.cancelBtn.addEventListener('click', () => resolveAndClose(false));
    dom.confirmBtn.addEventListener('click', () => resolveAndClose(true));

    return dom;
}

/**
 * showFeedbackModal({ type, title, message, confirmText, cancelText, destructive })
 *
 * type: "success" | "error" | "warning" | "info" (default "info")
 * cancelText: omit for a single-button acknowledgement modal; provide it
 *   to get a two-button confirm-style dialog (resolves true on confirm,
 *   false on cancel/dismiss).
 * destructive: when true (and cancelText is set), the confirm button is
 *   styled as a destructive action and the dialog can ONLY be closed via
 *   an explicit button click — Escape and backdrop click are disabled so
 *   a stray keypress/click can't silently confirm or dismiss it.
 *
 * Returns a Promise<boolean> — true if the user confirmed/acknowledged,
 * false if they cancelled or dismissed the dialog.
 */
export function showFeedbackModal({
    type = 'info',
    title = '',
    message = '',
    confirmText = 'OK',
    cancelText = null,
    destructive = false
} = {}) {
    const el = ensureDom();

    // A modal is already open — resolve it as dismissed before opening the
    // new one so no caller is left awaiting forever.
    if (activeResolve) resolveAndClose(false);

    lastFocusedEl = document.activeElement;
    dismissible = !(cancelText && destructive);

    el.icon.className = `fm-icon fm-${type}`;
    el.iconGlyph.className = `ti ${ICON_CLASS[type] || ICON_CLASS.info}`;
    el.title.textContent = title;
    el.message.textContent = message;

    el.confirmBtn.textContent = confirmText;
    el.confirmBtn.className = `fm-btn fm-btn-primary fm-confirm-btn${destructive ? ' fm-danger' : ''}`;

    if (cancelText) {
        el.cancelBtn.hidden = false;
        el.cancelBtn.textContent = cancelText;
    } else {
        el.cancelBtn.hidden = true;
    }

    el.backdrop.setAttribute('role', cancelText ? 'alertdialog' : 'dialog');
    el.backdrop.setAttribute('aria-modal', 'true');
    el.backdrop.setAttribute('aria-labelledby', 'fm-modal-title');
    el.backdrop.setAttribute('aria-describedby', 'fm-modal-message');
    el.backdrop.setAttribute('aria-hidden', 'false');
    el.backdrop.classList.add('is-open');

    // For a destructive confirm, focus the safe "Cancel" action by default
    // so a stray Enter keypress can't trigger the destructive one.
    requestAnimationFrame(() => {
        (destructive && !el.cancelBtn.hidden ? el.cancelBtn : el.confirmBtn).focus();
    });

    return new Promise((resolve) => {
        activeResolve = resolve;
    });
}

// Convenience wrapper for the common "replace a native confirm()" case.
export function showConfirmModal({
    title = 'Please confirm',
    message = '',
    confirmText = 'Yes, continue',
    cancelText = 'Cancel',
    destructive = false,
    type = 'warning'
} = {}) {
    return showFeedbackModal({ type, title, message, confirmText, cancelText, destructive });
}
