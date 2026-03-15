import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = "https://gznemevovvcfjnuwsixl.supabase.co"
const supabaseKey = "sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM"
export const supabase = createClient(supabaseUrl, supabaseKey)

