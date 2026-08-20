// packages/cli/test/js2ts.mjs — test-harness bridge, loaded via `node --import`.
// Node 22 type stripping runs .ts sources directly but does not remap .js
// specifiers to .ts files; the spawned CLI keeps the tsc-conventional
// "./render.js" import while running from source via this resolve hook.
import { register } from "node:module";
register(new URL("./js2ts-hook.mjs", import.meta.url));
