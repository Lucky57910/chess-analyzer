import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { api } from '../utils/api'

export default function Settings() {
  const { user, refreshUser } = useAuth()
  const [name, setName] = useState(user?.chess_com_username || '')
  const [months, setMonths] = useState(3)
  const [health, setHealth] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await api.updateMe({ chess_com_username: name.trim() })
      await refreshUser()
      setMessage('Compte Chess.com enregistré. Import en cours en arrière-plan.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function importHistory() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.sync(months)
      setMessage(`${res.imported} partie(s) importée(s), ${res.pending_analysis} en file d'analyse.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold">Réglages</h1>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">Compte Chess.com</h2>
        <form onSubmit={save} className="mt-3 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="pseudo Chess.com"
            className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink-950 disabled:opacity-50"
          >
            Enregistrer
          </button>
        </form>
        <p className="mt-2 text-xs text-ink-500">
          L’API publique de Chess.com ne demande aucun mot de passe : seul le pseudo est
          nécessaire pour lire vos parties.
        </p>
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">Importer l’historique</h2>
        <div className="mt-3 flex items-center gap-2">
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm"
          >
            {[1, 3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>
                {m} mois
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={importHistory}
            disabled={busy || !user?.chess_com_username}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? 'Import…' : 'Importer'}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Les nouvelles parties sont détectées automatiquement toutes les{' '}
          {health?.poll_interval_seconds ?? 15} s, et un rattrapage est lancé à chaque connexion.
        </p>
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">Moteur d’analyse</h2>
        {health ? (
          <p className="mt-2 text-sm">
            {health.engine.available ? (
              <span className="text-good">
                {health.engine.name} · profondeur {health.engine_depth}
              </span>
            ) : (
              <span className="text-blunder">
                Stockfish indisponible : {health.engine.error}
              </span>
            )}
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-500">Backend injoignable.</p>
        )}
      </section>

      {message && (
        <p className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-md border border-blunder/40 bg-blunder/10 px-3 py-2 text-sm text-blunder">
          {error}
        </p>
      )}
    </div>
  )
}
