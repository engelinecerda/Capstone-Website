// js/admin_payment_methods.js
import { portalSupabase as supabase } from './supabase.js';
import { uploadToCloudinary }         from './cloudinary_payment_methods.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const addPaymentMethodBtn   = document.getElementById('addPaymentMethodBtn');
const addPmModal            = document.getElementById('addPaymentMethodModal');
const addPmClose            = document.getElementById('addPmClose');
const addPmCancel           = document.getElementById('addPmCancel');
const addPmSave             = document.getElementById('addPmSave');
const addPmMsg              = document.getElementById('addPmMsg');

const pmAccountName         = document.getElementById('pmAccountName');
const pmAccountNumber       = document.getElementById('pmAccountNumber');
const pmModeOfPayment       = document.getElementById('pmModeOfPayment');
const pmFileInput           = document.getElementById('pmFileInput');
const pmFileZone            = document.getElementById('pmFileZone');
const pmFileChosen          = document.getElementById('pmFileChosen');
const pmFileName            = document.getElementById('pmFileName');
const pmFileClear           = document.getElementById('pmFileClear');
const pmQrPreview           = document.getElementById('pmQrPreview');
const pmQrPreviewImg        = document.getElementById('pmQrPreviewImg');
const pmQrPreviewClear      = document.getElementById('pmQrPreviewClear');

const pmProgressWrap        = document.getElementById('pmProgressWrap');
const pmProgressLabel       = document.getElementById('pmProgressLabel');
const pmProgressPct         = document.getElementById('pmProgressPct');
const pmProgressBar         = document.getElementById('pmProgressBar');

const togglePaymentMethodsBtn   = document.getElementById('togglePaymentMethodsBtn');
const togglePaymentMethodsLabel = document.getElementById('togglePaymentMethodsLabel');
const paymentMethodsSection     = document.getElementById('paymentMethodsSection');
const paymentMethodsBody        = document.getElementById('paymentMethodsBody');
const paymentMethodsMessage     = document.getElementById('paymentMethodsMessage');

const submittedPaymentsCard = document.getElementById('submittedPaymentsCard');
const paymentStatRow        = document.getElementById('paymentStatRow');
const paymentToolbarGrid    = document.getElementById('paymentToolbarGrid');

// ── State ─────────────────────────────────────────────────────────────────────
let methodsVisible   = false;
let methodsLoaded    = false;
let methodsCache     = [];
let previewObjectUrl = null;

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── Message helpers ───────────────────────────────────────────────────────────
function showMsg(text, type = 'error') {
  if (!addPmMsg) return;
  addPmMsg.textContent = text;
  addPmMsg.className   = `pm-msg ${type}`;
}

function hideMsg() {
  if (!addPmMsg) return;
  addPmMsg.className   = 'pm-msg hidden';
  addPmMsg.textContent = '';
}

