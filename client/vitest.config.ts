/**
 * @file vitest.config.ts
 * @description Vitest configuration for the client test suite — jsdom environment, React plugin, test globals, and the same build-time `__APP_VERSION__` injection as vite.config.ts so version-dependent components render identically under test.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Resolve the version injected as `__APP_VERSION__` in tests, mirroring `vite.config.ts` so
 * components that render it (such as the sidebar footer) behave the same as in the app. Same
 * fail-safe order: repo root, then client, then a placeholder.
 *
 * @returns The version string.
 */
function resolveAppVersion(): string {
  for (const rel of ["../package.json", "package.json"]) {
    try {
      const { version } = JSON.parse(readFileSync(resolve(process.cwd(), rel), "utf8"));
      if (version) return version as string;
    } catch {
      // Not found or unreadable at this path — try the next candidate.
    }
  }
  return "0.0.0";
}
/** Version injected as `__APP_VERSION__` in tests. */
const APP_VERSION = resolveAppVersion();

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    css: false,
  },
});
