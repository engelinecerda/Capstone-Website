import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = "https://gznemevovvcfjnuwsixl.supabase.co"
const supabaseKey = "sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM"

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

