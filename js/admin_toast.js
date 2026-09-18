// admin_toast.js — BUG-06 fix: lightweight, non-blocking success/error
// acknowledgment for admin save actions across the admin portal.
//
// Complements js/feedback_modal.js rather than replacing it — that's a
// blocking modal for customer-facing flows that genuinely need an explicit
// dismiss (e.g. a destructive-action confirmation); a routine "yes, that
// saved" shouldn't stop the admin from continuing to work. Before this,
// most admin save actions (especially every modal-based add/edit/remove/
// reorder on the Page Content and Business Profile CMS pages) gave no
// success feedback at all beyond a modal silently closing, or at best a
// small 12.5px inline .form-message text easy to miss on a long page.
//
// Lazily injects its own markup + stylesheet on first use — same pattern
// as feedback_modal.js — so no admin HTML file needs to carry any markup
// for this.

let stack = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function ensureStack() {
  if (stack) return stack;

  const style = document.createElement('style');
  style.textContent = `
    .admin-toast-stack {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 5000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
      max-width: calc(100vw - 40px);
    }
    .admin-toast {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 240px;
      max-width: 380px;
      padding: 12px 14px;
      border-radius: 10px;
      background: #fff;
      border: 0.5px solid rgba(61,26,10,0.10);
      box-shadow: 0 8px 24px rgba(42,18,8,0.16);
      font: 13px/1.4 inherit;
      color: #3E2418;
      pointer-events: auto;
      opacity: 0;
      transform: translateX(16px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .admin-toast.show { opacity: 1; transform: translateX(0); }
    .admin-toast i.admin-toast-icon { font-size: 17px; flex-shrink: 0; }
    .admin-toast.success i.admin-toast-icon { color: #3B6D11; }
    .admin-toast.error   i.admin-toast-icon { color: #A32D2D; }
    .admin-toast-msg { flex: 1; min-width: 0; word-break: break-word; }
    .admin-toast-close {
      background: none;
      border: none;
      cursor: pointer;
      color: #8A7965;
      padding: 3px;
      line-height: 1;
      flex-shrink: 0;
      border-radius: 6px;
    }
    .admin-toast-close:hover { color: #3E2418; background: rgba(61,26,10,0.06); }
    @media (max-width: 480px) {
      .admin-toast-stack { left: 16px; right: 16px; top: 12px; }
      .admin-toast { max-width: none; min-width: 0; }
    }
  `;
  document.head.appendChild(style);

  stack = document.createElement('div');
  stack.className = 'admin-toast-stack';
  document.body.appendChild(stack);
  return stack;
}

const ICON_BY_TYPE = { success: 'ti-circle-check', error: 'ti-circle-x' };

// type: 'success' | 'error'. duration in ms (0 = stays until dismissed).
export function showToast(message, type = 'success', duration = 4000) {
  const el = document.createElement('div');
  el.className = `admin-toast ${type}`;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <i class="ti ${ICON_BY_TYPE[type] || ICON_BY_TYPE.success} admin-toast-icon" aria-hidden="true"></i>
    <span class="admin-toast-msg">${escapeHtml(message)}</span>
    <button type="button" class="admin-toast-close" aria-label="Dismiss">
      <i class="ti ti-x" aria-hidden="true"></i>
    </button>
  `;
  ensureStack().appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.admin-toast-close').addEventListener('click', dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
}
