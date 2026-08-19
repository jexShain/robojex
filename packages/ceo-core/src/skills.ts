// packages/ceo-core/src/skills.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MANUAL_FRAMEWORKS = ["hermes", "claude-code"] as const;

// Load one framework manual on demand; null when the repo carries no manual
// for that framework. Jex never holds all manuals in context.
export function loadSkill(skillsDir: string, fw: string): string | null {
  const p = join(skillsDir, `${fw}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

// The manual block appended to every decide prompt: the two short framework
// manuals (<3KB combined). Missing manuals are skipped; an absent skills dir
// yields an empty string so the cycle still runs.
export function manualsBlock(skillsDir: string): string {
  const manuals = MANUAL_FRAMEWORKS
    .map((fw) => loadSkill(skillsDir, fw))
    .filter((m): m is string => m !== null);
  return manuals.length ? `# FRAMEWORK MANUALS\n${manuals.join("\n")}` : "";
}
