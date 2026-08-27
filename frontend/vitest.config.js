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
  },
});
