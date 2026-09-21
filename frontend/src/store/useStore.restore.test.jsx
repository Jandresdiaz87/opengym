// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/cloud-sync.js', async () => {
  const { revsDiffer } = await import('../lib/state-categories.js')
  return { fetchCloudState: vi.fn(), fetchCloudRev: vi.fn(), pushCloudState: vi.fn(), revsDiffer }
})
vi.mock('../lib/supabase.js', () => ({ getCurrentUser: vi.fn(), onAuthStateChange: vi.fn(), signOutSupabase: vi.fn() }))
vi.mock('../lib/api.js', () => ({ setRemoteAuth: vi.fn() }))
// pushState reaches the toast through a lazy import of useUI (which imports this store) — the
// tests only need to see that it was asked, not a rendered toast.
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast }) } }))

import { fetchCloudState, pushCloudState } from '../lib/cloud-sync.js'
import { DEF, hasData, restoredStateFor, useStore } from './useStore.js'

const clone = value => JSON.parse(JSON.stringify(value))
const routine = id => ({ id, name: id, ex: [] })
const workout = id => ({ id, d: '2026-09-01', entries: [] })
const revs = n => ({ routines: n, workouts: n, bodyweight: n, settings: n })
// A brand-new Supabase profile: handle_new_user() gives every signup an (empty) profile_state
// row the instant it's created, so "nothing here yet" is composeFromCategories({}) — the DEF
// defaults, never a literal null the way the old file-backed server answered before its first
// write. {} composed over DEF downstream is exactly that.
const freshProfile = {}
const puts = () => pushCloudState.mock.calls.map(([S, baseRev]) => ({ state: S, baseRev }))

beforeEach(() => {
  localStorage.clear()
  fetchCloudState.mockReset(); pushCloudState.mockReset()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

afterEach(() => {
  localStorage.clear()
  useStore.setState({ S: clone(DEF), user: null, ready: false })
})

describe('saved workout state sync and restore', () => {
  it('returns null for an older or dirty local state', () => {
    const local = { ...clone(DEF), _ts: 20, routines: [routine('local')] }
    const remote = { ...clone(DEF), _ts: 10, routines: [routine('remote')] }

    expect(restoredStateFor(local, remote)).toBeNull()
    expect(restoredStateFor(local, { ...remote, _ts: 30 }, true)).toBeNull()
  })

  it('overlays defaults and carries the device-local active workout', () => {
    const active = { id: 'active-1', routineId: 'local', entries: [] }
    const local = { ...clone(DEF), active }
    const restored = restoredStateFor(local, { _ts: 20, routines: [routine('remote')] })

    expect(restored.routines.map(r => r.id)).toEqual(['remote'])
    expect(restored.active).toEqual(active)
    expect(restored.restSec).toBe(90)
  })

  it('adopts a newer clean remote state while preserving a local active workout', async () => {
    const active = { id: 'active-1', d: '2026-08-29', routineId: 'local', name: 'Local', entries: [] }
    const local = { ...clone(DEF), _ts: 10, routines: [routine('local')], active }
    const remote = { ...clone(DEF), _ts: 20, routines: [routine('remote')], active: null }
    useStore.setState({ S: local, user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockResolvedValue({ state: remote, rev: revs(1) })

    await useStore.getState().pullState()

    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['remote'])
    expect(useStore.getState().S.active).toEqual(active)
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).active).toEqual(active)
    expect(fetchCloudState).toHaveBeenCalledTimes(1)
  })

  it('pushes local data instead of replacing it when the local state is newer', async () => {
    const local = { ...clone(DEF), _ts: 20, routines: [routine('local')] }
    const remote = { ...clone(DEF), _ts: 10, routines: [routine('remote')] }
    useStore.setState({ S: local, user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockResolvedValueOnce({ state: remote, rev: revs(1) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(2) })

    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].state.routines.map(r => r.id)).toEqual(['local'])
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['local'])
  })

  // A dirty copy is one the server has not seen yet — not one that outranks the server's. It is
  // merged with the server copy and the merge is pushed against the server's revision.
  it('merges a dirty local state with the server copy and pushes the merge', async () => {
    const local = { ...clone(DEF), _ts: 10, routines: [routine('local')] }
    const remote = { ...clone(DEF), _ts: 20, routines: [routine('remote')] }
    localStorage.setItem('gym_dirty', '1')
    useStore.setState({ S: local, user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockResolvedValueOnce({ state: remote, rev: revs(3) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(4) })

    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].baseRev).toEqual(revs(3))
    expect(puts()[0].state.routines.map(r => r.id).sort()).toEqual(['local', 'remote'])
    expect(useStore.getState().S.routines.map(r => r.id).sort()).toEqual(['local', 'remote'])
    expect(localStorage.getItem('gym_dirty')).toBeNull()
    expect(JSON.parse(localStorage.getItem('gym_sync'))).toEqual({ revs: revs(4), ts: useStore.getState().S._ts })
  })

  it('restores a remote state over defaults when the local profile is empty', async () => {
    const remote = { _ts: 30, routines: [routine('remote')], workouts: [] }
    fetchCloudState.mockResolvedValue({ state: remote, rev: revs(1) })

    await useStore.getState().pullState()

    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['remote'])
    expect(useStore.getState().S.restSec).toBe(90)
    expect(useStore.getState().S.lang).toBe('en')
  })

  it('keeps the local saved state when the restore request fails', async () => {
    const local = { ...clone(DEF), _ts: 10, routines: [routine('local')] }
    useStore.setState({ S: local, user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockRejectedValue(new Error('offline'))

    await useStore.getState().pullState()

    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['local'])
    expect(fetchCloudState).toHaveBeenCalledTimes(1)
  })

  it('an adopted server state keeps the timestamp it came with', async () => {
    const remote = { ...clone(DEF), _ts: 20, routines: [routine('remote')] }
    useStore.setState({ S: clone(DEF), user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockResolvedValue({ state: remote, rev: revs(1) })

    await useStore.getState().pullState()

    expect(useStore.getState().S._ts).toBe(20)
    expect(JSON.parse(localStorage.getItem('gym_state_v1'))._ts).toBe(20)
  })

  // Device B logs a workout at T1 and pushes it 1.5 s later; device A reloads inside that window
  // and adopts the server copy from T0 < T1. If adopting re-stamped A's copy with its own clock,
  // A's next reload would see the server (T1) as older and push its stale copy over B's workout.
  it('an unchanged adopted copy does not push over a newer change from another device', async () => {
    useStore.setState({ S: clone(DEF), user: { id: 'user-1' }, ready: true })
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 1000000, workouts: [workout('w1')] }, rev: revs(1) })
    await useStore.getState().pullState()
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1'])

    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 1010000, workouts: [workout('w1'), workout('w2-from-B')] }, rev: revs(2) })
    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(2)
    expect(pushCloudState).not.toHaveBeenCalled()
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w1', 'w2-from-B'])
    expect(useStore.getState().S._ts).toBe(1010000)
  })
})

