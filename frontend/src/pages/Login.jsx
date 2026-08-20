import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const field =
  'w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-accent focus:outline-none'

export default function Login() {
  const { user, login, register } = useAuth()
  const [mode, setMode] = useState('login')
  const [form, setForm] = useState({
    username: '',
    password: '',
    chess_com_username: '',
    registration_code: '',
  })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  if (user) return <Navigate to="/" replace />

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  async function onSubmit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(form.username, form.password)
      } else {
        await register({
          username: form.username,
          password: form.password,
          chess_com_username: form.chess_com_username || null,
          registration_code: form.registration_code || null,
        })
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">♞ Chess Analyzer</h1>
        <p className="mb-6 text-sm text-ink-500">
          Vos parties Chess.com, analysées par Stockfish.
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            className={field}
            placeholder="Identifiant"
            autoComplete="username"
            value={form.username}
            onChange={set('username')}
            required
            minLength={3}
          />
          <input
            className={field}
            type="password"
            placeholder="Mot de passe"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
          />

          {mode === 'register' && (
            <>
              <input
                className={field}
                placeholder="Pseudo Chess.com"
                value={form.chess_com_username}
                onChange={set('chess_com_username')}
              />
              <input
                className={field}
                placeholder="Code d'inscription (si demandé)"
                value={form.registration_code}
                onChange={set('registration_code')}
              />
            </>
          )}

          {error && (
            <p className="rounded-md border border-blunder/40 bg-blunder/10 px-3 py-2 text-sm text-blunder">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer le compte'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login')
            setError(null)
          }}
          className="mt-4 w-full text-center text-sm text-ink-500 hover:text-ink-300"
        >
          {mode === 'login' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
        </button>
      </div>
    </div>
  )
}
