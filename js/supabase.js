//supa
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

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
        console.warn('Ignoring invalid Supabase override in localStorage:', error)
        return null
    }
}

const supabaseOverride = readSupabaseOverride()
const supabaseUrl = supabaseOverride?.url || DEFAULT_SUPABASE_URL
const supabaseKey = supabaseOverride?.key || DEFAULT_SUPABASE_KEY

if (typeof window !== 'undefined') {
    const targetLabel = supabaseOverride?.label || 'hosted'
    if (!isLocalDevelopmentHost() && window.localStorage?.getItem(SUPABASE_OVERRIDE_KEY)) {
        console.info('Ignoring Supabase override because this page is not running on localhost.')
    }
    console.info(`Supabase client target: ${targetLabel} (${supabaseUrl})`)
}

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

export const customerSupabase = makeClient('eli-customer-auth')
export const portalSupabase = makeClient('eli-portal-auth')

// Keep the public site on the customer session by default.
export const supabase = customerSupabase