// The saved copy is owned by whoever last signed in on this device. An expired or revoked session
// only drops the user (boot's no-session path), so the data is still here when the next profile
// signs in.
describe('signing in as a different profile', () => {
  const active = { id: 'A-active', d: '2026-09-01', routineId: 'A', name: 'A', entries: [] }
  const signInAsAThenExpire = () => {
    useStore.getState().setUser({ id: 'A', name: 'A' })
    useStore.getState().replaceState({ ...clone(DEF), _ts: 20, routines: [routine('A-routine')], bodyweight: [{ d: '2026-09-01', kg: 80 }], active })
    useStore.getState().setUser(null)
    expect(hasData(useStore.getState().S)).toBe(true)
  }

  it('does not move the previous profile data into a brand-new account', async () => {
    signInAsAThenExpire()
    fetchCloudState.mockResolvedValue({ state: freshProfile, rev: revs(0) })

    useStore.getState().setUser({ id: 'B', name: 'B' })
    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(pushCloudState).not.toHaveBeenCalled()   // nothing was pushed under B
    expect(useStore.getState().S.routines).toEqual([])
    expect(useStore.getState().S.bodyweight).toEqual([])
    expect(useStore.getState().S.active).toBeNull()
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).routines).toEqual([])
    expect(localStorage.getItem('gym_owner')).toBe('B')
  })

  it('adopts the new profile own state even when it is older or a push failed after expiry', async () => {
    signInAsAThenExpire()
    localStorage.setItem('gym_dirty', '1')   // a debounced push that hit "not signed in"
    const remoteB = { ...clone(DEF), _ts: 10, routines: [routine('B-routine')], active: null }
    fetchCloudState.mockResolvedValue({ state: remoteB, rev: revs(1) })

    useStore.getState().setUser({ id: 'B', name: 'B' })
    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['B-routine'])
    expect(useStore.getState().S.active).toBeNull()   // A's in-progress workout is not carried over
    expect(localStorage.getItem('gym_dirty')).toBeNull()
  })

  it('the same profile signing in again keeps and pushes its newer local copy', async () => {
    signInAsAThenExpire()
    fetchCloudState.mockResolvedValueOnce({ state: { ...clone(DEF), _ts: 10, routines: [routine('remote')] }, rev: revs(1) })
    pushCloudState.mockResolvedValueOnce({ rev: revs(2) })

    useStore.getState().setUser({ id: 'A', name: 'A' })
    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].state.routines.map(r => r.id)).toEqual(['A-routine'])
    expect(useStore.getState().S.active).toEqual(active)
  })

  // The check above runs in the tab that signs in. A second tab of the same browser still holding
  // A learns about B through the storage event the sign-in fires.
  it('a tab still holding the previous profile drops it when another profile signs in elsewhere', async () => {
    vi.useFakeTimers()
    try {
      useStore.getState().setUser({ id: 'A', name: 'A' })
      useStore.setState({ ready: true })   // boot has finished in this tab — arms a real debounce timer below, not pushPending
      useStore.getState().replaceState({ ...clone(DEF), _ts: 20, routines: [routine('A-routine')], active }, true)   // arms a push
      pushCloudState.mockResolvedValue({ rev: revs(1) })

      // B's setUser in the other tab: it wiped the copy, wrote defaults, then recorded the owner.
      // B's own data only lands there after its pull — this tab never re-reads it.
      localStorage.setItem('gym_state_v1', JSON.stringify({ ...clone(DEF), _ts: 30 }))
      localStorage.setItem('gym_owner', 'B')
      window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'A', newValue: 'B' }))

      expect(useStore.getState().user).toBeNull()
      expect(hasData(useStore.getState().S)).toBe(false)
      expect(useStore.getState().S.active).toBeNull()

      vi.advanceTimersByTime(3000)   // the push armed under A must not fire under B's session
      useStore.getState().update(s => { s.routines.push(routine('typed-after')) })
      vi.advanceTimersByTime(3000)
      await useStore.getState().pushState()

      expect(pushCloudState).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem('gym_state_v1')).routines.map(r => r.id)).toEqual(['typed-after'])
    } finally { vi.useRealTimers() }
  })

  // A sign-out elsewhere removes the owner. Storage events arrive per key, so this tab may see
  // the owner go while gym_state_v1 still holds A's copy — it must not keep that copy either way.
  it('a tab still holding the previous profile drops its data when that profile signs out elsewhere', async () => {
    useStore.getState().setUser({ id: 'A', name: 'A' })
    useStore.getState().replaceState({ ...clone(DEF), _ts: 20, routines: [routine('A-routine')], bodyweight: [{ d: '2026-09-01', kg: 80 }], active })
    fetchCloudState.mockResolvedValue({ state: freshProfile, rev: revs(0) })

    localStorage.removeItem('gym_owner')   // gym_state_v1 still holds A's copy at this instant
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'A', newValue: null }))

    expect(useStore.getState().user).toBeNull()
    expect(hasData(useStore.getState().S)).toBe(false)
    expect(useStore.getState().S.active).toBeNull()

    useStore.getState().setUser({ id: 'C', name: 'C' })
    await useStore.getState().pullState()

    expect(fetchCloudState).toHaveBeenCalledTimes(1)   // nothing of A's was pushed under C
    expect(pushCloudState).not.toHaveBeenCalled()
    expect(hasData(useStore.getState().S)).toBe(false)
  })

  // The listener above reacts to the owner key alone, so the wiped copy has to be in storage
  // before the owner is removed — the same order setUser uses when it records a new owner.
  it('signing out removes the owner only after the wiped copy is written', async () => {
    useStore.getState().setUser({ id: 'A', name: 'A' })
    useStore.getState().replaceState({ ...clone(DEF), _ts: 20, routines: [routine('A-routine')] })
    pushCloudState.mockResolvedValue({ rev: revs(1) })

    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const real = globalThis.localStorage
    const writes = []
    const recording = new Proxy(real, {
      get(target, prop) {
        const v = Reflect.get(target, prop)
        if (prop === 'setItem' || prop === 'removeItem') return (...args) => { writes.push(prop + ' ' + args[0]); return v.apply(target, args) }
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    Object.defineProperty(globalThis, 'localStorage', { value: recording, configurable: true })
    try { await useStore.getState().signOut() }
    finally { Object.defineProperty(globalThis, 'localStorage', desc) }

    expect(globalThis.localStorage).toBe(real)
    expect(writes).toContain('removeItem gym_owner')
    expect(writes.lastIndexOf('removeItem gym_owner')).toBeGreaterThan(writes.lastIndexOf('setItem gym_state_v1'))
    expect(writes.lastIndexOf('removeItem gym_owner')).toBeGreaterThan(writes.lastIndexOf('removeItem gym_state_v1'))
    expect(localStorage.getItem('gym_owner')).toBeNull()
    expect(JSON.parse(localStorage.getItem('gym_state_v1')).routines).toEqual([])
  })

  it('a storage event for another key or the same profile changes nothing', () => {
    useStore.getState().setUser({ id: 'A', name: 'A' })
    useStore.getState().replaceState({ ...clone(DEF), _ts: 20, routines: [routine('A-routine')] })

    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_state_v1', newValue: '{}' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'gym_owner', oldValue: 'A', newValue: 'A' }))

    expect(useStore.getState().user).toEqual({ id: 'A', name: 'A' })
    expect(useStore.getState().S.routines.map(r => r.id)).toEqual(['A-routine'])
  })

  it('guest data built after a sign-out still moves into a newly created profile', async () => {
    pushCloudState.mockResolvedValue({ rev: revs(1) })
    useStore.getState().setUser({ id: 'A', name: 'A' })
    await useStore.getState().signOut()
    expect(localStorage.getItem('gym_owner')).toBeNull()
    expect(hasData(useStore.getState().S)).toBe(false)

    useStore.getState().update(s => { s.routines.push(routine('guest')) }, false)
    pushCloudState.mockClear()
    useStore.getState().setUser({ id: 'B', name: 'B' })
    expect(hasData(useStore.getState().S)).toBe(true)   // what the sign-up flow checks before pushing
    await useStore.getState().pushState()

    expect(puts()).toHaveLength(1)
    expect(puts()[0].state.routines.map(r => r.id)).toEqual(['guest'])
  })
})
