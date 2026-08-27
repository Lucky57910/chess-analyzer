# Third-party components

## Stockfish 17.1

The Android app ships the official `android-armv8-dotprod` binary from the
[Stockfish 17.1 release](https://github.com/official-stockfish/Stockfish/releases/tag/sf_17.1),
downloaded unmodified at build time by `frontend/scripts/fetch-engine.mjs` and
pinned to a SHA-256 hash. It is packaged as
`android/app/src/main/jniLibs/arm64-v8a/libstockfish.so` and executed as a
child process; it is not linked into the application.

Stockfish is licensed under the **GNU General Public License v3**, and its
source is available at <https://github.com/official-stockfish/Stockfish>.

Distributing that binary is why this repository as a whole is GPL-3.0. See
[LICENSE](LICENSE).

## Everything else

The web dependencies are declared in `frontend/package.json` and carry their own
licences, all permissive (MIT or Apache-2.0) at the time of writing.
