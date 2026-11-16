import { defineConfig } from "vitest/config";

// Vitest runs only the TypeScript tests. The deploy-logic tests (tests/*.test.mjs) use node:test.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
