// packages/ceo-core/src/skills.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// Load one framework manual on demand; CEO never holds all manuals in context.
export function loadSkill(skillsDir: string, fw: string): string {
  const p = join(skillsDir, `${fw}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : `(no manual for ${fw})`;
}
