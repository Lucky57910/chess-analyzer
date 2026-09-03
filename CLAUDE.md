# Working in this repository

An Android app built with Capacitor. Everything lives under `frontend/`;
there is no server and no other package.

## Commands

Run these from `frontend/`.

```bash
npm test           # vitest, 539 tests, no device needed
npm run lint       # oxlint
npm run build      # vite
npm run dev        # browser, for layout work only
npm run engine:fetch   # download Stockfish 17.1 into android/app/src/main/jniLibs
npm run android:sync   # build + cap sync android
```

The APK cannot be built on this machine: it has JDK 8 and no Android SDK, and
Capacitor 8 needs JDK 21. `.github/workflows/android.yml` is the only place the
Java plugin, the packaging settings and the engine binary are proven to fit
together, so verifying a native change means pushing and reading the run.

## Layout

| Path | |
| --- | --- |
| `src/engine/scoring.js` | Pure judgment model. Ported from Python, pinned to a fixture. |
| `src/engine/analyze.js` | Walks a PGN. The engine is injected, so it is testable. |
| `src/engine/stockfish.js` | UCI driver over the native plugin. |
| `src/data/db.js` | Driver contract + Node's SQLite, which is what the tests run on. |
| `src/data/games.js` `sync.js` `stats.js` `backup.js` | Storage, queue, aggregates, backup. |
| `src/data/capacitor.js` `share.js` | Device-only wiring. Deliberately logic-free. |
| `src/coach/narrate.js` | Ranks and words what to say about one move, and says where each sentence came from. All the French for a motif lives here. |
| `src/coach/digest.js` | The facts a language model is allowed to see. Never the PGN. |
| `src/coach/position.js` | Material, king safety, pawn structure, development, repeated opening moves. |
| `src/coach/providers.js` `client.js` `config.js` | Provider adapters, the request/validation/fallback loop, and where the keys live — one per provider. |
| `src/coach/throttle.js` | Sliding-window rate limiter and `Retry-After` backoff for the free tier. |
| `src/coach/cost.js` | What a commented game costs on a paid provider, measured from what the digest actually sends. |
| `src/components/ui/` | Button, Card/Panel, Segmented, Badge, and the ⓘ that replaced every `title`. |
| `src/components/CoachBubble.jsx` `VariationWalk.jsx` | The bubble under the board, and the engine's lines walked one ply at a time. |
| `src/components/Icon.jsx` | The icon set, inline. Replaced the emoji that Android drew differently on every device. |
| `src/utils/api.js` | Facade the pages call. Keeps the shape the old HTTP client had. |
| `android/app/src/main/java/.../StockfishPlugin.java` | Spawns the engine. Deliberately dumb. |
| `android/app/src/main/java/.../CoachService.java` `CoachPlugin.java` | Posts the coach's prepared requests from a foreground service, and notifies. Equally dumb. |

## Things that will bite

**`useLegacyPackaging = true` in `android/app/build.gradle` is load-bearing.**
The engine is executed, not linked, and since API 29 an app may only exec from
`nativeLibraryDir`. Without legacy packaging that path names nothing on disk and
`exec` fails with `ENOENT`.

**The signing key is permanent.** Android refuses an update signed by a
different key; working around it means uninstalling, which destroys the local
database — the only copy of the analyses. The keystore is in the repository
secrets and is never regenerated.

**`analysis_status = 'running'` means "interrupted", not "in progress".** The
queue only runs in the foreground and there is exactly one runner, so a row
still marked running when a pass starts belongs to a pass that died with the
process. `store.reclaimRunning()` hands those back — once when the app opens
and again at the top of every run — keeping the attempt already charged, and
retiring with a reason anything that has spent all three. Without it a game
killed mid-analysis showed "en analyse" for ever, because `nextPending` only
looks at `pending`.

**The engine binary is not committed.** 80 MB, fetched by `engine:fetch` and
pinned to a SHA-256. Gradle fails with an explanation if it is missing.

