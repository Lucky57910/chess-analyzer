# Chess Analyzer

An Android app that imports your Chess.com games, runs Stockfish over every
position, and shows where the games were actually decided: evaluation curve,
per-move judgments, accuracy, and the phase you keep losing points in. It can
also write a coach's paragraph on each of your moves — see [The coach](#the-coach).

Everything that matters runs on the phone. The engine, the database and the
analysis are all local; there is no account, no server, and no hosting bill.
Two network calls exist: Chess.com's public archive, and — only if you turn the
coach on and supply your own key — a language-model provider.

## Install

Download the APK from the [latest release](../../releases/latest), or point
[Obtainium](https://github.com/ImranR98/Obtainium) at this repository to get
updates automatically.

arm64-v8a only, Android 7+. The APK is ~70 MB because Stockfish is inside it,
and lands at roughly double that installed — see the packaging note below.

**Export a backup before reinstalling.** Réglages → Sauvegarde writes a JSON
file and hands it to the Android share sheet. The games can always be
re-imported from Chess.com; the analyses cannot, and they are hours of the
phone's own CPU.

## How it fits together

```
React + Vite  ──►  Capacitor WebView  ──┬──►  SQLite          (@capacitor-community/sqlite)
                                        ├──►  Stockfish 17.1  (native binary, UCI over a pipe)
                                        ├──►  api.chess.com   (CapacitorHttp, so no CORS)
                                        └──►  Gemini / OpenRouter   (optional, your own key)
```

Three things about that are worth knowing before changing any of it.

**The engine is executed, not linked.** Stockfish ships as
`jniLibs/arm64-v8a/libstockfish.so` and is spawned as a child process from
`nativeLibraryDir`. Since API 29 that is the only directory an app may execute
from, and getting a real file to appear there requires
`useLegacyPackaging = true` in `app/build.gradle`. Without it the path exists
but names nothing on disk and `exec` fails with `ENOENT`. That flag is also why
the engine is stored twice on the device.

**HTTP goes through `CapacitorHttp`, not `fetch`.** It is a native stack, so
the browser's CORS rules never apply — which is the whole reason a serverless
version of this app is possible at all. Chess.com sends no CORS headers.

**The analysis queue only runs while the app is open.** Android will not let a
process burn a core for an hour in the background, and a phone analysing games
in a pocket would be flat by lunchtime. Starting it is the user's decision.

## How a move is judged

Each position is evaluated exactly once, so an N-move game costs N+1 engine
calls. Move *i* pairs eval[i] (before) with eval[i+1] (after).

- Evals are clamped to ±10 pawns before computing loss — being up 30 vs up 40
  is not a real difference.
- Playing the engine's own top move is forced to 0 loss (otherwise search noise
  between two depths shows up as a fake mistake).
- Thresholds: **inaccuracy ≥ 50 cp**, **mistake ≥ 100 cp**, **blunder ≥ 300 cp**.
- Accuracy uses Lichess's win-probability model, averaged over the side's moves.
  It is *not* Chess.com's CAPS2, so the two numbers will not match.
- Phases: opening through move 12, endgame once ≤ 6 minor/major pieces remain,
  middlegame otherwise.

This model was ported from a Python backend that no longer exists in the tree.
It is pinned to `frontend/src/engine/__fixtures__/golden.json`, a recording of
that backend's output, and the port is tested against it move by move.


## The coach

Stockfish says a move cost 240 centipawns. It cannot say that you played it in
two seconds, that your king has been on e1 since move one, or what to do
differently next time. That part is written by a language model — optionally,
and under tight constraints.

**It never sees the game.** The model is not given the PGN, a FEN, or a board.
It is given a list of facts already computed on the phone: what the engine
evaluated, what the move cost, what it wanted instead, which motifs the
detectors found, how the opponent punishes it, how long the move took (off the
`[%clk]` tags in the PGN) and what the pawn structure and king safety look
like. It rewrites those facts as advice. It cannot miscalculate, because it
never calculates.

This matters more than it sounds. Measured on chess commentary, unaided
frontier models produce factually wrong sub-claims 10–22% of the time, and
smaller ones 35–55%; giving them engine output roughly halves that. Not letting
them near the board at all is the same idea taken further.

Answers are checked before they are believed — a comment about a move that was
not asked about, or one that ran long, is dropped rather than shown. **With no
key configured, nothing changes:** the app keeps explaining moves from the
engine's own findings, which is what it did before the coach existed.

**Setting it up.** Réglages → Coach IA. The default is Google's Gemini free
tier: a key from [AI Studio](https://aistudio.google.com/apikey), no card, and
roughly a thousand requests a day — a game costs one or two, because moves are
batched, not sent one at a time. OpenRouter's `:free` models work too.

**Two things to know before you turn it on.** The key is stored in the app's
private SQLite in plain text — protected by the Android sandbox and the
device's disk encryption, not by a separate secret. And on Google's *free*
tier, what you send is used to improve their products; your games go to them
and are trained on. The paid tier does not do this. No key is committed to this
repository or built into the APK.

## Development

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm test           # 467 tests, no device needed
npm run lint
```

Most of the app is testable off-device on purpose: the database layer runs
against Node's built-in SQLite, so the SQL exercised in tests is the SQL that
runs on the phone, and the judgment model is checked against the fixture. What
cannot be tested here is the native surface — `src/data/capacitor.js`,
`src/data/share.js` and `src/engine/stockfish.js`'s plugin side — which is why
those files are as thin as they are.

The browser build has no engine, no SQLite plugin and no share sheet, so it is
useful for laying out screens and not much else.

### Building the APK

`.github/workflows/android.yml` builds a debug APK on every push. Local builds
need JDK 21 and the Android SDK:

```bash
cd frontend
npm run engine:fetch   # downloads Stockfish 17.1, hash-pinned, ~80 MB
npm run android:sync
cd android && ./gradlew assembleDebug
```

`engine:fetch` is required; the Gradle build fails with an explanation rather
than producing an APK that cannot analyse anything.

### Releasing

Tag it:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

`.github/workflows/release.yml` builds a signed APK, verifies the signature
with `apksigner`, and attaches it to a GitHub Release, which is what Obtainium
polls. `v1.2.3` becomes `versionCode` 10203.

The signing key is permanent. Android refuses an update signed by a different
key, and the way around that is an uninstall, which destroys the only copy of
the analyses. The keystore lives in the repository secrets and is not rotated.

## Licence

GPL-3.0, because the APK ships a Stockfish binary. See [LICENSE](LICENSE) and
[THIRD_PARTY.md](THIRD_PARTY.md).