function setMethodsMessage(msg, isError = false) {
  if (!paymentMethodsMessage) return;
  paymentMethodsMessage.textContent = msg;
  paymentMethodsMessage.classList.toggle('error', isError);
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(pct, label = '') {
  if (!pmProgressWrap) return;
  pmProgressWrap.classList.remove('hidden');
  pmProgressBar.style.width   = `${pct}%`;
  pmProgressPct.textContent   = `${pct}%`;
  pmProgressLabel.textContent = label || 'Uploading…';
}

function hideProgress() {
  if (!pmProgressWrap) return;
  pmProgressWrap.classList.add('hidden');
  pmProgressBar.style.width   = '0%';
  pmProgressPct.textContent   = '0%';
  pmProgressLabel.textContent = 'Uploading…';
}

// ── QR Preview ────────────────────────────────────────────────────────────────
function showQrPreview(src) {
  if (!pmQrPreview || !pmQrPreviewImg) return;
  pmQrPreviewImg.src = src;
  pmQrPreview.classList.remove('hidden');
}

function hideQrPreview() {
  if (!pmQrPreview) return;
  pmQrPreview.classList.add('hidden');
  if (pmQrPreviewImg) pmQrPreviewImg.src = '';
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function clearFileSelection() {
  if (pmFileInput)  pmFileInput.value      = '';
  if (pmFileName)   pmFileName.textContent = 'No file chosen';
  if (pmFileChosen) pmFileChosen.classList.add('hidden');
  hideQrPreview();
}

// ── Modal open / close ────────────────────────────────────────────────────────
function openModal() {
  resetModal();
  addPmModal?.classList.remove('hidden');
  addPmModal?.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  addPmModal?.classList.add('hidden');
  addPmModal?.setAttribute('aria-hidden', 'true');
}

function resetModal() {
  if (pmAccountName)   pmAccountName.value   = '';
  if (pmAccountNumber) pmAccountNumber.value  = '';
  if (pmModeOfPayment) pmModeOfPayment.value  = '';
  clearFileSelection();
  hideProgress();
  hideMsg();
  if (addPmSave) addPmSave.disabled = false;
}

// ── File zone ─────────────────────────────────────────────────────────────────
pmFileZone?.addEventListener('click', () => pmFileInput?.click());

pmFileZone?.addEventListener('dragover', (e) => {
  e.preventDefault();
  pmFileZone.classList.add('drag-over');
});

pmFileZone?.addEventListener('dragleave', () => {
  pmFileZone.classList.remove('drag-over');
});

pmFileZone?.addEventListener('drop', (e) => {
  e.preventDefault();
  pmFileZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) applyFile(file);
});

pmFileInput?.addEventListener('change', () => {
  const file = pmFileInput.files[0];
  if (file) applyFile(file);
});

function applyFile(file) {
  if (pmFileName)   pmFileName.textContent = file.name;
  if (pmFileChosen) pmFileChosen.classList.remove('hidden');

  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(file);
  showQrPreview(previewObjectUrl);
}

pmFileClear?.addEventListener('click', clearFileSelection);
pmQrPreviewClear?.addEventListener('click', clearFileSelection);

// ── Upload to Cloudinary ──────────────────────────────────────────────────────
async function doCloudinaryUpload(file) {
  const safeName = file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const publicId = `payment-methods/${Date.now()}_${safeName}`;

  setProgress(0, 'Uploading to Cloudinary…');

  const { secureUrl } = await uploadToCloudinary(file, {
    publicId,
    onProgress: (pct) => setProgress(pct, `Uploading… ${pct}%`),
  });

  setProgress(100, 'Upload complete');
  return secureUrl;
}

// ── Save handler ──────────────────────────────────────────────────────────────
addPmSave?.addEventListener('click', async () => {
  hideMsg();
  hideProgress();

  const accountName   = pmAccountName?.value.trim()   || '';
  const accountNumber = pmAccountNumber?.value.trim()  || '';
  const modeOfPayment = pmModeOfPayment?.value.trim()  || '';
  const file          = pmFileInput?.files[0] ?? null;

  if (!accountName)   { showMsg('Account name is required.');          return; }
  if (!accountNumber) { showMsg('Phone / account number is required.'); return; }
  if (!modeOfPayment) { showMsg('Please select a mode of payment.');   return; }

  showMsg('Saving payment method…', 'info');
  addPmSave.disabled = true;

  try {
    let qrImageUrl = null;

    if (file) {
      showMsg('Uploading QR image…', 'info');
      qrImageUrl = await doCloudinaryUpload(file);
      showMsg('Image uploaded. Saving record…', 'info');
    }

    const { error: insertErr } = await supabase
      .from('payment_method')
      .insert({
        account_name:             accountName,
        'phone/account_number': accountNumber,
        mode_of_payment:          modeOfPayment,
        qr_image:                 qrImageUrl,
      });

    if (insertErr) throw insertErr;

    hideProgress();
    showMsg('Payment method saved successfully!', 'success');
    refreshMethodsIfVisible();

    setTimeout(closeModal, 1400);

  } catch (err) {
    hideProgress();
    showMsg(err.message || 'Failed to save payment method. Please try again.');
  } finally {
    addPmSave.disabled = false;
  }
});

// ── Wire modal ────────────────────────────────────────────────────────────────
addPaymentMethodBtn?.addEventListener('click', openModal);
addPmClose?.addEventListener('click', closeModal);
addPmCancel?.addEventListener('click', closeModal);

addPmModal?.addEventListener('click', (e) => {
  if (e.target === addPmModal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && addPmModal && !addPmModal.classList.contains('hidden')) {
    closeModal();
  }
});

// ══════════════════════════════════════════════════════════════
// PAYMENT METHODS TABLE + TOGGLE
// ══════════════════════════════════════════════════════════════

function methodMatchesSearch(method, term) {
  if (!term) return true;
  const haystack = [
    method.account_name,
    method['phone / account_number'],
    method.mode_of_payment,
  ]
    .filter(Boolean)
    .map(val => String(val).toLowerCase());

  return haystack.some(val => val.includes(term));
}

function renderMethodRows(list) {
  if (!paymentMethodsBody) return;

  if (!list.length) {
    paymentMethodsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No payment methods matched your search.</td>
      </tr>
    `;
    return;
  }

  paymentMethodsBody.innerHTML = list.map((method) => {
    const modeKey   = String(method.mode_of_payment || '').toLowerCase().replace(/\s+/g, '');
    const modeLabel = method.mode_of_payment || '—';
    const added     = method.created_at
      ? new Date(method.created_at).toLocaleDateString('en-PH', {
          year: 'numeric', month: 'short', day: 'numeric'
        })
      : '—';

    let pillClass = '';
    if (modeKey === 'gcash')      pillClass = 'gcash';
    else if (modeKey === 'maya')  pillClass = 'maya';
    else if (modeKey === 'cash')  pillClass = 'cash';

    return `
      <tr class="reservation-row">
        <td data-label="Account Name">
          <div class="table-main">${escHtml(method.account_name || '—')}</div>
        </td>
        <td data-label="Phone / Account No.">
          <span class="table-main">${escHtml(method['phone/account_number'] || '—')}</span>
        </td>
        <td data-label="Mode of Payment">
          <span class="pm-mode-pill ${escHtml(pillClass)}">${escHtml(modeLabel)}</span>
        </td>
        <td data-label="QR Code">
          ${method.qr_image
            ? `<img class="pm-qr-thumb" src="${escHtml(method.qr_image)}" alt="QR code for ${escHtml(method.account_name || 'payment method')}" loading="lazy" />`
            : `<span class="pm-no-qr">No QR image</span>`
          }
        </td>
        <td data-label="Added">
          <span class="table-sub">${escHtml(added)}</span>
        </td>
        <td data-label="Actions">
          <div class="pm-action-cell" style="justify-content: center;">
            ${method.qr_image
              ? `<a class="action-btn" href="${escHtml(method.qr_image)}" target="_blank" rel="noopener noreferrer">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  View QR
                </a>`
              : ''
            }
            <button
              class="action-btn pm-delete-btn"
              data-id="${escHtml(method.payment_method_id)}"
              data-name="${escHtml(method.account_name || 'this payment method')}"
            >
              <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
              Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterMethods() {
  const searchInput = document.getElementById('pmSearchInput');
  const term = String(searchInput?.value || '').trim().toLowerCase();
  const filtered = methodsCache.filter(m => methodMatchesSearch(m, term));

  renderMethodRows(filtered);

  setMethodsMessage(
    filtered.length === methodsCache.length
      ? `Showing ${methodsCache.length} payment method${methodsCache.length === 1 ? '' : 's'}.`
      : `Showing ${filtered.length} of ${methodsCache.length} payment method${methodsCache.length === 1 ? '' : 's'}.`
  );
}

function renderMethodsToolbar() {
  if (document.getElementById('pmSearchInput')) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'pm-toolbar';
  toolbar.innerHTML = `
    <label class="pm-search-wrap">
      <span class="pm-search-icon">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </span>
      <input
        id="pmSearchInput"
        type="text"
        placeholder="Search by account name, number, or payment mode…"
        class="pm-search-input"
      />
    </label>
    <button type="button" class="pm-refresh-btn" id="pmRefreshBtn" title="Refresh payment methods">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"/>
        <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"/>
      </svg>
    </button>
  `;

  const tableWrap = paymentMethodsSection?.querySelector('.table-wrap');
  if (tableWrap) {
    paymentMethodsSection.insertBefore(toolbar, tableWrap);
  }

  document.getElementById('pmSearchInput')
    ?.addEventListener('input', filterMethods);

  document.getElementById('pmRefreshBtn')
    ?.addEventListener('click', async () => {
      methodsLoaded = false;
      methodsCache  = [];
      const si = document.getElementById('pmSearchInput');
      if (si) si.value = '';
      await loadPaymentMethods();
    });
}

async function loadPaymentMethods() {
  setMethodsMessage('Loading payment methods...');

  if (paymentMethodsBody) {
    paymentMethodsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">Loading…</td>
      </tr>
    `;
  }

  try {
    const { data, error } = await supabase
      .from('payment_method')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    methodsCache = data || [];

    renderMethodsToolbar();

    if (!methodsCache.length) {
      paymentMethodsBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">No payment methods have been added yet.</td>
        </tr>
      `;
      setMethodsMessage('');
      methodsLoaded = true;
      return;
    }

    renderMethodRows(methodsCache);

    setMethodsMessage(
      `Showing ${methodsCache.length} payment method${methodsCache.length === 1 ? '' : 's'}.`
    );

    methodsLoaded = true;

  } catch (err) {
    if (paymentMethodsBody) {
      paymentMethodsBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">Failed to load payment methods.</td>
        </tr>
      `;
    }
    setMethodsMessage(`Failed to load payment methods: ${err.message}`, true);
  }
}

// ── Show payments view (default) ──────────────────────────────
function showPaymentsView() {
  submittedPaymentsCard?.classList.remove('section-hidden');
  paymentStatRow?.classList.remove('section-hidden');
  paymentToolbarGrid?.classList.remove('section-hidden');

  paymentMethodsSection?.classList.add('hidden');

  togglePaymentMethodsBtn?.classList.remove('showing-methods');
  if (togglePaymentMethodsLabel) {
    togglePaymentMethodsLabel.textContent = 'View Payment Methods';
  }

  methodsVisible = false;
}

// ── Show payment methods view ─────────────────────────────────
async function showMethodsView() {
  submittedPaymentsCard?.classList.add('section-hidden');
  paymentStatRow?.classList.add('section-hidden');
  paymentToolbarGrid?.classList.add('section-hidden');

  paymentMethodsSection?.classList.remove('hidden');

  togglePaymentMethodsBtn?.classList.add('showing-methods');
  if (togglePaymentMethodsLabel) {
    togglePaymentMethodsLabel.textContent = 'Show Payment Submissions';
  }

  methodsVisible = true;

  if (!methodsLoaded) {
    await loadPaymentMethods();
  }
}

// ── Delete handler ────────────────────────────────────────────
paymentMethodsBody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pm-delete-btn');
  if (!btn) return;

  const methodId   = btn.dataset.id;
  const methodName = btn.dataset.name;

  if (!confirm(`Delete "${methodName}"?\n\nThis cannot be undone.`)) return;

  btn.disabled = true;
  btn.textContent = 'Deleting…';

  try {
    const { error } = await supabase
      .from('payment_method')
      .delete()
      .eq('payment_method_id', methodId);

    if (error) throw error;

    methodsCache = methodsCache.filter(m => m.payment_method_id !== methodId);
    renderMethodRows(methodsCache);
    setMethodsMessage(
      methodsCache.length
        ? `Showing ${methodsCache.length} payment method${methodsCache.length === 1 ? '' : 's'}.`
        : ''
    );

    if (!methodsCache.length) {
      paymentMethodsBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">No payment methods have been added yet.</td>
        </tr>
      `;
    }

  } catch (err) {
    alert('Failed to delete payment method: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
});

// ── Toggle handler ────────────────────────────────────────────
togglePaymentMethodsBtn?.addEventListener('click', async () => {
  if (methodsVisible) {
    showPaymentsView();
  } else {
    await showMethodsView();
  }
});

// ── Re-load after save ───────────────────────────────────────
export function refreshMethodsIfVisible() {
  if (methodsVisible) {
    methodsLoaded = false;
    methodsCache  = [];

    const si = document.getElementById('pmSearchInput');
    if (si) si.value = '';

    loadPaymentMethods();
  }
}