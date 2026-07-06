import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the project's own tests — never the CommonJS test files the fleet writes into .auralis-build/.
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/setup/oracle-global.ts"],
    testTimeout: 60_000,
    // Tests get their OWN oracle (port 47788, scratch db — see oracle-global.ts). Before this, tests that
    // found a dev oracle running on :47778 would happily write probe events into the REAL brain — the
    // dashboard's project list filled with tl-* junk. Isolation over reuse.
    env: { ORACLE_API_URL: "http://localhost:47788" },
  },
});
