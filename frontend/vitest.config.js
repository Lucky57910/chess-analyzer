import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default: the engine and data tests run against Node's own SQLite
    // and want nothing to do with a DOM. Component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock, which keeps the exception visible
    // in the file it applies to.
    environment: "node",

    // Vitest's own per-test limit is 5 s, which sits under the 10 s the DOM
    // suite gives a `findBy`. A slow page render would therefore fail on this
    // clock before the one raised for it - which is exactly what it did,
    // intermittently, on a loaded machine.
    //
    // CI runs on a two-core runner, rendering whole pages through lazy routes
    // while chess.js walks every legal move for the mate detector. Nothing
    // here is meant to take a second; the ceiling only has to sit far enough
    // above the noise that a red run means something is broken.
    testTimeout: 20_000,
  },
});
