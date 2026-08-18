/**
 * Koda service config — open-source build.
 *
 * The public client ships with NO Koda service identifiers. Cloud relay, phone control, analytics, and
 * the hosted feedback sink stay inert until you point them at your own infrastructure via env:
 *   KODA_SUPABASE_URL, KODA_SUPABASE_KEY, KODA_RELAY_URL, KODA_POSTHOG_KEY, KODA_FEEDBACK_HANDSHAKE
 * (Koda's own hosted cloud is a separate paid service; this stub is what ships in the public repo.)
 */
export const SUPABASE_URL = process.env.KODA_SUPABASE_URL || ''
export const SUPABASE_PUBLISHABLE_KEY = process.env.KODA_SUPABASE_KEY || ''
export const RELAY_WS_URL = process.env.KODA_RELAY_URL || ''
export const POSTHOG_KEY = process.env.KODA_POSTHOG_KEY || ''
export const FEEDBACK_HANDSHAKE = process.env.KODA_FEEDBACK_HANDSHAKE || ''
export const CONNECT_API_URL = process.env.KODA_CONNECT_API_URL || ''
export const CONNECT_API_URL_DEV = process.env.KODA_CONNECT_API_URL || ''
export const CONNECT_CONTROL_URL = process.env.KODA_CONNECT_URL || ''
export const CONNECT_CONTROL_URL_DEV = process.env.KODA_CONNECT_URL || ''
