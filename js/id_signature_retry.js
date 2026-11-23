// "Signature check" retry modal on the customer's reservation page.
//
// When a reservation is submitted, the signature on the customer's ID is
// compared with the e-signature they drew. If they don't match, the contract
// stays pending and the customer comes here to try again, two ways:
//
//   reupload  Re-check the ID saved on the customer's profile, or choose a
//             different photo (which replaces the saved one). The signature
//             already saved on the contract is compared with it (Edge Function
//             `verify-id-signature`).
//   resign    Draw the signature again. It is compared with the ID saved on the
//             profile (or a photo chosen here, when none is saved yet) and a new
//             signature that matches replaces the old one on the contract
//             (`generate-signed-contract`, resign: true).
//
// The ID lives on My Profile (js/valid_id.js); a photo chosen in this modal is
// saved there, replacing any previous one.
//
// A match approves the contract. Anything else leaves it pending, with the
// reason shown here. The server caps the number of automatic checks
// (MAX_ID_CHECK_ATTEMPTS in supabase/functions/_shared/id_signature_check.ts);
// after that a person reviews the contract by hand.
//
// The modal markup is static in reservation-details.html (outside the
// re-rendered page container, so auto-refresh never wipes a half-filled form).

import { lockBodyScroll, unlockBodyScroll } from './modal_scroll_lock.js';
import { getIdFileError, resizeIdImage, fetchValidIdStatus, saveValidId } from './valid_id.js';

// Contract states the customer can act on. 'error' = the automatic check itself
// failed at submission, so they may simply try it again. Keep in sync with
// RETRYABLE_VERDICTS in the shared Edge Function module.
const RETRYABLE_STATES = ['mismatch', 'no_id_signature', 'unclear_id', 'unclear_signature', 'error'];
export const MAX_ID_CHECK_ATTEMPTS = 5;

const STATE_REASONS = {
    mismatch: 'The signature on your ID doesn\u2019t match the signature you drew.',
    no_id_signature: 'We couldn\u2019t find a signature on your ID photo.',
    unclear_id: 'Your ID photo is too blurry, dark or cropped to read.',
    unclear_signature: 'Your drawn signature is too small or unclear to compare.',
    error: 'We couldn\u2019t run the automatic signature check.'
};

const STATE_NEXT_STEPS = {
    mismatch: 'Upload a different photo of your ID, or sign again.',
    no_id_signature: 'Upload a clear photo of a valid ID that shows your signature.',
    unclear_id: 'Upload a clearer photo of your ID.',
    unclear_signature: 'Sign again, a little larger and more clearly.',
    error: 'You can try the check again.'
};

// What the page needs to know about the contract's ID check, or null when
// there's nothing for the customer to do.
export function getIdCheckState(contract) {
    if (!contract) return null;
    if (String(contract.review_status || '').toLowerCase() !== 'pending_review') return null;

    const status = String(contract.id_check_status || '');
    if (!RETRYABLE_STATES.includes(status)) return null;

    const attempts = Number(contract.id_check_attempts || 0);
    const attemptsLeft = Math.max(0, MAX_ID_CHECK_ATTEMPTS - attempts);
    return {
        status,
        reason: STATE_REASONS[status],
        nextStep: STATE_NEXT_STEPS[status],
        attempts,
        attemptsLeft,
        canRetry: attemptsLeft > 0
    };
}

// The function's own error text (e.g. "used all automatic checks") lives in the
// response body of a non-2xx reply; supabase-js hides it behind error.context.
async function readFunctionError(error, fallback) {
    try {
        const body = await error?.context?.json?.();
        if (body?.error) return { message: String(body.error), attemptsLeft: body.attempts_left };
    } catch { /* fall through */ }
    return { message: fallback, attemptsLeft: undefined };
}

// The live canvas is transparent so the CSS baseline shows through while
// drawing; the contract's signature image must be opaque. Same export the
// booking form uses.
function flattenOntoWhite(transparentDataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = transparentDataUrl;
    });
}

