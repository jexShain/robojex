import { defineConfig } from "vitest/config";

// Scope test discovery to workspace packages. The repo root also holds a
// vendored, gitignored hermes-agent checkout whose own test suite must not
// be picked up by a bare `vitest run`.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
