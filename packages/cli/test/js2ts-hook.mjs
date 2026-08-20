// packages/cli/test/js2ts-hook.mjs — resolve hook registered by js2ts.mjs:
// when a "./x.js" specifier has no file, retry it as "./x.ts" (the sources
// are TypeScript; tsc emits dist with .js names, the strip-types runner not).
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js")) {
      try { return await nextResolve(`${specifier.slice(0, -3)}.ts`, context); } catch { /* fall through */ }
    }
    throw err;
  }
}