export function initIdRetryModal({ supabase, getPageData, onChanged, onVerified }) {
    const backdrop = document.getElementById('idretry-backdrop');
    if (!backdrop) return { open() {} };

    const closeBtn = document.getElementById('idretry-close');
    const dismissBtn = document.getElementById('idretry-dismiss');
    const confirmBtn = document.getElementById('idretry-confirm');
    const titleEl = document.getElementById('idretry-title');
    const copyEl = document.getElementById('idretry-copy');
    const fileInput = document.getElementById('idretry-file');
    const pickBtn = document.getElementById('idretry-pick');
    const previewEl = document.getElementById('idretry-preview');
    const thumbEl = document.getElementById('idretry-thumb');
    const fileNameEl = document.getElementById('idretry-filename');
    const removeBtn = document.getElementById('idretry-remove');
    const signBlock = document.getElementById('idretry-sign-block');
    const canvas = document.getElementById('idretry-canvas');
    const clearBtn = document.getElementById('idretry-clear');
    const agreeBox = document.getElementById('idretry-agree');
    const messageEl = document.getElementById('idretry-message');

    const state = {
        mode: 'reupload',   // 'reupload' | 'resign'
        file: null,
        objectUrl: null,
        pad: null,
        busy: false,
        hasSavedId: false   // an ID is already saved on the customer's profile
    };
    const filePickerField = fileInput.closest('.idretry-field');

    function setMessage(text = '', kind = '') {
        messageEl.textContent = text;
        messageEl.className = 'account-modal-message' + (kind ? ` ${kind}` : '');
    }

    function clearFile() {
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.file = null;
        state.objectUrl = null;
        fileInput.value = '';
        thumbEl.removeAttribute('src');
        previewEl.classList.add('hidden');
        pickBtn.classList.remove('hidden');
    }

    function setFile(file) {
        const problem = getIdFileError(file) || '';
        clearFile();
        if (problem) {
            setMessage(problem, 'error');
            return;
        }
        setMessage('');
        state.file = file;
        state.objectUrl = URL.createObjectURL(file);
        thumbEl.src = state.objectUrl;
        fileNameEl.textContent = file.name;
        previewEl.classList.remove('hidden');
        pickBtn.classList.add('hidden');
    }

    function resizeCanvas() {
        if (!canvas) return;
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        const data = state.pad && !state.pad.isEmpty() ? state.pad.toData() : null;
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        canvas.getContext('2d').scale(ratio, ratio);
        if (state.pad) {
            state.pad.clear();
            if (data) state.pad.fromData(data);
        }
    }

    // signature_pad is loaded by a <script> tag in reservation-details.html.
    function ensurePad() {
        if (state.pad || !canvas) return !!state.pad;
        if (typeof window.SignaturePad === 'undefined') return false;
        state.pad = new window.SignaturePad(canvas, {
            backgroundColor: 'rgba(0,0,0,0)',
            penColor: 'rgb(42,20,8)'
        });
        state.pad.addEventListener('beginStroke', () => setMessage(''));
        return true;
    }

    function setBusy(busy) {
        state.busy = busy;
        confirmBtn.disabled = busy;
        dismissBtn.disabled = busy;
        closeBtn.disabled = busy;
    }

    function close() {
        if (state.busy) return;
        backdrop.classList.add('hidden');
        backdrop.setAttribute('aria-hidden', 'true');
        clearFile();
        state.pad?.clear();
        if (agreeBox) agreeBox.checked = false;
        setMessage('');
        unlockBodyScroll();
    }

    async function open(mode) {
        const pageData = getPageData();
        const check = getIdCheckState(pageData?.contract);
        if (!pageData?.reservation || !check?.canRetry) return;

        // Is there already an ID on the customer's profile? Decides whether a
        // photo is needed here. If the lookup fails, ask for a photo.
        state.hasSavedId = false;
        try {
            const status = await fetchValidIdStatus(supabase, pageData.reservation.user_id);
            state.hasSavedId = status.hasId;
        } catch { /* ask for a photo */ }

        state.mode = mode === 'resign' ? 'resign' : 'reupload';
        const resign = state.mode === 'resign';
        const saved = state.hasSavedId;

        titleEl.textContent = resign ? 'Sign Again' : (saved ? 'Check Your ID Again' : 'Upload Your ID');
        if (resign) {
            copyEl.textContent = saved
                ? 'Draw your signature again, the way it appears on your ID. We\u2019ll compare it with the valid ID saved on your My Profile. If they match, your contract is approved.'
                : 'Draw your signature again, the way it appears on your ID, and upload a photo of your ID. It will be saved to your My Profile. If the signatures match, your contract is approved.';
        } else {
            copyEl.textContent = saved
                ? 'We\u2019ll compare the signature on your contract with the valid ID saved on your My Profile. If that photo was unclear, choose a clearer one below: it replaces the saved ID. You can also replace or remove it anytime in My Profile.'
                : 'Upload a clear, well-lit photo of a government-issued ID that shows your signature. We\u2019ll compare it with the signature on your contract. It will be saved to your My Profile, where you can replace or remove it anytime.';
        }
        confirmBtn.textContent = resign ? 'Check & Replace Signature' : 'Check My ID';
        // With an ID on file, signing again needs no photo; re-checking makes it optional.
        filePickerField?.classList.toggle('hidden', resign && saved);
        signBlock.classList.toggle('hidden', !resign);
        clearFile();
        if (agreeBox) agreeBox.checked = false;
        setMessage(check.attemptsLeft === 1 ? 'This is your last automatic check.' : '');

        backdrop.classList.remove('hidden');
        backdrop.setAttribute('aria-hidden', 'false');
        lockBodyScroll();

        if (resign) {
            // The canvas has no size while hidden, so set it up after it shows.
            requestAnimationFrame(() => {
                if (!ensurePad()) {
                    setMessage('The signature pad couldn\u2019t load. Please refresh the page and try again.', 'error');
                    return;
                }
                state.pad.clear();
                resizeCanvas();
            });
        }
    }

    async function submit() {
        if (state.busy) return;
        const pageData = getPageData();
        const reservation = pageData?.reservation;
        if (!reservation) return;
        const resign = state.mode === 'resign';

        // A photo is only required when there is no ID on the profile to use.
        if (!state.file && !state.hasSavedId) {
            setMessage('Please choose a photo of your ID first.', 'error');
            return;
        }
        if (resign) {
            if (!state.pad || state.pad.isEmpty()) {
                setMessage('Please draw your signature first.', 'error');
                return;
            }
            if (!agreeBox?.checked) {
                setMessage('Please confirm the box to sign again.', 'error');
                return;
            }
        }

        setBusy(true);
        setMessage('Checking your signature against your ID\u2026');

        try {
            // A photo chosen here is saved to the profile (replacing the old
            // one) and sent along; otherwise the server uses the saved ID.
            let idDataUrl = null;
            if (state.file) {
                try {
                    idDataUrl = await resizeIdImage(state.file);
                } catch {
                    setMessage('We couldn\u2019t read that photo. Please choose another one.', 'error');
                    return;
                }
                try {
                    await saveValidId(supabase, reservation.user_id, idDataUrl);
                    state.hasSavedId = true;
                } catch (saveError) {
                    // Not fatal: the photo still goes with this check.
                    console.warn('[id_signature_retry] could not save the ID to the profile:', saveError);
                }
            }
            const idBody = idDataUrl ? { id_image_data_url: idDataUrl } : { use_saved_id: true };

            let invoked;
            if (resign) {
                let signatureDataUrl;
                try {
                    signatureDataUrl = await flattenOntoWhite(state.pad.toDataURL('image/png'));
                } catch {
                    signatureDataUrl = state.pad.toDataURL('image/png');
                }
                invoked = await supabase.functions.invoke('generate-signed-contract', {
                    body: {
                        reservation_id: reservation.reservation_id,
                        resign: true,
                        ...idBody,
                        signature_data_url: signatureDataUrl,
                        signature_type: 'drawn',
                        // The server keeps the original printed name and the
                        // agreement-view record; this only satisfies validation.
                        signer_name: reservation.contact_name || 'Customer',
                        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
                    }
                });
            } else {
                invoked = await supabase.functions.invoke('verify-id-signature', {
                    body: {
                        reservation_id: reservation.reservation_id,
                        ...idBody
                    }
                });
            }

            const { data, error } = invoked;
            if (error || !data?.success) {
                const fail = await readFunctionError(
                    error,
                    data?.error || 'We couldn\u2019t check your ID right now. Please try again in a moment.'
                );
                setMessage(fail.message, 'error');
                if (fail.attemptsLeft === 0) {
                    setBusy(false);
                    close();
                    await onChanged();
                }
                return;
            }

            if (data.verified) {
                setBusy(false);
                close();
                await onChanged();
                onVerified?.();
                return;
            }

            // A real result, but not a match: the contract stays pending.
            const reason = STATE_REASONS[data.verdict] || STATE_REASONS.mismatch;
            if (Number(data.attempts_left) <= 0) {
                setBusy(false);
                close();
                await onChanged();
                onVerified?.({ manualReview: true });
                return;
            }
            const left = Number(data.attempts_left);
            setMessage(
                `${reason} ${STATE_NEXT_STEPS[data.verdict] || ''} ` +
                `(${left} automatic ${left === 1 ? 'check' : 'checks'} left.)`,
                'error'
            );
            clearFile();
            if (resign) state.pad?.clear();
            onChanged();   // refresh the page behind the modal (attempt count)
        } catch (error) {
            console.error('[id_signature_retry] failed:', error);
            setMessage('Something went wrong. Please try again.', 'error');
        } finally {
            setBusy(false);
        }
    }

    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) setFile(file);
    });
    removeBtn.addEventListener('click', () => { clearFile(); setMessage(''); });
    clearBtn?.addEventListener('click', () => { state.pad?.clear(); setMessage(''); });
    confirmBtn.addEventListener('click', submit);
    closeBtn.addEventListener('click', close);
    dismissBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !backdrop.classList.contains('hidden')) close();
    });
    window.addEventListener('resize', () => {
        if (!backdrop.classList.contains('hidden') && state.mode === 'resign') resizeCanvas();
    });

    return { open };
}
