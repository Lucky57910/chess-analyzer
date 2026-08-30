import { useEffect, useRef, useState } from 'react'
import Button from '../components/ui/Button'
import { Panel } from '../components/ui/Card'
import Segmented from '../components/ui/Segmented'
import { PROVIDERS } from '../coach/providers.js'
import { backupFilename } from '../data/backup'
import { saveAndShare } from '../data/share'
import { useQueue } from '../hooks/useQueue'
import { useSettings } from '../hooks/useSettings'
import { api } from '../utils/api'

const inputClass =
  'min-h-11 w-full rounded-lg border border-line-strong bg-canvas px-3 text-body text-text placeholder:text-faint'

/**
 * The coach's provider, model and key.
 *
 * The key is write-only: the field is empty on arrival and the screen says
 * whether one is stored rather than showing it. There is nothing to gain from
 * rendering a secret that is only ever sent to one host, and a screenshot of
 * this page should not be a leak.
 */
function CoachSettings({ config, onSave, busy }) {
  const [provider, setProvider] = useState(config?.provider ?? 'gemini')
  const [model, setModel] = useState(config?.model ?? '')
  const [key, setKey] = useState('')
  const adapter = PROVIDERS[provider] ?? PROVIDERS.gemini

  // Picking a provider resets the model, because a model name belongs to one
  // provider and the stored one is cleared on the same event.
  function pickProvider(next) {
    setProvider(next)
    setModel(PROVIDERS[next].models[0])
  }

  return (
    <Panel
      title="Coach IA"
      hint="Un commentaire écrit pour chacun de vos coups, à partir de ce que Stockfish a trouvé. Facultatif : sans clé, l’application continue d’expliquer les coups avec le moteur seul."
      bodyClass="flex flex-col gap-4 p-4"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-label text-faint">Fournisseur</span>
        <Segmented
          label="Fournisseur du coach"
          value={provider}
          options={Object.values(PROVIDERS).map((p) => ({ key: p.key, label: p.label }))}
          onChange={pickProvider}
          className="self-start"
        />
        <p className="text-label leading-relaxed text-faint">{adapter.note}</p>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-label text-faint">Modèle</span>
        <select
          value={model || adapter.models[0]}
          onChange={(e) => setModel(e.target.value)}
          className={inputClass}
        >
          {adapter.models.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-label text-faint">
          Clé API {config?.key_set ? '· une clé est enregistrée' : '· aucune clé enregistrée'}
        </span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={config?.key_set ? 'Laisser vide pour conserver la clé' : 'Collez votre clé'}
          autoComplete="off"
          spellCheck="false"
          className={inputClass}
        />
        <a
          href={adapter.keyUrl}
          target="_blank"
          rel="noreferrer"
          className="text-label text-accent underline underline-offset-2"
        >
          Obtenir une clé gratuite sur {new URL(adapter.keyUrl).host}
        </a>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            // An untouched field means "leave the stored key alone", which is
            // why it is `undefined` rather than the empty string here.
            onSave({ provider, model: model || adapter.models[0], ...(key ? { apiKey: key } : {}) })
            setKey('')
          }}
        >
          Enregistrer
        </Button>
        {config?.key_set && (
          <Button variant="danger" disabled={busy} onClick={() => onSave({ apiKey: '' })}>
            Oublier la clé
          </Button>
        )}
      </div>

      {/* Two things the user has to be told before turning this on, and the
          screen is the only place they will read them. */}
      <div className="flex flex-col gap-2 rounded-lg border border-inaccuracy/40 bg-inaccuracy/10 px-3 py-2">
        <p className="text-label leading-relaxed text-muted">
          <span className="font-medium text-inaccuracy">Vos parties quittent le téléphone.</span>{' '}
          Activer le coach envoie à {adapter.label} ce que le moteur a trouvé sur vos coups.{' '}
          {adapter.key === 'gemini'
            ? 'Depuis l’Europe, Google applique au palier gratuit les règles du palier payant : ce contenu ne sert pas à entraîner ses modèles. Ses conditions réservent en revanche le palier gratuit au développement — partager cette application avec d’autres personnes en Europe demanderait un palier payant.'
            : 'Sur un palier gratuit, ce contenu sert en général à entraîner les modèles du fournisseur ; les paliers payants ne le font pas.'}{' '}
          Rien n’est envoyé tant que vous n’appuyez pas sur le bouton, sur l’écran d’une partie.
        </p>
        <p className="text-label leading-relaxed text-muted">
          <span className="font-medium text-inaccuracy">La clé est stockée en clair</span> dans la
          base locale, protégée par le bac à sable Android et le chiffrement du téléphone — pas par
          un secret séparé.
        </p>
      </div>

      <p className="text-label leading-relaxed text-faint">
        Le commentaire est conservé après sa génération : il n’est demandé qu’une fois. Une
        ré-analyse Stockfish l’efface, parce que les jugements qu’il décrit ont changé.
      </p>
    </Panel>
  )
}

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

  async function saveCoach(patch) {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await update({ coach: patch })
      setMessage(
        patch.apiKey === '' ? 'Clé oubliée.' : 'Réglages du coach enregistrés.',
      )
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
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-semibold">Réglages</h1>

      <Panel title="Compte Chess.com" bodyClass="p-4">
        <form onSubmit={save} className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="pseudo Chess.com"
            aria-label="pseudo Chess.com"
            className={inputClass}
          />
          {/* `type` reaches the underlying element through the rest props, so
              this really does submit the form - no onClick, or the handler
              would run twice. */}
          <Button type="submit" variant="primary" disabled={busy}>
            Enregistrer
          </Button>
        </form>
        <p className="mt-2 text-label leading-relaxed text-faint">
          L’API publique de Chess.com ne demande aucun mot de passe : seul le pseudo est nécessaire
          pour lire vos parties.
          {settings?.last_synced_at && (
            <> Dernier import : {new Date(settings.last_synced_at).toLocaleString('fr-FR')}.</>
          )}
        </p>
      </Panel>

      <CoachSettings config={settings?.coach} onSave={saveCoach} busy={busy} />

      <Panel title="Importer l’historique" bodyClass="p-4">
        <div className="flex items-center gap-2">
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            aria-label="Profondeur de l’import"
            className="min-h-11 rounded-lg border border-line-strong bg-canvas px-3 text-body text-text"
          >
            {[1, 3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>
                {m} mois
              </option>
            ))}
          </select>
          <Button onClick={importHistory} disabled={busy || !username} icon="refresh">
            {busy ? 'Import…' : 'Importer'}
          </Button>
        </div>
        <p className="mt-2 text-label text-faint">
          L’import ne récupère que les parties ; l’analyse se lance séparément.
        </p>
      </Panel>

      <Panel title="File d’analyse" bodyClass="p-4">
        <p className="text-body text-muted">
          {status
            ? `${status.done} analysées · ${queued} en attente${
                status.stale ? ` · ${status.stale} à réanalyser plus profondément` : ''
              }${status.error ? ` · ${status.error} en échec` : ''}`
            : '—'}
        </p>
        <Button
          variant="primary"
          onClick={running ? stop : start}
          disabled={!running && queued === 0 && !status?.stale}
          className="mt-3"
        >
          {running ? 'Arrêter l’analyse' : 'Lancer l’analyse'}
        </Button>
        {/* Worth saying once, plainly: this is why the app has no background
            sync and why the phone gets warm. */}
        <p className="mt-2 text-label leading-relaxed text-faint">
          L’analyse tourne uniquement quand l’application est ouverte. Android n’autorise pas un
          calcul aussi long en arrière-plan, et un téléphone qui analyse des parties dans une poche
          se viderait en quelques heures.
        </p>
      </Panel>

      <Panel title="Moteur d’analyse" bodyClass="p-4">
        {health ? (
          <p className="text-body">
            {health.engine.available ? (
              <span className="text-good">
                {health.engine.name} · profondeur {health.engine_depth}
                {health.cpu_abi && <span className="text-faint"> · {health.cpu_abi}</span>}
              </span>
            ) : (
              <span className="text-blunder">Stockfish indisponible : {health.engine.error}</span>
            )}
          </p>
        ) : (
          <p className="text-body text-faint">État du moteur inconnu.</p>
        )}
      </Panel>

      <Panel title="Sauvegarde" bodyClass="p-4">
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportBackup} disabled={busy}>
            Exporter
          </Button>
          <Button onClick={() => fileInput.current?.click()} disabled={busy}>
            Restaurer
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            onChange={restoreBackup}
            className="hidden"
          />
        </div>
        {/* The reason this screen has a backup button at all, said once. */}
        <p className="mt-2 text-label leading-relaxed text-faint">
          Tout est stocké sur ce téléphone : une désinstallation ou un appareil perdu emporte les
          analyses, que Chess.com ne peut pas rendre. L’export produit un fichier JSON à envoyer
          ailleurs. La restauration ajoute ce qui manque et n’écrase jamais une partie déjà
          présente.
        </p>
      </Panel>

      {message && (
        <p
          role="status"
          className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-body text-good"
        >
          {message}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-blunder/40 bg-blunder/10 px-3 py-2 text-body text-blunder"
        >
          {error}
        </p>
      )}
    </div>
  )
}
