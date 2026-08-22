// packages/ceo-core/src/token-match.ts — CJK-safe overlap tokens.
// Matching a Chinese question/task against a ledger entry can't rely on word
// splitting (no spaces): an ASCII run becomes one word token, a CJK run
// becomes every 2-char sliding window (显卡 ⊂ 我机器显卡是什么). Shared by
// loop.withMemory (dispatch prompts) and chat-service.memoryNote (grounding).

const SPLIT = /[\s，。：；、！？·（）()\-/\\]+/;

export function overlapTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of text.split(SPLIT)) {
    if (part.length === 0) continue;
    if (/^[\x00-\x7F]+$/.test(part)) {
      if (part.length >= 2) out.add(part);
      continue;
    }
    for (let i = 0; i + 2 <= part.length; i++) out.add(part.slice(i, i + 2));
  }
  return out;
}

/** How many distinct tokens of `text` occur in `entry` (0 = unrelated). */
export function overlapScore(entry: string, tokens: Set<string>): number {
  let s = 0;
  for (const t of tokens) if (entry.includes(t)) s++;
  return s;
}
