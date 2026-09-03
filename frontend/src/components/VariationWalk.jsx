/**
 * A variation, walked instead of read.
 *
 * The engine's lines were printed as a sentence — "L’adversaire enchaîne Cc6
 * Cf3 Cxe5 : et la dame tombe" — which asks the reader to play four moves in
 * their head against a board showing a different position. That is exactly the
 * skill the reader does not have yet; it is why they are looking at this
 * screen.
 *
 * So the moves are walkable. The board plays the line one ply at a time and
 * this panel says, for each one, whose move it is and what it does. None of it
 * costs an engine call: `replayLine` already ran the position detectors on
 * every ply of the variation to find the moment worth naming, and this is the
 * rest of what it found.
 *
 * The one thing the panel must never let the reader forget is that these moves
 * were not played, which is what the banner and the different edge are for.
 */

import { stepNarration } from '../coach/narrate.js'
import Icon from './Icon'
import Button from './ui/Button'

export default function VariationWalk({ variation, index, onStep, onExit }) {
  const step = variation.steps[index]
  const said = stepNarration(step)

  return (
    <section
      aria-label="Variante"
      className="rounded-xl border border-accent/40 border-l-4 border-l-accent bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span className="flex items-center gap-1.5 text-body font-medium text-accent">
          <Icon name="cpu" size={14} />
          Variante
        </span>
        <span className="text-label text-faint">
          {variation.label} · coup {index + 1} sur {variation.steps.length}
        </span>
        <Button size="sm" variant="ghost" icon="back" onClick={onExit} className="ml-auto">
          Retour à la partie
        </Button>
      </div>

      {/* Every ply of the line, so the reader can jump rather than only step.
          The one on screen is the one filled in. */}
      <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
        {variation.steps.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onStep(i)}
            aria-current={i === index ? 'true' : undefined}
            className={`min-h-8 rounded border px-2 py-0.5 font-mono text-body transition-colors ${
              i === index
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-line-strong bg-raised text-muted hover:text-text'
            }`}
          >
            {s.san}
          </button>
        ))}
      </div>

      <div className="px-3 pt-2 pb-3">
        <p className="text-body leading-relaxed text-text">{said.move}</p>
        {said.facts.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1">
            {said.facts.map((fact, i) => (
              <li key={i} className="text-body leading-snug text-muted">
                {fact}
              </li>
            ))}
          </ul>
        )}
        {/* Said on every ply on purpose. A board that looks like the game and
            is not is the one way this feature could mislead. */}
        <p className="mt-2 text-label text-faint">
          Ces coups n’ont pas été joués : c’est la ligne du moteur.
        </p>
      </div>

      <div className="flex items-center gap-0.5 border-t border-line px-2 py-1">
        <Button
          size="icon"
          variant="ghost"
          icon="previous"
          aria-label="Coup précédent de la variante"
          onClick={() => onStep(index - 1)}
        />
        <Button
          size="icon"
          variant="ghost"
          icon="next"
          aria-label="Coup suivant de la variante"
          onClick={() => onStep(index + 1)}
          disabled={index >= variation.steps.length - 1}
        />
      </div>
    </section>
  )
}
