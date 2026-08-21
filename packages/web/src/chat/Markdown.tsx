// packages/web/src/chat/Markdown.tsx — full GFM renderer: marked parse →
// DOMPurify sanitize → dangerouslySetInnerHTML. Fenced code gets a header bar
// (language + copy button, ✓ for 1.2s) and highlight.js coloring from a curated
// 20-language registry. While streaming, an unclosed fence is closed virtually
// so partial code still renders as a code block.

import { useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Marked } from 'marked'
import type { RendererObject, Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import markdownLang from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import './chat.css'

/* ── highlight.js: 20 everyday languages + aliases ── */
{
  const langs = [
    ['javascript', javascript],
    ['typescript', typescript],
    ['python', python],
    ['bash', bash],
    ['json', json],
    ['yaml', yaml],
    ['xml', xml],
    ['css', css],
    ['markdown', markdownLang],
    ['sql', sql],
    ['rust', rust],
    ['go', go],
    ['java', java],
    ['c', c],
    ['cpp', cpp],
    ['csharp', csharp],
    ['php', php],
    ['diff', diff],
    ['dockerfile', dockerfile],
    ['ini', ini],
  ] as const
  for (const [name, def] of langs) hljs.registerLanguage(name, def)
  hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
  hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
  hljs.registerAliases(['py'], { languageName: 'python' })
  hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
  hljs.registerAliases(['yml'], { languageName: 'yaml' })
  hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' })
  hljs.registerAliases(['md'], { languageName: 'markdown' })
  hljs.registerAliases(['c++'], { languageName: 'cpp' })
  hljs.registerAliases(['cs', 'dotnet'], { languageName: 'csharp' })
  hljs.registerAliases(['docker'], { languageName: 'dockerfile' })
  hljs.registerAliases(['toml'], { languageName: 'ini' })
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const AUTO_HIGHLIGHT_LIMIT = 20_000 // skip highlightAuto on huge blobs

const renderer: RendererObject = {
  code({ text, lang }: Tokens.Code): string {
    const raw = (lang || '').trim().split(/\s+/)[0] ?? ''
    const language = raw.toLowerCase()
    let body: string
    let label = language || 'text'
    if (language && hljs.getLanguage(language)) {
      body = hljs.highlight(text, { language, ignoreIllegals: true }).value
    } else if (language) {
      body = escapeHtml(text)
    } else if (text.length <= AUTO_HIGHLIGHT_LIMIT) {
      const auto = hljs.highlightAuto(text)
      body = auto.value
      if (auto.language) label = auto.language
    } else {
      body = escapeHtml(text)
    }
    return (
      `<div class="mdx-code">` +
      `<div class="mdx-code-head">` +
      `<span class="mdx-code-lang">${escapeHtml(label)}</span>` +
      `<button type="button" class="mdx-copy" data-testid="code-copy" aria-label="复制代码">` +
      `<span class="mdx-copy-idle">复制</span><span class="mdx-copy-done">✓ 已复制</span>` +
      `</button>` +
      `</div>` +
      `<pre><code class="hljs">${body}</code></pre>` +
      `</div>`
    )
  },
}

const marked = new Marked({ gfm: true, breaks: true, renderer })

/** An odd number of fence lines means the closing fence hasn't streamed yet —
 * append one so the partial block renders as code instead of prose. */
function closeOpenFences(src: string): string {
  let fences = 0
  for (const line of src.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fences += 1
  }
  return fences % 2 === 1 ? `${src}\n\`\`\`` : src
}

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'bdi', 'blockquote', 'br', 'button', 'caption', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'kbd', 'li', 'mark', 'ol',
  'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u',
  'ul', 'var', 'wbr',
]
const ALLOWED_ATTR = [
  'class', 'href', 'title', 'target', 'rel', 'type', 'checked', 'disabled',
  'start', 'align', 'colspan', 'rowspan', 'aria-label', 'data-testid',
]

// Open every surviving link in a new tab (DOMPurify strips target first,
// the hook re-adds it after sanitization — javascript: URLs are already gone).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function renderMarkdown(text: string): string {
  const src = closeOpenFences(text)
  const raw = marked.parse(src, { async: false })
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR, SANITIZE_DOM: true })
}

/** Copy-button clicks are delegated here: one listener for all code blocks. */
function onContainerClick(e: ReactMouseEvent<HTMLDivElement>): void {
  const btn = (e.target as HTMLElement).closest('.mdx-copy')
  if (!(btn instanceof HTMLElement)) return
  const code = btn.closest('.mdx-code')?.querySelector('pre')?.textContent ?? ''
  const flash = (): void => {
    btn.classList.add('copied')
    window.setTimeout(() => btn.classList.remove('copied'), 1200)
  }
  try {
    const clip = navigator.clipboard
    if (clip?.writeText) void clip.writeText(code).then(flash, flash)
    else flash()
  } catch {
    flash()
  }
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className={`mdx${streaming ? ' mdx-streaming' : ''}`}
      onClick={onContainerClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