**Scores are relative to the side to move.** The app is White-POV throughout,
and mate is folded to ±(10000 − n) to match the Python `mate_score=10000`.
Getting the sign wrong produces plausible-looking numbers on every screen.

**Python's `round()` is banker's rounding on the exact binary value**, which is
not `Math.round`. `scoring.js` has a `roundTo` that reproduces it; the fixture
will catch you if you replace it.

**The coach's commentary is optional and never invents.** `coach/` calls a
language model over the *engine's findings only* — `digest.js` builds that
payload and the PGN is deliberately not in it, because a model given a game
will re-analyse it badly and state the result confidently. Answers are
validated before they are believed (unknown ply, over-long text, unparseable
JSON are all dropped), and with no key configured the app falls back to
`narrate.js`, which is what it always did. The default provider is Google
Gemini's free tier; the key is the user's own, pasted in Réglages and stored in
the local `settings` table. **No key is ever committed or built into the APK.**
Requests are batched (`CHUNK_SIZE` moves each, currently 24), so a game costs
one or two requests rather than one per move — the free tier's requests-per-
minute is not the binding constraint at the volume one person produces, and
`throttle.js` exists for the burst that would cross it rather than to pace the
normal case. Note that Google's **free tier trains on what it is sent**; the
digest carries the user's games, and the settings screen says so.

**A free tier's failures are the moment, not the request.** A 429, a 5xx and a
request that never arrived are all retried, and then handed to the next
provider a key is stored for — which is why keys are stored *per provider*
(`coach_api_key_<provider>`) rather than one at a time. Anything else (a
refused key, a model that does not exist, an unparseable answer) fails on the
first reply, because retrying it only spends quota. Gemini's free tier answers
"surchargé" often enough that this is the difference between commenting two
games in ten and commenting ten. `PROVIDERS.anthropic` is the paid spare; its
`pricing` is what `cost.js` turns into the figure per game shown in Réglages,
so a model is chosen against a number rather than against a rate card.

**The coach can run with the app closed; the engine cannot.** Android freezes
a backgrounded WebView, so anything that must survive the phone going in a
pocket has to leave it. The coach is network work — a couple of POSTs — so it
goes to a foreground service (`CoachService`) that shows a notification while
it writes and another when it is done. The engine queue does not: it is CPU,
and a phone analysing chess in a pocket is a phone with a dead battery.

The split is the same one `StockfishPlugin` uses. `planGame` builds every
request in JS — digest, prompt, provider shapes, fallback order — and hands
Java a URL, some headers and a string of bytes; the service stores raw response
bodies; `readChunk` turns them back into commentary on the next app open, with
the same validation as the foreground path. Java knows nothing about chess,
providers, or JSON. Results wait in `filesDir/coach/*.json` until
`api.collectCoachResults()` stores them, and a job is cleared only after that,
so a run that dies in between simply finds the file again.

**Storing a key and choosing who is asked first are different actions.**
`writeCoachConfig` takes `keyProvider` (file this key and model under that
provider, change nothing else) and `provider` (make this the one asked first).
One selector did both, which meant that picking Claude to paste its key moved
every game onto a paid provider — the opposite of why a spare key exists. The
chain restarts at the primary for every chunk, so a paid spare is billed for
the chunks the free tier actually refused and no others.

**A re-analysis keeps the commentary it is still describing.** `saveAnalysis`
carries across every note whose ply came back with the same judgment and the
same `best_move_san`, and drops the rest (`keptCommentary`). Clearing all of it
was safe and wrong: the queue re-deepens games on its own, so a whole game's
commentary disappeared every time it did, which reads as "the coach is not
stored at all".

The way to make the coach better is to **widen the fact base, not to tune the
prompt or buy a bigger model**. `position.js` and the `[%clk]` clock times are
there for that reason: a model given "roi en e1, non roqué, coup 14" cannot
invent king safety, while a model given nothing will write a paragraph about it
anyway, because a coach's paragraph has a shape it knows. Structural facts are
emitted as *deltas* — once, on the move that caused them — with an absolute
snapshot at the head of each chunk; repeating a fact on twenty lines gets it
written about twenty times.

