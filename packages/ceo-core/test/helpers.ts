

/** Poll until `fn()` returns truthy (max ~2 s). */
export async function until(fn: () => boolean, ms = 50, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, ms));
  }
  throw new Error(`until() not satisfied after ${tries * ms}ms`);
}
