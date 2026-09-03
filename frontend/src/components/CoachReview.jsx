/**
 * What the coach has to say about all of it.
 *
 * Every other panel on this screen is a number. This is the one that says what
 * to *do* about the numbers — and the reason it can be trusted is printed
 * underneath each finding: the rows of the archive it was computed from. A
 * claim the model could not attach to a number never reached the screen
 * (`validateReview` drops it); the ones that did can be checked here, which is
 * the difference between a coach and a horoscope with a chess vocabulary.
 *
 * Deliberately a button rather than something that runs on opening the screen:
 * it is a request to somebody's paid or rate-limited account, and one review a
 * week says as much as one a day.
 */

import { useEffect, useState } from 'react'
import Icon from './Icon'
import Button from './ui/Button'
import { Panel } from './ui/Card'
import { useSettings } from '../hooks/useSettings'
import { PROVIDERS } from '../coach/providers.js'
import { api } from '../utils/api'

/** "il y a 3 jours", because the date of a review matters more than the hour. */
function When({ iso }) {
  if (!iso) return null
  const date = new Date(iso)
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  const said =
    days <= 0 ? 'aujourd’hui' : days === 1 ? 'hier' : `il y a ${days} jours`
  return <>{said}</>
}

/** One thing the coach saw, with the numbers it saw it in. */
function Finding({ finding, facts, rank }) {
  const [open, setOpen] = useState(false)
  const cited = finding.evidence
    .map((key) => facts.find((fact) => fact.key === key))
    .filter(Boolean)

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-label text-faint tabular-nums">{rank}</span>
        <h3 className="text-body font-medium text-text">{finding.title}</h3>
      </div>
      <p className="mt-1 pl-6 text-body leading-relaxed text-muted">{finding.detail}</p>

      {finding.drill && (
        <p className="mt-2 ml-6 flex items-start gap-2 rounded-lg bg-raised px-3 py-2 text-body leading-snug text-text">
          <Icon name="spar" size={14} className="mt-1 text-accent" />
          <span>
            <span className="text-label text-faint">Exercice · </span>
            {finding.drill}
          </span>
        </p>
      )}

      {/* The receipts. A finding that cannot show them would not have survived
          validation, so this is never empty for a stored review. */}
      {cited.length > 0 && (
        <div className="mt-2 pl-6">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="min-h-8 text-label text-faint underline decoration-dotted underline-offset-2 hover:text-muted"
          >
            {open ? 'Masquer les chiffres' : `D’où ça sort (${cited.length})`}
          </button>
          {open && (
            <ul className="mt-1 flex flex-col gap-1">
              {cited.map((fact) => (
                <li key={fact.key} className="text-label leading-snug text-faint">
                  <span className="font-mono text-muted">{fact.key}</span> — {fact.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export default function CoachReview({ kind = 'rated' }) {
  const [review, setReview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const { settings } = useSettings()

  useEffect(() => {
    api
      .latestReview()
      .then(setReview)
      .catch(() => setReview(null))
  }, [])

  const ready = Boolean(settings?.coach?.key_set)

  async function ask() {
    setBusy(true)
    setStatus(null)
    try {
      const written = await api.coachReview({
        kind,
        onWait: (seconds) => setStatus(`Limite du modèle atteinte, reprise dans ${seconds} s…`),
        onFallback: (label) => setStatus(`Fournisseur indisponible, on passe à ${label}…`),
      })
      setReview(written)
      setStatus(null)
    } catch (err) {
      setStatus(err.message)
    } finally {
      setBusy(false)
    }
  }

  const provider = review?.provider ? PROVIDERS[review.provider]?.label : null

  return (
    <Panel
      title="Bilan du coach"
      hint="Ce que disent toutes vos parties ensemble, pas une seule."
      action={
        ready ? (
          <Button size="sm" variant={review ? 'ghost' : 'primary'} icon="coach" onClick={ask} disabled={busy}>
            {busy ? 'Le coach lit vos parties…' : review ? 'Refaire le bilan' : 'Demander un bilan'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="coach" to="/settings">
            Activer le coach IA
          </Button>
        )
      }
    >
      {status && (
        <p className="px-4 py-2 text-label text-faint" role="status">
          {status}
        </p>
      )}

      {review ? (
        <>
          <p className="px-4 pt-2 text-label text-faint">
            Écrit <When iso={review.created_at} /> sur {review.games} parties analysées
            {provider ? ` · ${provider}` : ''}.
          </p>
          <ul className="divide-y divide-line">
            {review.findings.map((finding, i) => (
              <Finding key={i} finding={finding} facts={review.facts ?? []} rank={i + 1} />
            ))}
          </ul>
        </>
      ) : (
        !busy &&
        !status && (
          <p className="px-4 py-6 text-body text-faint">
            Le coach n’a pas encore regardé l’ensemble de vos parties. Il lit les chiffres de cet
            écran — jamais les parties elles-mêmes — et en tire ce qui vous coûte le plus de points.
          </p>
        )
      )}
    </Panel>
  )
}
