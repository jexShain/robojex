// packages/web/src/chat/Markdown.tsx — deliberately lightweight markdown:
// paragraphs, fenced code blocks (with language banner), inline code,
// bold/italic, ordered/unordered lists, http(s) links. Everything renders as
// React nodes — no HTML injection is possible.

import type { ReactNode } from 'react'

type Block =
  | { k: 'p'; text: string }
  | { k: 'code'; lang: string; code: string }
  | { k: 'ul' | 'ol'; items: string[] }

const LIST_UL = /^[-*+] +/
const LIST_OL = /^\d+[.)] +/

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        buf.push(lines[i]!)
        i += 1
      }
      i += 1 // closing fence, or past the end of an unterminated block
      blocks.push({ k: 'code', lang, code: buf.join('\n') })
      continue
    }
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (LIST_UL.test(line) || LIST_OL.test(line)) {
      const ordered = LIST_OL.test(line)
      const re = ordered ? LIST_OL : LIST_UL
      const items: string[] = []
      while (i < lines.length) {
        const m = re.exec(lines[i]!)
        if (!m) break
        items.push(lines[i]!.slice(m[0].length))
        i += 1
      }
      blocks.push({ k: ordered ? 'ol' : 'ul', items })
      continue
    }
    const buf = [line.trim()]
    i += 1
    while (i < lines.length) {
      const l = lines[i]!
      if (l.trim() === '' || l.startsWith('```') || LIST_UL.test(l) || LIST_OL.test(l)) break
      buf.push(l.trim())
      i += 1
    }
    blocks.push({ k: 'p', text: buf.join(' ') })
  }
  return blocks
}

// Capture-group split keeps the delimiters; each piece is classified below.
const INLINE =
  /(`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE)
  const out: ReactNode[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    const key = `${keyPrefix}.${i}`
    if (p.length > 2 && p.startsWith('`') && p.endsWith('`')) {
      out.push(
        <code key={key} className="inline">
          {p.slice(1, -1)}
        </code>,
      )
      continue
    }
    if (p.length > 6 && p.startsWith('***') && p.endsWith('***')) {
      out.push(
        <strong key={key}>
          <em>{renderInline(p.slice(3, -3), key)}</em>
        </strong>,
      )
      continue
    }
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) {
      out.push(<strong key={key}>{renderInline(p.slice(2, -2), key)}</strong>)
      continue
    }
    if (p.length > 2 && p.startsWith('*') && p.endsWith('*')) {
      out.push(<em key={key}>{renderInline(p.slice(1, -1), key)}</em>)
      continue
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(p)
    if (link) {
      out.push(
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>,
      )
      continue
    }
    out.push(p)
  }
  return out
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((b, idx) => {
        const key = `b${idx}`
        switch (b.k) {
          case 'code':
            return (
              <div className="md-code" key={key}>
                <div className="md-code-head">
                  <span>{b.lang || 'text'}</span>
                </div>
                <pre>{b.code}</pre>
              </div>
            )
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}.${j}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}.${j}`)}</li>
                ))}
              </ol>
            )
          case 'p':
            return <p key={key}>{renderInline(b.text, key)}</p>
        }
      })}
    </div>
  )
}
