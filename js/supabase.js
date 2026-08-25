   import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

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

function makeClient(storageKey) {
    return createClient(supabaseUrl, supabaseKey, {
        auth: {
            storageKey,
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    })
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

export const customerSupabase = lazyClient('eli-customer-auth')
export const portalSupabase = lazyClient('eli-portal-auth')

// Keep the public site on the customer session by default.
export const supabase = customerSupabase