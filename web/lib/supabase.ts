import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Mobile route guards should rely on the locally restored session instead of
// `getUser()`'s network round-trip. A transient refresh/network failure on app
// resume should not be interpreted as "the user is signed out".
export async function getRestoredSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}
