import { customerSupabase as supabase } from './supabase.js';

const form       = document.getElementById('login-form');
const btn        = document.getElementById('login-btn');
const msg        = document.getElementById('login-message');
const emailInput = document.getElementById('login-email');
const pwInput    = document.getElementById('login-password');

const MAX_ATTEMPTS = 5;
const LOCK_MS      = 10 * 60 * 1000; // 10 minutes
const KEY_PREFIX   = 'eli_login_';
let   countdownId  = null;

/* ─── Storage helpers ─────────────────────────────────────────────────── */
function storeKey(email) {
    return KEY_PREFIX + email.trim().toLowerCase();
}

function loadRecord(email) {
    try {
        const raw = localStorage.getItem(storeKey(email));
        return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
    } catch {
        return { attempts: 0, lockedUntil: 0 };
    }
}

function saveRecord(email, rec) {
    try { localStorage.setItem(storeKey(email), JSON.stringify(rec)); } catch { /* storage unavailable */ }
}

function clearRecord(email) {
    try { localStorage.removeItem(storeKey(email)); } catch { /* */ }
}

/* ─── UI helpers ──────────────────────────────────────────────────────── */
function setMsg(text, type) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'form-msg' + (type ? ' ' + type : '');
}

function setLockoutMsg(timeStr) {
    if (!msg) return;
    msg.innerHTML =
        '<i class="ti ti-lock" style="margin-right:6px;font-size:14px;vertical-align:-2px"></i>' +
        'Too many failed attempts. Account is temporarily locked &mdash; try again in <strong>' + timeStr + '</strong>.';
    msg.className = 'form-msg lockout';
}

function lockForm(locked) {
    emailInput.disabled = locked;
    pwInput.disabled    = locked;
    btn.disabled        = locked;
    btn.textContent     = locked ? 'Account Locked' : 'Login';
}

function setSubmitting(on) {
    btn.disabled    = on;
    btn.textContent = on ? 'Logging in…' : 'Login';
}

/* ─── Countdown timer ─────────────────────────────────────────────────── */
function formatTime(ms) {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m > 0) return m + ' min ' + s + ' sec';
    return s + ' second' + (s !== 1 ? 's' : '');
}

function startLockout(email, lockedUntil) {
    if (countdownId) clearInterval(countdownId);
    lockForm(true);

    function tick() {
        const remaining = lockedUntil - Date.now();
        if (remaining <= 0) {
            clearInterval(countdownId);
            countdownId = null;
            clearRecord(email);
            lockForm(false);
            setMsg('');
            return;
        }
        setLockoutMsg(formatTime(remaining));
    }

    tick();
    countdownId = setInterval(tick, 1000);
}

/* ─── Check lockout state for an email ───────────────────────────────── */
function checkLockout(email) {
    if (!email) return false;
    const rec = loadRecord(email);
    if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
        startLockout(email, rec.lockedUntil);
        return true;
    }
    // Expired lockout — clean up silently
    if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
        clearRecord(email);
    }
    return false;
}

/* ─── On-load: restore any active lockout across tabs / page refreshes ── */
// localStorage is shared between tabs. Scan for any eli_login_* key with an
// active lockedUntil timestamp and immediately lock the form so the user
// cannot see an unlocked form in a new tab while a lockout is still running.
(function initLockout() {
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(KEY_PREFIX)) continue;
            let rec;
            try { rec = JSON.parse(localStorage.getItem(key)); } catch { continue; }
            if (!rec || !rec.lockedUntil || Date.now() >= rec.lockedUntil) continue;

            const lockedEmail = key.slice(KEY_PREFIX.length);
            // Pre-fill the email field so the user knows which account is locked,
            // then start the countdown immediately.
            if (!emailInput.value.trim()) emailInput.value = lockedEmail;
            startLockout(lockedEmail, rec.lockedUntil);
            break; // Only one lockout can be active at a time per browser
        }
    } catch { /* localStorage unavailable — submit guard still enforces the lockout */ }
}());

/* ─── Email field listeners ───────────────────────────────────────────── */
// Re-check lockout when user finishes typing their email
emailInput.addEventListener('blur', function () {
    const email = emailInput.value.trim();
    if (email && !countdownId) checkLockout(email);
});

// If they change the email while a countdown is running, clear the lockout UI
// (the record remains — it will re-trigger if they return to the locked email)
emailInput.addEventListener('input', function () {
    if (countdownId) {
        clearInterval(countdownId);
        countdownId = null;
        lockForm(false);
        setMsg('');
    }
});

/* ─── Submit handler ──────────────────────────────────────────────────── */
form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const email    = emailInput.value.trim();
    const password = pwInput.value;

    if (!email || !password) {
        setMsg('Please fill in all fields.', 'error');
        return;
    }

    // Hard-check on submit (covers page-refresh-during-lockout case)
    if (checkLockout(email)) return;

    setMsg('');
    setSubmitting(true);

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    setSubmitting(false);

    if (error) {
        const norm = error.message.toLowerCase();

        if (norm.includes('email not confirmed')) {
            setMsg('Please confirm your email first. Check your inbox for the confirmation link.', 'error');
            return;
        }

        if (norm.includes('invalid login credentials') || norm.includes('invalid credentials')) {
            const rec      = loadRecord(email);
            const attempts = (rec.attempts || 0) + 1;

            if (attempts >= MAX_ATTEMPTS) {
                const lockedUntil = Date.now() + LOCK_MS;
                saveRecord(email, { attempts, lockedUntil });
                startLockout(email, lockedUntil);
            } else {
                saveRecord(email, { attempts, lockedUntil: 0 });
                const left = MAX_ATTEMPTS - attempts;
                setMsg(
                    'Incorrect email or password. ' +
                    left + ' attempt' + (left !== 1 ? 's' : '') +
                    ' remaining before temporary lockout.',
                    'error'
                );
            }
            return;
        }

        setMsg(error.message, 'error');
        return;
    }

    // This is a customer-facing login — accounts registered as staff,
    // manager, or admin belong to the separate admin portal and must not
    // be able to sign in here even though Supabase Auth shares one user
    // table across both portals.
    const { data: profileRow, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', data.user.id)
        .maybeSingle();

    if (profileError || !profileRow || String(profileRow.role || '').trim().toLowerCase() !== 'customer') {
        await supabase.auth.signOut();
        setMsg('This account is registered for staff access. Please use the staff/admin login instead.', 'error');
        return;
    }

    // Success — clear attempt history and redirect
    clearRecord(email);
    window.location.href = '/';
});
