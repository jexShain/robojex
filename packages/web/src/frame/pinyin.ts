// packages/web/src/frame/pinyin.ts — pinyin-initial matching for the command
// palette. Chinese-first UIs get typed by initials (typing jsc expects 驾驶舱,
// dh expects 对话) the way every IME-trained user reflexively does; plain
// substring matching finds nothing for those queries. The table is closed:
// it only needs to cover the hanzi that appear in the palette's STATIC
// labels (views/actions/gears) — conversation titles are user content and
// keep matching through the ordinary includes() path.

/** Hanzi → pinyin syllable initial, for the static UI vocabulary. */
const INITIALS: Record<string, string> = {
  指: 'z', 挥: 'h', 中: 'z', 心: 'x', 对: 'd', 话: 'h', 任: 'r', 务: 'w',
  板: 'b', 日: 'r', 历: 'l', 活: 'h', 动: 'd', 驾: 'j', 驶: 's', 舱: 'c',
  新: 'x', 会: 'h', 切: 'q', 换: 'h', 到: 'd', 视: 's', 图: 't', 主: 'z',
  题: 't', 浅: 'q', 色: 's', 深: 's', 跟: 'g', 随: 's', 系: 'x', 统: 't',
  语: 'y', 言: 'y', 挡: 'd', 位: 'w', 休: 'x', 眠: 'm', 省: 's', 电: 'd',
  均: 'j', 衡: 'h', 专: 'z', 注: 'z', 狂: 'k', 暴: 'b', 未: 'w', 命: 'm',
  名: 'm', 循: 'x', 环: 'h', 模: 'm', 式: 's', 群: 'q', 组: 'z', 搜: 's',
  索: 's',
}

/** Per-char initials of a label: hanzi map through the table, latin chars
 *  pass through lowercased, everything else (digits/punct) drops. */
export function initialsOf(label: string): string {
  let out = ''
  for (const ch of label) {
    const hit = INITIALS[ch]
    if (hit !== undefined) out += hit
    else if (/[a-z]/i.test(ch)) out += ch.toLowerCase()
  }
  return out
}

/** Order-preserving subsequence: every char of `q` appears in `hay` in order
 *  (gaps allowed). "zhx" hits 指挥中心's "zhzx" — users type word initials,
 *  not strict substrings. */
function isSubsequence(q: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) {
    if (i < q.length && ch === q[i]) i += 1
  }
  return i === q.length
}

/** Palette query match: substring on the label itself, or initials hit. */
export function matchesInitials(label: string, q: string): boolean {
  if (!q) return true
  return isSubsequence(q, initialsOf(label))
}
