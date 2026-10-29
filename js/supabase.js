// Deliberately NOT `import { createClient } from '.../supabase-js@2/+esm'`
// anymore — jsDelivr's +esm endpoint resolves this package's internal
// dependency graph (auth-js, postgrest-js, realtime-js, storage-js,
// functions-js, tslib, phoenix, ...) as separate chained module fetches
// instead of one bundled file, each a full round trip that has to resolve
// before the next one is even requested. A PageSpeed critical-request-chain
// audit measured this at 8 sequential hops, ~1000ms+ each. createClient is
// read off window.supabase instead — the UMD bundle every page's <head>
// loads via a plain (non-module) `defer`red <script> tag, which bundles all
// of the above into the ONE file already verified end-to-end (a real
// Supabase query) before this switch was made. Read lazily inside
// makeClient() below, not destructured at this top level, so this module
// has no load-order dependency on that <script> tag beyond "loaded by the
// time a page actually calls a Supabase method" — already true today since
// every real call happens well after both scripts finish.

const DEFAULT_SUPABASE_URL = 'https://gznemevovvcfjnuwsixl.supabase.co'
const DEFAULT_SUPABASE_KEY = 'sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM'
const SUPABASE_OVERRIDE_KEY = 'eli-supabase-override'

function isLocalDevelopmentHost() {
    if (typeof window === 'undefined') {
        return false
    }

    const host = String(window.location.hostname || '').toLowerCase()
    return host === 'localhost' || host === '127.0.0.1'
}

function readSupabaseOverride() {
    if (typeof window === 'undefined' || !window.localStorage) {
        return null
    }

    if (!isLocalDevelopmentHost()) {
        return null
    }

    try {
        const rawValue = window.localStorage.getItem(SUPABASE_OVERRIDE_KEY)
        if (!rawValue) return null

        const parsed = JSON.parse(rawValue)
        if (!parsed || typeof parsed !== 'object') return null

        const url = typeof parsed.url === 'string' ? parsed.url.trim() : ''
        const key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
        const label = typeof parsed.label === 'string' ? parsed.label.trim() : 'override'

        if (!url || !key) return null

        return { url, key, label }
    } catch (error) {
        return null
    }
}

const supabaseOverride = readSupabaseOverride()
const supabaseUrl = supabaseOverride?.url || DEFAULT_SUPABASE_URL
const supabaseKey = supabaseOverride?.key || DEFAULT_SUPABASE_KEY

;(function guardAgainstMisroutedRecoveryLink() {
    if (typeof window === 'undefined') return

    const path = window.location.pathname
    if (path.startsWith('/admin') || path.startsWith('/board') || path === '/reset-password') {
        return 
    }

    const hash = window.location.hash || ''
    const isInvite = hash.includes('type=invite')
    const isRecovery = hash.includes('type=recovery')
    if (!isInvite && !isRecovery) return

    const destination = isInvite ? '/admin/set-password' : '/admin/reset-password'
    window.location.replace(destination + hash)
})()

// ── Customer password-recovery sessions ─────────────────────────────────────
// Opening the link in a password-reset email gives the browser a real Supabase
// session so the customer can call updateUser({ password }). Left alone, that
// session is indistinguishable from a normal login on every other page
// (account, reservations, payment, ...), even if the customer never sets a new
// password. So the moment a recovery session starts, a flag is stored; on every
// customer page except /reset-password that flag causes the stored session to
// be discarded before any page code can read it. The flag is cleared by that
// discard, or by the sign-out that follows a successful password change
// (js/reset_password.js). Admin/board pages use other storage keys and are not
// touched here.
//
// This is done by removing the stored session synchronously (rather than only
// calling auth.signOut()) so that a page which reads the session right after
// import can never see it, and the server-side session is then revoked in the
// background. An unrevoked recovery session could otherwise be refreshed.
const CUSTOMER_STORAGE_KEY = 'eli-customer-auth'
const CUSTOMER_RECOVERY_FLAG = 'eli-customer-recovery'

