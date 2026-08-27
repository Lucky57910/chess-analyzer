import { useEffect, useRef, useState } from 'react'
import { backupFilename } from '../data/backup'
import { saveAndShare } from '../data/share'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'
import { api } from '../utils/api'

export default function Settings() {
  const { settings, username, update } = useSettings()
  const { running, status, start, stop, refreshStatus } = useQueue()
  // Shell holds the page back until the settings have loaded, so the stored
  // username is already here on the first render and needs no effect to
  // arrive later.
  const [name, setName] = useState(username)
  const [months, setMonths] = useState(3)
  const [health, setHealth] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef(null)

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await update({ chess_com_username: name })
      setMessage('Compte Chess.com enregistré. Lancez un import pour récupérer vos parties.')
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
      await refreshStatus()
      setMessage(
        `${res.imported} partie(s) importée(s)` +
          (res.updated ? `, ${res.updated} mise(s) à jour` : '') +
          `, ${res.pending_analysis} en file d’analyse.`,
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function exportBackup() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const payload = await api.exportBackup()
      const name = backupFilename()
      const { uri, shared } = await saveAndShare(name, JSON.stringify(payload), {
        title: 'Sauvegarde Chess Analyzer',
      })
      const analysed = payload.games.filter((g) => g.analysis).length
      setMessage(
        `${payload.games.length} partie(s) dont ${analysed} analysée(s) exportée(s).` +
          (shared ? '' : ` Fichier enregistré : ${uri}`),
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0]
    // Clearing it lets the user pick the same file again after a failure.
    event.target.value = ''
    if (!file) return

    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.importBackup(JSON.parse(await file.text()))
      await refreshStatus()
      setMessage(
        `${res.games} partie(s) et ${res.analyses} analyse(s) restaurées` +
          (res.skipped ? `, ${res.skipped} déjà présente(s)` : '') +
          '.',
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const queued = (status?.pending ?? 0) + (status?.running ?? 0)

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
          {settings?.last_synced_at && (
            <> Dernier import : {new Date(settings.last_synced_at).toLocaleString('fr-FR')}.</>
          )}
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
            disabled={busy || !username}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? 'Import…' : 'Importer'}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-500">
          L’import ne récupère que les parties ; l’analyse se lance séparément.
        </p>
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">File d’analyse</h2>
        <p className="mt-2 text-sm text-ink-300">
          {status
            ? `${status.done} analysées · ${queued} en attente${
                status.stale ? ` · ${status.stale} à réanalyser plus profondément` : ''
              }${status.error ? ` · ${status.error} en échec` : ''}`
            : '—'}
        </p>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={!running && queued === 0 && !status?.stale}
          className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-medium text-ink-950 disabled:opacity-50"
        >
          {running ? 'Arrêter l’analyse' : 'Lancer l’analyse'}
        </button>
        {/* Worth saying once, plainly: this is why the app has no background
            sync and why the phone gets warm. */}
        <p className="mt-2 text-xs text-ink-500">
          L’analyse tourne uniquement quand l’application est ouverte. Android n’autorise pas un
          calcul aussi long en arrière-plan, et un téléphone qui analyse des parties dans une
          poche se viderait en quelques heures.
        </p>
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">Moteur d’analyse</h2>
        {health ? (
          <p className="mt-2 text-sm">
            {health.engine.available ? (
              <span className="text-good">
                {health.engine.name} · profondeur {health.engine_depth}
                {health.cpu_abi && <span className="text-ink-500"> · {health.cpu_abi}</span>}
              </span>
            ) : (
              <span className="text-blunder">
                Stockfish indisponible : {health.engine.error}
              </span>
            )}
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-500">État du moteur inconnu.</p>
        )}
      </section>

      <section className="rounded-lg border border-ink-800 bg-ink-900 p-4">
        <h2 className="text-sm font-medium text-ink-300">Sauvegarde</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportBackup}
            disabled={busy}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            Exporter
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-50"
          >
            Restaurer
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            onChange={restoreBackup}
            className="hidden"
          />
        </div>
        {/* The reason this screen has a backup button at all, said once. */}
        <p className="mt-2 text-xs text-ink-500">
          Tout est stocké sur ce téléphone : une désinstallation ou un appareil perdu emporte les
          analyses, que Chess.com ne peut pas rendre. L’export produit un fichier JSON à envoyer
          ailleurs. La restauration ajoute ce qui manque et n’écrase jamais une partie déjà
          présente.
        </p>
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
