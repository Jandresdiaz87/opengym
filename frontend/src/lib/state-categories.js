// How S (the whole app state) maps onto profile_state's four JSONB columns. Pure and
// dependency-free on purpose — cloud-sync.js is the only caller that also touches the network.
export const CATEGORIES = ['routines', 'workouts', 'bodyweight', 'settings']
export const STATE_COL = { routines: 'routines_state', workouts: 'workouts_state', bodyweight: 'bodyweight_state', settings: 'settings_state' }
export const REV_COL = { routines: 'routines_rev', workouts: 'workouts_rev', bodyweight: 'bodyweight_rev', settings: 'settings_rev' }

const ROUTINES_FIELDS = ['routines', 'week', 'dayPlan', 'customEx']
const WORKOUTS_FIELDS = ['workouts']
const BODYWEIGHT_FIELDS = ['bodyweight']
// Never synced at all: `active` is the in-progress workout, device-local by design (the old
// PUT /api/data deleted it before writing, too). `_ts` lives at the top of S for sync-merge's
// freshness comparisons and has no column of its own — Postgres tracks its own *_updated_at per
// category for the low-level conditional write, a separate concern from the app-level `_ts`.
const EXCLUDED_FIELDS = new Set(['active', '_ts'])
const KNOWN_FIELDS = new Set([...ROUTINES_FIELDS, ...WORKOUTS_FIELDS, ...BODYWEIGHT_FIELDS])

// Every field of S not owned by routines/workouts/bodyweight (and not excluded) falls into
// "settings" by exclusion rather than an explicit list — a new DEF field added later lands there
// automatically, the same as it silently joined the one old JSON blob before this split existed.
export function splitByCategory(S) {
  const pick = keys => { const o = {}; for (const k of keys) if (k in S) o[k] = S[k]; return o }
  const settings = {}
  for (const k of Object.keys(S)) if (!KNOWN_FIELDS.has(k) && !EXCLUDED_FIELDS.has(k)) settings[k] = S[k]
  return { routines: pick(ROUTINES_FIELDS), workouts: pick(WORKOUTS_FIELDS), bodyweight: pick(BODYWEIGHT_FIELDS), settings }
}
export function composeFromCategories(cats) {
  return { ...(cats.settings || {}), ...(cats.routines || {}), ...(cats.workouts || {}), ...(cats.bodyweight || {}) }
}

// True if any category's revision differs — replaces the old single-number `rev !== sync.rev`.
export function revsDiffer(a, b) {
  if (!a || !b) return a !== b
  return CATEGORIES.some(c => a[c] !== b[c])
}
