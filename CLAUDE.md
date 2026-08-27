# Working in this repository

An Android app built with Capacitor. Everything lives under `frontend/`;
there is no server and no other package.

## Commands

Run these from `frontend/`.

```bash
npm test           # vitest, 158 tests, no device needed
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
| `src/utils/api.js` | Facade the pages call. Keeps the shape the old HTTP client had. |
| `android/app/src/main/java/.../StockfishPlugin.java` | Spawns the engine. Deliberately dumb. |

## Things that will bite

**`useLegacyPackaging = true` in `android/app/build.gradle` is load-bearing.**
The engine is executed, not linked, and since API 29 an app may only exec from
`nativeLibraryDir`. Without legacy packaging that path names nothing on disk and
`exec` fails with `ENOENT`.

**The signing key is permanent.** Android refuses an update signed by a
different key; working around it means uninstalling, which destroys the local
database — the only copy of the analyses. The keystore is in the repository
secrets and is never regenerated.

**The engine binary is not committed.** 80 MB, fetched by `engine:fetch` and
pinned to a SHA-256. Gradle fails with an explanation if it is missing.

**Scores are relative to the side to move.** The app is White-POV throughout,
and mate is folded to ±(10000 − n) to match the Python `mate_score=10000`.
Getting the sign wrong produces plausible-looking numbers on every screen.

**Python's `round()` is banker's rounding on the exact binary value**, which is
not `Math.round`. `scoring.js` has a `roundTo` that reproduces it; the fixture
will catch you if you replace it.

## Testing expectations

The judgment model and the data layer are held to a recorded oracle
(`src/engine/__fixtures__/golden.json`, produced by the Python backend before it
was removed) and run against real SQLite rather than mocks. When adding tests
here, check they actually fail when the code is broken — several suites in this
repo passed a mutation before being tightened, and a green test that cannot fail
is worse than none.

The native surface (`capacitor.js`, `share.js`, the Java plugin) has no tests by
construction. Keep logic out of it so that stays true.

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
