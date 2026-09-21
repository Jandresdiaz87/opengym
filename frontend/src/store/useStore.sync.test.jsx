// @vitest-environment happy-dom

/* Two devices, one account: Supabase refuses a push over a category this device never saw (a
   409 shaped like the old one, with the current copy), the store merges and pushes again; a
   pull adopts, pushes or merges by comparing the server's four-category revision object against
   its own marker; nothing pushes before boot has pulled; coming back to the tab pulls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/cloud-sync.js', async () => {
  const { revsDiffer } = await import('../lib/state-categories.js')
  return { fetchCloudState: vi.fn(), fetchCloudRev: vi.fn(), pushCloudState: vi.fn(), revsDiffer }
})
vi.mock('../lib/supabase.js', () => ({ getCurrentUser: vi.fn(), onAuthStateChange: vi.fn(), signOutSupabase: vi.fn() }))
vi.mock('../lib/api.js', () => ({ setRemoteAuth: vi.fn() }))
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))

import { fetchCloudState, fetchCloudRev, pushCloudState } from '../lib/cloud-sync.js'
import { getCurrentUser } from '../lib/supabase.js'
import { DEF, useStore } from './useStore.js'

const clone = value => JSON.parse(JSON.stringify(value))
const routine = id => ({ id, name: id, ex: [] })
const workout = (id, d = '2026-09-01') => ({ id, d, start: 1, entries: [] })
const httpError = (status, data) => Object.assign(new Error(data?.error || 'HTTP ' + status), { status, ...data })
// Every category at the same revision number — good enough for scenarios that don't care about
// per-category independence (a dedicated test below covers that specifically).
const revs = n => ({ routines: n, workouts: n, bodyweight: n, settings: n })
const sync = () => JSON.parse(localStorage.getItem('gym_sync'))
const puts = () => pushCloudState.mock.calls.map(([S, baseRev]) => ({ state: S, baseRev }))
const gets = () => fetchCloudRev.mock.calls.length
const signedIn = (S, extra = {}) => useStore.setState({ S, user: { id: 'user-1' }, ready: true, ...extra })

beforeEach(() => {
  localStorage.clear()
  fetchCloudState.mockReset()
  fetchCloudRev.mockReset()
  pushCloudState.mockReset()
  getCurrentUser.mockReset()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

describe('pull against a revisioned server', () => {
  it('adopts the server copy when only the server moved, and records its revision', async () => {
    const local = { ...clone(DEF), _ts: 100, workouts: [workout('w1')], active: { id: 'running' } }
    signedIn(local)
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('w2')] }, rev: revs(2) })

    await useStore.getState().pullState()

    expect(puts()).toHaveLength(0)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1', 'w2'])
    expect(useStore.getState().S._ts).toBe(200)
    expect(useStore.getState().S.active).toEqual({ id: 'running' })
    expect(sync()).toEqual({ revs: revs(2), ts: 200 })
  })

  it('does nothing when neither side moved', async () => {
    signedIn({ ...clone(DEF), _ts: 100, workouts: [workout('w1')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 100, workouts: [workout('w1')] }, rev: revs(1) })

    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1'])
  })

  it('pushes when only this device changed', async () => {
    signedIn({ ...clone(DEF), _ts: 150, workouts: [workout('w1')], restSec: 75 })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 100, workouts: [workout('w1')] }, rev: revs(1) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(2) })

    await useStore.getState().pullState()

    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toEqual(revs(1))
    expect(puts()[0].state.restSec).toBe(75)
    expect(sync()).toEqual({ revs: revs(2), ts: 150 })
  })

  // The report: desktop adopted rev 1, the phone logged a workout (rev 2), the desktop changed a
  // setting. One push, against rev 2, carrying both.
  it('merges and pushes once against the server revision when both sides changed', async () => {
    signedIn({ ...clone(DEF), _ts: 300, workouts: [workout('w1')], restSec: 75 })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('from-phone', '2026-09-02')] }, rev: revs(2) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(3) })

    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toEqual(revs(2))
    expect(puts()[0].state.workouts.map(w => w.id)).toEqual(['w1', 'from-phone'])
    expect(puts()[0].state.restSec).toBe(75)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1', 'from-phone'])
    expect(sync().revs).toEqual(revs(3))
    expect(sync().ts).toBe(useStore.getState().S._ts)
    expect(localStorage.getItem('gym_dirty')).toBeNull()
  })

  it('a first pull with a newer server copy adopts it and starts the marker', async () => {
    signedIn(clone(DEF))
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 50, routines: [routine('r')] }, rev: revs(5) })

    await useStore.getState().pullState()

    expect(puts()).toHaveLength(0)
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['r'])
    expect(sync()).toEqual({ revs: revs(5), ts: 50 })
  })

  it('a first pull with a newer local copy pushes it against the server revision', async () => {
    signedIn({ ...clone(DEF), _ts: 500, routines: [routine('local')] })
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 50, routines: [routine('remote')] }, rev: revs(5) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(6) })

    await useStore.getState().pullState()

    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toEqual(revs(5))
    expect(sync()).toEqual({ revs: revs(6), ts: 500 })
  })

  it('a 401 on pull leaves the copy, the marker and the user alone', async () => {
    signedIn({ ...clone(DEF), _ts: 100, workouts: [workout('w1')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudState.mockRejectedValueOnce(httpError(401, {}))

    await useStore.getState().pullState()

    expect(useStore.getState().user).toEqual({ id: 'user-1' })
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1'])
    expect(sync()).toEqual({ revs: revs(1), ts: 100 })
    expect(localStorage.getItem('gym_dirty')).toBeNull()
  })
})

describe('push against a revisioned server', () => {
  it('sends the marker revision as baseRev and records the one it gets back', async () => {
    signedIn({ ...clone(DEF), _ts: 120, routines: [routine('r')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(4), ts: 100 }))
    pushCloudState.mockResolvedValueOnce({ rev: revs(5) })

    await useStore.getState().pushState()

    expect(puts()[0].baseRev).toEqual(revs(4))
    expect(sync()).toEqual({ revs: revs(5), ts: 120 })
  })

  it('a 409 merges the server copy it carries and pushes again against that revision', async () => {
    signedIn({ ...clone(DEF), _ts: 300, workouts: [workout('w1')], restSec: 75 })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    pushCloudState.mockRejectedValueOnce(httpError(409, { data: { rev: revs(2), state: { ...clone(DEF), _ts: 200, workouts: [workout('w1'), workout('w2')] } } }))
    pushCloudState.mockResolvedValueOnce({ rev: revs(3) })

    await useStore.getState().pushState()

    expect(puts()).toHaveLength(2)
    expect(puts()[0].baseRev).toEqual(revs(1))
    expect(puts()[1].baseRev).toEqual(revs(2))
    expect(puts()[1].state.workouts.map(w => w.id)).toEqual(['w1', 'w2'])
    expect(puts()[1].state.restSec).toBe(75)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1', 'w2'])
    expect(sync().revs).toEqual(revs(3))
    expect(localStorage.getItem('gym_dirty')).toBeNull()
  })

  it('gives up after two conflicts in a row and leaves the copy dirty for the next pull', async () => {
    signedIn({ ...clone(DEF), _ts: 300, workouts: [workout('w1')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    const conflict = n => httpError(409, { data: { rev: revs(n), state: { ...clone(DEF), _ts: 200, workouts: [workout('w' + n)] } } })
    pushCloudState.mockRejectedValueOnce(conflict(2)).mockRejectedValueOnce(conflict(3)).mockRejectedValueOnce(conflict(4))

    await useStore.getState().pushState()

    expect(puts()).toHaveLength(3)
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(useStore.getState().S.workouts.map(w => w.id).sort()).toEqual(['w1', 'w2', 'w3'])
  })

  it('a replace meant for the server goes without a baseRev, the change after it with one', async () => {
    vi.useFakeTimers()
    signedIn({ ...clone(DEF), _ts: 100, routines: [routine('old')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(4), ts: 100 }))
    pushCloudState.mockResolvedValueOnce({ rev: revs(5) }).mockResolvedValueOnce({ rev: revs(6) })

    useStore.getState().replaceState({ ...clone(DEF), routines: [routine('imported')] }, true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev == null).toBe(true)
    expect(sync().revs).toEqual(revs(5))

    useStore.getState().update(s => { s.restSec = 45 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts()).toHaveLength(2)
    expect(puts()[1].baseRev).toEqual(revs(5))
  })

  it('a push asked for during a push runs once after it, and the caller waits for it', async () => {
    signedIn({ ...clone(DEF), _ts: 100, routines: [routine('r')] })
    let release
    pushCloudState.mockImplementationOnce(() => new Promise(r => { release = () => r({ rev: revs(1) }) }))
    pushCloudState.mockResolvedValue({ rev: revs(2) })

    const first = useStore.getState().pushState()
    useStore.getState().update(s => { s.restSec = 30 }, false)
    const second = useStore.getState().pushState()
    const third = useStore.getState().pushState()
    expect(puts()).toHaveLength(1)
    release()
    await Promise.all([first, second, third])

    expect(puts()).toHaveLength(2)
    expect(puts()[1].state.restSec).toBe(30)
    expect(sync().revs).toEqual(revs(2))
  })
})

describe('ordering', () => {
  it('a change made before boot is through does not push until it is', async () => {
    vi.useFakeTimers()
    useStore.setState({ S: clone(DEF), user: { id: 'user-1' }, ready: false })
    pushCloudState.mockResolvedValue({ rev: revs(1) })

    useStore.getState().update(s => { s.restSec = 30 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts()).toHaveLength(0)

    // what boot does last, on every path
    useStore.setState({ ready: true })
    useStore.getState().update(s => { s.restSec = 45 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].state.restSec).toBe(45)
  })

  // The change lands while the server copy is still on its way: it is merged into that copy
  // rather than overwritten by it, and the merge is what boot pushes.
  it('boot keeps a change made during its pull and pushes the merge', async () => {
    vi.useFakeTimers()
    useStore.setState({ S: clone(DEF), user: { id: 'user-1' }, ready: false })
    localStorage.setItem('gym_user', JSON.stringify({ id: 'user-1' }))
    getCurrentUser.mockResolvedValue({ id: 'user-1', name: 'One' })
    fetchCloudState.mockImplementationOnce(async () => {
      useStore.getState().update(s => { s.restSec = 30 })   // a change while the pull is in flight
      return { state: { ...clone(DEF), _ts: 10, routines: [routine('r')] }, rev: revs(1) }
    })
    pushCloudState.mockResolvedValue({ rev: revs(2) })

    const boot = useStore.getState().boot()
    await vi.advanceTimersByTimeAsync(10)
    await boot
    await vi.advanceTimersByTimeAsync(2000)

    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toEqual(revs(1))
    expect(puts()[0].state.restSec).toBe(30)
    expect(puts()[0].state.routines.map(r => r.id)).toEqual(['r'])
    expect(useStore.getState().S.restSec).toBe(30)
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['r'])
    expect(useStore.getState().ready).toBe(true)
  })

  it('a pull sends a push still waiting in the debounce first', async () => {
    vi.useFakeTimers()
    signedIn({ ...clone(DEF), _ts: 100, routines: [routine('r')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    pushCloudState.mockResolvedValue({ rev: revs(2) })
    fetchCloudState.mockResolvedValue({ state: { ...clone(DEF), _ts: 100, routines: [routine('r')] }, rev: revs(2) })

    useStore.getState().update(s => { s.restSec = 30 })   // arms the 1.5 s push
    const pull = useStore.getState().pullState()
    await vi.advanceTimersByTimeAsync(10)
    await pull

    expect(pushCloudState).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
    expect(sync().revs).toEqual(revs(2))
  })

  it('coming back to the tab pulls, not twice within 15 s, and going online always does', async () => {
    vi.useFakeTimers()
    signedIn({ ...clone(DEF), _ts: 100, routines: [routine('r')] })
    localStorage.setItem('gym_sync', JSON.stringify({ revs: revs(1), ts: 100 }))
    fetchCloudRev.mockResolvedValue(revs(1))   // unchanged — checkRev never escalates to a full pull
    const visible = () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    await vi.advanceTimersByTimeAsync(16000)   // clear of any check an earlier test made
    visible()
    await vi.advanceTimersByTimeAsync(10)
    expect(gets()).toBe(1)

    window.dispatchEvent(new Event('focus'))
    visible()
    await vi.advanceTimersByTimeAsync(10)
    expect(gets()).toBe(1)

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(10)
    expect(gets()).toBe(2)

    await vi.advanceTimersByTimeAsync(16000)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(10)
    expect(gets()).toBe(3)

    useStore.setState({ user: null })
    await vi.advanceTimersByTimeAsync(16000)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(10)
    expect(gets()).toBe(3)
  })
})
