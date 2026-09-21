// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// "Reset everything" is one dialog with two truths. A guest's data lives in this browser only.
// A signed-in profile pushes the empty state to the server like any other change (replaceState's
// force flag), so the wipe reaches every device that syncs with it.
const mocks = vi.hoisted(() => {
  const state = { S: null, user: null }
  state.replaceState = vi.fn()
  state.confirmSheet = vi.fn()
  state.api = vi.fn(() => Promise.resolve({ ok: true }))
  state.toast = vi.fn()
  state.snapshot = () => ({
    S: state.S,
    user: state.user,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
    replaceState: state.replaceState, setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(),
    signOut: vi.fn(), signOutAll: vi.fn(), resetDemo: vi.fn(), disconnectServer: vi.fn(),
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' }, workouts: [] }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => mocks.toast(...a), openSheet: vi.fn() })
  const useUI = selector => selector ? selector(snap()) : snap()
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../lib/api.js', () => ({
  api: (...a) => mocks.api(...a), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false,
}))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn() }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => false }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), confirmSheet: (...a) => mocks.confirmSheet(...a), importFromApp: vi.fn(),
  importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), menuSheet: vi.fn(),
}))

globalThis.__APP_VERSION__ ??= 'test'

let host, root
beforeEach(() => {
  mocks.S = {
    unit: 'kg', restSec: 90, restPauseSec: 15, sound: false, effort: 'none',
    gifSize: 'full', workouts: [], routines: [], exWeights: {},
  }
  mocks.user = null
  mocks.replaceState.mockClear()
  mocks.confirmSheet.mockClear()
  mocks.api.mockClear()
  mocks.toast.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = () => act(() => root.render(<Settings />))
const resetRow = () => [...host.querySelectorAll('.lrow')].find(r => r.textContent.includes('Reset everything'))
const openDialog = () => {
  act(() => { resetRow().click() })
  expect(mocks.confirmSheet).toHaveBeenCalledTimes(1)
  return mocks.confirmSheet.mock.calls[0][0]
}

describe('Settings — reset everything', () => {
  it('guest: says the wipe is local and resets to the defaults', () => {
    mount()
    const dialog = openDialog()
    expect(dialog.title).toBe('Reset everything?')
    expect(dialog.message).toBe('Deletes your plan, workouts and body weight on this device. This cannot be undone.')
    act(() => { dialog.onConfirm() })
    expect(mocks.replaceState).toHaveBeenCalledTimes(1)
    expect(mocks.replaceState.mock.calls[0]).toEqual([{ reminder: { time: '17:30' }, workouts: [] }, true])
    expect(mocks.toast).toHaveBeenCalledWith('All data reset')
  })

  it('signed in: says the wipe reaches the server and every device, and force-pushes the empty state', () => {
    mocks.user = { uid: 'u1', name: 'Ana' }
    mount()
    const dialog = openDialog()
    expect(dialog.message).toBe('Deletes your plan, workouts and body weight from your profile on this server and on every signed-in device. This cannot be undone.')
    act(() => { dialog.onConfirm() })
    expect(mocks.replaceState).toHaveBeenCalledTimes(1)
    expect(mocks.replaceState.mock.calls[0][1]).toBe(true)
    expect(mocks.toast).toHaveBeenCalledWith('All data reset')
  })
})
