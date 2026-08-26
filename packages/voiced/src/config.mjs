// packages/voiced/src/config.mjs — side-effect-free CLI/env parsing, shared
// by the daemon and the vitest protocol tests (importing index.mjs boots a
// listener; importing this module never can).
import { join } from "node:path";

/** Resolve the models root: --models <dir> > VOICED_MODELS_DIR > default.
 *  `default` is supplied by the caller (index.mjs passes the package's
 *  models/ dir) so this module stays importable without __dirname tricks. */
export function parseModelsDir(argv, env, defaultDir) {
  const args = argv ?? [];
  const i = args.indexOf("--models");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const e = env?.VOICED_MODELS_DIR;
  if (e) return e;
  return defaultDir ?? join("models");
}