function setCustomerRecoveryFlag() {
    try { window.localStorage.setItem(CUSTOMER_RECOVERY_FLAG, '1') } catch (error) { /* storage unavailable */ }
}

function clearCustomerRecoveryFlag() {
    try { window.localStorage.removeItem(CUSTOMER_RECOVERY_FLAG) } catch (error) { /* storage unavailable */ }
}

;(function isolateCustomerRecoverySession() {
    if (typeof window === 'undefined' || !window.localStorage) return

    const path = window.location.pathname
    if (path.startsWith('/admin') || path.startsWith('/board')) return

    // Arriving through a recovery link (tokens in the URL hash): mark the
    // session that supabase-js is about to create from it. This also covers a
    // link that lands on the wrong customer page.
    const hash = window.location.hash || ''
    const arrivingViaRecoveryLink = hash.includes('type=recovery') && hash.includes('access_token=')
    if (arrivingViaRecoveryLink) setCustomerRecoveryFlag()

    // The reset page is the one place a recovery session is allowed to be used.
    if (path === '/reset-password' || path === '/reset-password.html') return

    let recoveryPending = false
    try {
        recoveryPending = window.localStorage.getItem(CUSTOMER_RECOVERY_FLAG) === '1'
    } catch (error) {
        return
    }
    if (!recoveryPending) return

    let accessToken = ''
    try {
        const raw = window.localStorage.getItem(CUSTOMER_STORAGE_KEY)
        accessToken = (raw && JSON.parse(raw)?.access_token) || ''
    } catch (error) { /* unreadable session: it is removed below anyway */ }
    try { window.localStorage.removeItem(CUSTOMER_STORAGE_KEY) } catch (error) { /* storage unavailable */ }

    if (accessToken && typeof fetch === 'function') {
        try {
            fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
                method: 'POST',
                headers: { apikey: supabaseKey, Authorization: `Bearer ${accessToken}` },
                keepalive: true
            }).catch(() => {})
        } catch (error) { /* best effort: the local session is already gone */ }
    }

    // On a misrouted recovery link the session is only created after this
    // runs, so keep the flag and let the next customer page clean it up.
    if (!arrivingViaRecoveryLink) clearCustomerRecoveryFlag()
})()

function makeClient(storageKey) {
    if (typeof window === 'undefined' || !window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Supabase UMD bundle not loaded — add <script src=".../supabase-js@2.../dist/umd/supabase.js" defer> before this page\'s module scripts.')
    }
    const client = window.supabase.createClient(supabaseUrl, supabaseKey, {
        auth: {
            storageKey,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    })

    if (storageKey === CUSTOMER_STORAGE_KEY) {
        // Backstop for the hash check above: PASSWORD_RECOVERY is the event
        // supabase-js raises when a recovery session starts, however the link
        // arrived. A sign-out ends the recovery state.
        client.auth.onAuthStateChange((event) => {
            if (event === 'PASSWORD_RECOVERY') setCustomerRecoveryFlag()
            else if (event === 'SIGNED_OUT') clearCustomerRecoveryFlag()
        })
    }

    return client
}

function lazyClient(storageKey) {
    let instance = null;
    function getInstance() {
        if (!instance) instance = makeClient(storageKey);
        return instance;
    }
    return new Proxy({}, {
        get(_target, prop, receiver) {
            const client = getInstance();
            const value = Reflect.get(client, prop, client);
            return typeof value === 'function' ? value.bind(client) : value;
        }
    });
}

export const customerSupabase = lazyClient(CUSTOMER_STORAGE_KEY)
export const portalSupabase = lazyClient('eli-portal-auth')
// Kept fully separate from portalSupabase: the shared staff/board kiosk
// credential must never share a browser session bucket with manager/admin,
// otherwise signing in on one login page silently overwrites the other's
// session in every open tab (see the staff-login-separation follow-up).
export const boardSupabase = lazyClient('eli-board-auth')

// Keep the public site on the customer session by default.
export const supabase = customerSupabase