**A rate needs a denominator big enough to be one.** `MIN_RATE_MOVES` in
`stats.js` withholds the per-hundred-moves judgment rates below eighty of the
player's own moves in the window, and the smoothed series carries `sample_*`
(counted, not weighted) so a screen can say why. Two reasons, both real: a
short game is *conditioned* on the blunder that ended it, so a window holding
one reports three times anyone's true rate; and a stacked area draws a missing
value as zero, so a rate the data cannot support opened the chart at the floor
and then "climbed". The per-game series keeps no floor — its denominator is
games, which is exactly what its label says.

**Three things speak under the board and they are not the same thing.**
A sentence carries an `origin`: `position` (chess.js geometry, always true),
`engine` (Stockfish - the cost, the wanted move, the variation) or `ai` (a
model, writing from those two). They were one grey list, which made "ton roi
reste au centre" look exactly like "ce coup cloue le cavalier". The avatar and
the header name the author of the paragraph; each supporting line is tagged.

**A variation is state of its own, never a ply.** `narrate` hands the steps
over as well as the sentence, so a line can be walked on the board instead of
replayed in the reader's head - and every step already carries the position it
reaches and what the detectors saw there, so walking one costs no engine call
and no chess.js. But the board is then showing something that was not played:
anything that moves the game clears it, the transport row is hidden while it is
open (a row of arrows that silently changes what it drives is worse than no
row), and the panel repeats on every ply that these moves were not played.

**The board's coordinates are ours.** chessground places them *outside* the
board, on the assumption of a padded wrapper. This board is a clipped box of
exactly its own size, so the defaults put the ranks a fifth of a square too
high and clipped the files. `index.css` overrides them back inside, which is
also what `chessground.brown.css` is written for - it alternates each label's
colour for a light and a dark square.

**The best move is drawn, not hidden behind a button.** On a judged move the
engine's move is a thin arrow under the pieces, on the position that was
reached - not the position it belongs to, which would mean rewinding the board
out from under the move list on every mistake. Its origin square may hold
another piece by then; the move actually played is the one chessground
highlights, and the arrow loses that contest on purpose. Only judged moves,
because nearly every move has some second choice the engine slightly preferred,
and an arrow on all of them is an arrow that says nothing.

**`title` attributes are not a way to say anything.** The app ships as an APK,
where nothing hovers, so every explanation that lived in a `title` was written
and never displayed. Use `components/ui/Info.jsx` instead.

**Semantic colour tokens, not the `ink-*` ramp.** `index.css` defines
`surface` / `raised` / `line` / `text` / `muted` / `faint` on top of the ramp;
screens use those. `text-body` / `text-label` / `text-lead` are the type scale,
and 12px (`text-label`) is the floor.

## Testing expectations

The judgment model and the data layer are held to a recorded oracle
(`src/engine/__fixtures__/golden.json`, produced by the Python backend before it
was removed) and run against real SQLite rather than mocks. When adding tests
here, check they actually fail when the code is broken — several suites in this
repo passed a mutation before being tightened, and a green test that cannot fail
is worse than none.

The native surface (`capacitor.js`, `share.js`, the Java plugin) has no tests by
construction. Keep logic out of it so that stays true. The coach's HTTP client
takes its transport as an argument for the same reason, so `coach.test.js` runs
the whole request/validate/merge path with no key and no network.

## Conventions

- UI strings and user-facing error messages are French. Code and comments are
  English.
- Comments referencing `backend/app/...` are historical: the Python backend was
  removed once the port was complete. It is in git history if the oracle is ever
  needed again, along with `backend/scripts/dump_golden.py`, which generated the
  fixture.
- `git push` on this machine needs schannel and the gh credential helper, or it
  fails on the corporate TLS proxy:
  ```
  GIT_TERMINAL_PROMPT=0 git -c http.sslBackend=schannel \
    -c credential.helper='!gh auth git-credential' push origin main
  ```
