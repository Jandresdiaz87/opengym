// Replaces api.js's GET/PUT /api/data and GET /api/data/rev with direct reads/writes against
// Supabase's profile_state table — four independently-revisioned JSONB columns (see the DB
// migration opengym_core_schema, and state-categories.js for how S maps onto them).
// useStore.js's orchestration (debounce, offline queue, conflict-merge retry, cross-tab
// coordination) is unchanged; only the transport underneath it moves here, and the response
// shapes below are deliberately kept close to the old API's so that orchestration needed almost
// no changes.
import { supabase } from './supabase.js'
import { CATEGORIES, STATE_COL, REV_COL, splitByCategory, composeFromCategories, revsDiffer } from './state-categories.js'

export { CATEGORIES, splitByCategory, composeFromCategories, revsDiffer }

function authError() { const e = new Error('not signed in'); e.status = 401; return e }
function isNetworkFailure(err) { return /failed to fetch|network|load failed/i.test(String(err?.message || '')) }
// Mirrors api.js's error shape (`.status`, thrown) closely enough that useStore.js's existing
// catch blocks (checking e.status === 401 / 409 / network) work unchanged. A network failure is
// left without a `.status`, matching isNetworkError's `e.status == null` check there.
function dbError(err) {
  const e = new Error(err?.message || 'database error')
  if (!isNetworkFailure(err)) e.status = 500
  return e
}

async function currentUserId() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw authError()
  return user.id
}

// Mirrors GET /api/data: { state, rev }. `state`/`rev` are null only if the row somehow doesn't
// exist — shouldn't happen, the signup trigger creates it — kept as a defensive no-op case.
export async function fetchCloudState() {
  const uid = await currentUserId()
  const { data, error } = await supabase.from('profile_state').select('*').eq('id', uid).maybeSingle()
  if (error) throw dbError(error)
  if (!data) return { state: null, rev: null }
  const rev = Object.fromEntries(CATEGORIES.map(c => [c, data[REV_COL[c]]]))
  const state = composeFromCategories(Object.fromEntries(CATEGORIES.map(c => [c, data[STATE_COL[c]]])))
  return { state, rev }
}

// Mirrors GET /api/data/rev — the cheap poll checkRev() calls every 30s.
export async function fetchCloudRev() {
  const uid = await currentUserId()
  const { data, error } = await supabase.from('profile_state').select(CATEGORIES.map(c => REV_COL[c]).join(',')).eq('id', uid).maybeSingle()
  if (error) throw dbError(error)
  return data ? Object.fromEntries(CATEGORIES.map(c => [c, data[REV_COL[c]]])) : null
}

/**
 * Mirrors PUT /api/data. `baseRev` is the four-category revision object read at the last
 * successful sync, or null/undefined for a forced overwrite (import, reset — same as the old
 * `force`).
 *
 * Each category is its own UPDATE with its own conditional rev check, so a stale rev on a
 * category this device never touched — another device moved it — conflicts *only that category*,
 * which is the whole point of splitting the JSONB blob into columns instead of one. Re-sending a
 * category whose content is byte-identical to what is already stored costs nothing:
 * profile_state_bump_revs() (the DB trigger) only bumps a rev when the column's value actually
 * changes, so there is no need to diff categories client-side before deciding what to send.
 *
 * If any category's UPDATE affects 0 rows (its rev didn't match), the whole call throws — shaped
 * like the old 409 (`.status = 409`, `.data = { state, rev }` holding the CURRENT server
 * document) — so useStore.js's existing catch block (merge + retry) needs no change. A category
 * that succeeded before another conflicted keeps its write; retrying re-sends it unchanged next
 * to the merged result, a harmless no-op against its own just-written value.
 */
export async function pushCloudState(S, baseRev) {
  const uid = await currentUserId()
  const cats = splitByCategory(S)
  const newRev = {}
  let conflicted = false
  for (const cat of CATEGORIES) {
    let q = supabase.from('profile_state').update({ [STATE_COL[cat]]: cats[cat] }).eq('id', uid)
    if (baseRev && baseRev[cat] != null) q = q.eq(REV_COL[cat], baseRev[cat])
    const { data, error } = await q.select(REV_COL[cat])
    if (error) throw dbError(error)
    if (!data || !data.length) { conflicted = true; continue }
    newRev[cat] = data[0][REV_COL[cat]]
  }
  if (conflicted) {
    const current = await fetchCloudState()
    const e = new Error('conflict'); e.status = 409; e.data = { state: current.state, rev: current.rev }
    throw e
  }
  return { rev: newRev }
}
