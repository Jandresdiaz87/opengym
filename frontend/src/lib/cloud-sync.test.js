// Exercises the actual Supabase call shapes cloud-sync.js makes, against a small fake table —
// not the real network. state-categories.test.js covers the pure split/compose logic; this file
// covers the conditional-write / conflict behaviour, which is the part worth distrusting.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let table
function makeFakeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from(_name) {
      return {
        select(cols) {
          return {
            eq(_col, val) {
              return {
                maybeSingle: async () => {
                  if (!table || table.id !== val) return { data: null, error: null }
                  if (cols === '*') return { data: { ...table }, error: null }
                  const picked = {}
                  for (const c of cols.split(',')) picked[c.trim()] = table[c.trim()]
                  return { data: picked, error: null }
                }
              }
            }
          }
        },
        update(patch) {
          let idEq = null, revEq = null
          const chain = {
            eq(col, val) {
              if (col === 'id') idEq = val; else revEq = [col, val]
              return chain
            },
            select(revCol) {
              if (!table || table.id !== idEq) return Promise.resolve({ data: [], error: null })
              if (revEq && table[revEq[0]] !== revEq[1]) return Promise.resolve({ data: [], error: null })
              const stateCol = Object.keys(patch)[0]
              // Mimics profile_state_bump_revs(): only bump when the value actually changed.
              const changed = JSON.stringify(table[stateCol]) !== JSON.stringify(patch[stateCol])
              table[stateCol] = patch[stateCol]
              if (changed) table[revCol] = (table[revCol] || 0) + 1
              return Promise.resolve({ data: [{ [revCol]: table[revCol] }], error: null })
            }
          }
          return chain
        }
      }
    }
  }
}

vi.mock('./supabase.js', () => ({ get supabase() { return makeFakeSupabase() } }))
const { fetchCloudState, fetchCloudRev, pushCloudState } = await import('./cloud-sync.js')

beforeEach(() => {
  table = {
    id: 'u1',
    routines_state: { routines: [], week: {}, dayPlan: {}, customEx: [] }, routines_rev: 0,
    workouts_state: { workouts: [] }, workouts_rev: 0,
    bodyweight_state: { bodyweight: [] }, bodyweight_rev: 0,
    settings_state: { unit: 'kg' }, settings_rev: 0
  }
})

describe('fetchCloudState / fetchCloudRev', () => {
  it('composes the four columns into one S-shaped object', async () => {
    const { state, rev } = await fetchCloudState()
    expect(state).toEqual({ unit: 'kg', routines: [], week: {}, dayPlan: {}, customEx: [], workouts: [], bodyweight: [] })
    expect(rev).toEqual({ routines: 0, workouts: 0, bodyweight: 0, settings: 0 })
  })
  it('fetchCloudRev matches fetchCloudState\'s rev without pulling the state columns', async () => {
    expect(await fetchCloudRev()).toEqual((await fetchCloudState()).rev)
  })
})

describe('pushCloudState', () => {
  it('force (no baseRev) writes unconditionally and bumps every category that actually changed', async () => {
    const S = { unit: 'kg', routines: [{ id: 'r1' }], week: {}, dayPlan: {}, customEx: [], workouts: [], bodyweight: [] }
    const { rev } = await pushCloudState(S, null)
    expect(rev).toEqual({ routines: 1, workouts: 0, bodyweight: 0, settings: 0 })
    expect(table.routines_state.routines).toEqual([{ id: 'r1' }])
  })

  it('a correct baseRev on every category succeeds and returns the bumped revs', async () => {
    const S = { unit: 'kg', routines: [], week: {}, dayPlan: {}, customEx: [], workouts: [{ d: '2026-01-01', entries: [] }], bodyweight: [] }
    const { rev } = await pushCloudState(S, { routines: 0, workouts: 0, bodyweight: 0, settings: 0 })
    expect(rev.workouts).toBe(1)
    expect(rev.routines).toBe(0)   // unchanged content → trigger does not bump it
  })

  it('a stale rev on ONE category conflicts only that category — the other three still commit', async () => {
    // Simulate another device having already advanced workouts_rev to 3 since this device last synced.
    table.workouts_rev = 3
    const S = { unit: 'kg', routines: [{ id: 'r1' }], week: {}, dayPlan: {}, customEx: [], workouts: [{ d: 'stale' }], bodyweight: [] }
    const staleBaseRev = { routines: 0, workouts: 0, bodyweight: 0, settings: 0 }   // this device's workouts rev is stale
    await expect(pushCloudState(S, staleBaseRev)).rejects.toMatchObject({ status: 409 })
    // routines committed even though the whole call threw — the point of per-column conflicts.
    expect(table.routines_state.routines).toEqual([{ id: 'r1' }])
    expect(table.routines_rev).toBe(1)
    // workouts was left untouched by the conflicting write.
    expect(table.workouts_state.workouts).toEqual([])
  })

  it('the 409 carries the current server state and rev, same shape the old 409 body had', async () => {
    table.workouts_rev = 5
    table.workouts_state = { workouts: [{ d: 'server-side' }] }
    const S = { unit: 'kg', routines: [], week: {}, dayPlan: {}, customEx: [], workouts: [], bodyweight: [] }
    try {
      await pushCloudState(S, { routines: 0, workouts: 0, bodyweight: 0, settings: 0 })
      throw new Error('expected a conflict')
    } catch (e) {
      expect(e.status).toBe(409)
      expect(e.data.rev.workouts).toBe(5)
      expect(e.data.state.workouts).toEqual([{ d: 'server-side' }])
    }
  })
})
