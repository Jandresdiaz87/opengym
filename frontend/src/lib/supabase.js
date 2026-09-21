// Supabase client + auth. Replaces the old passkey/WebAuthn ceremony (server.js's
// /api/register/*, /api/login/*, signed session cookies) with Supabase Auth: Google OAuth and
// email/password, backed by Supabase's own JWT session (stored by supabase-js itself, refreshed
// automatically — nothing here manages a cookie or a token).
import { createClient } from '@supabase/supabase-js'

// Fall back to a syntactically valid placeholder rather than throw at import time: a build that
// forgot to set these should fail loudly the moment a real network call is attempted (a network
// error, handled the same as being offline — see cloud-sync.js's isNetworkFailure), not crash
// every module that transitively imports this one, tests included.
const ENV_URL = import.meta.env.VITE_SUPABASE_URL
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const URL = ENV_URL || 'https://placeholder.supabase.co'
const KEY = ENV_KEY || 'placeholder-anon-key'
if (typeof window !== 'undefined' && (!ENV_URL || !ENV_KEY)) {
  console.error('Cospel: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set at build time — sign-in and sync will not work. See .env.example.')
}

export const supabase = createClient(URL, KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
})

// Mirrors the { id, name, admin } shape the old GET /api/me returned, so callers (useStore.js,
// Settings, Admin) read a user object shaped the same way as before.
async function userFromSession(session) {
  if (!session?.user) return null
  const { data, error } = await supabase.from('profiles').select('name, is_admin').eq('id', session.user.id).maybeSingle()
  if (error) throw error
  // handle_new_user() (the DB trigger) inserts this row in the same transaction as auth.users,
  // so it exists by the time any session exists. The fallback is only for the instant between
  // signUp() resolving and that row becoming visible to this client's own read.
  return { id: session.user.id, name: data?.name || session.user.email || '', admin: !!data?.is_admin }
}

export async function getCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession()
  return userFromSession(session)
}

// Fires on sign-in, sign-out, and token refresh — including a sign-out triggered from another
// tab or device (e.g. "sign out everywhere"). Returns an unsubscribe function.
export function onAuthStateChange(cb) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    userFromSession(session).then(cb).catch(() => cb(null))
  })
  return () => subscription.unsubscribe()
}

// Redirects the whole page to Google and back — there is nothing to return here. The app
// reloads afterwards with a session Supabase's client already picked up from the URL
// (detectSessionInUrl above), so boot() on that fresh load is what notices the new sign-in.
export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  })
  if (error) throw error
}

export async function signUpWithPassword(email, password, name) {
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { name } } })
  if (error) throw error
  // "Confirm email" (a project setting under Authentication → Providers → Email) makes signUp
  // return no session until the emailed link is clicked — the caller has to say so rather than
  // assume the account is usable right away.
  if (!data.session) return { user: null, needsEmailConfirmation: true }
  return { user: await userFromSession(data.session), needsEmailConfirmation: false }
}

export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return userFromSession(data.session)
}

// scope:'global' revokes every refresh token this user has anywhere — the direct equivalent of
// the old server's session-version bump ("sign out everywhere").
export async function signOutSupabase(everywhere = false) {
  await supabase.auth.signOut({ scope: everywhere ? 'global' : 'local' })
}
