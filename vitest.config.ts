import { defineConfig, type Plugin } from "vitest/config";

// vite 5 predates the `sqlite` node builtin: experimental builtins are absent
// from module.builtinModules, so vite-node strips the `node:` prefix and then
// fails to resolve the bare `sqlite` as an npm package. Serve a virtual module
// that bridges to the real builtin via createRequire instead.
const nodeSqliteBridge = (): Plugin => ({
  name: "node-sqlite-bridge",
  enforce: "pre",
  resolveId(source) {
    // match both spellings: vite-node's normalizeModuleId strips "node:"
    if (source === "node:sqlite" || source === "sqlite") return "node:sqlite";
  },
  load(id) {
    if (id !== "node:sqlite") return;
    return [
      'import { createRequire } from "node:module";',
      'const sqlite = createRequire(process.cwd() + "/")("node:sqlite");',
      "export const DatabaseSync = sqlite.DatabaseSync;",
      "export const StatementSync = sqlite.StatementSync;",
    ].join("\n");
  },
});


// Scope test discovery to workspace packages. The repo root also holds a
// vendored, gitignored hermes-agent checkout whose own test suite must not
// be picked up by a bare `vitest run`.
export default defineConfig({
  plugins: [nodeSqliteBridge()],
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
