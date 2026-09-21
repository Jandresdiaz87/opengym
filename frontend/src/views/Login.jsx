import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { signInWithGoogle, signInWithPassword, signUpWithPassword } from '../lib/supabase.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { askAddDeviceData } from '../sheets.jsx'

// Runs after any successful sign-in (password) or sign-up: the server's profile is the truth,
// with the device's own guest-mode entries offered as an add-in — same contract passkey sign-in
// used, and adoptProfile already knows how to ask about it.
async function afterSignIn(user, { justCreated } = {}) {
  useStore.getState().setUser(user)
  if (justCreated && hasData(useStore.getState().S)) {
    await useStore.getState().pushState()
    useUI.getState().toast(t('Profile created — data from this device moved into it'))
  } else {
    await useStore.getState().adoptProfile(askAddDeviceData)
    useUI.getState().toast(justCreated ? t('Welcome, {0}', user.name) : t('Welcome back, {0}', user.name))
  }
}

function EmailPasswordSheet({ close, mode }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingConfirm, setPendingConfirm] = useState(false)
  const ref = useRef(null)
  const isSignUp = mode === 'signup'
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])

  const go = async () => {
    const em = email.trim()
    const pw = password
    if (!em || !pw) { useUI.getState().toast(t('Enter an email and password')); return }
    if (isSignUp && !name.trim()) { useUI.getState().toast(t('Enter a name')); return }
    setBusy(true)
    try {
      if (isSignUp) {
        const { user, needsEmailConfirmation } = await signUpWithPassword(em, pw, name.trim())
        if (needsEmailConfirmation) { setPendingConfirm(true); return }
        await afterSignIn(user, { justCreated: true })
        close()
      } else {
        const user = await signInWithPassword(em, pw)
        await afterSignIn(user)
        close()
      }
    } catch (e) {
      useUI.getState().toast(e.message || t('Something went wrong'))
    } finally {
      setBusy(false)
    }
  }

  if (pendingConfirm) return <>
    <h3>{t('Check your email')}</h3>
    <div className="muted small">{t('We sent a confirmation link to {0}. Open it, then come back and sign in.', email.trim())}</div>
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={close}>{t('Got it')}</Button>
  </>

  return <>
    <h3>{isSignUp ? t('Create your profile') : t('Sign in')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {isSignUp ? t('Your workouts, plan and body weight sync to this account.') : t('Sign in with your email and password.')}
    </div>
    {isSignUp && <>
      <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
      <div style={{ height: 10 }} />
    </>}
    <input ref={isSignUp ? undefined : ref} className="input" type="email" autoComplete="email" placeholder={t('Email')} value={email} onChange={e => setEmail(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" autoComplete={isSignUp ? 'new-password' : 'current-password'} placeholder={t('Password')} value={password}
      onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={go}>{isSignUp ? t('Create profile') : t('Sign in')}</Button>
  </>
}

export default function Login() {
  const { setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const google = async () => {
    try { await signInWithGoogle() }   // redirects away; the app reloads signed in
    catch (e) { useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
  const head = <>
    <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div>
    <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>Cospel</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div>
      <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Signing in and sync across your devices come with your own Cospel instance.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
      <Button variant="primary" onClick={google}>{t('Continue with Google')}</Button>
      <div style={{ height: 10 }} />
      <Button icon="person" onClick={() => useUI.getState().openSheet(close => <EmailPasswordSheet close={close} mode="signin" />)}>{t('Sign in with email')}</Button>
      <div style={{ height: 10 }} />
      <Button icon="sparkles" onClick={() => useUI.getState().openSheet(close => <EmailPasswordSheet close={close} mode="signup" />)}>{t('Create new profile')}</Button>
      {canGuest && <div style={{ height: 10 }} />}
      {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
      <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Each profile keeps its own plan, workouts & body weight.')}</div>
    </div>
  )
}
