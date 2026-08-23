import { createContext, memo, useContext, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { copyText } from './copy'
import { classifyStageHref } from '@shared/stage-links'

/**
 * Optional interceptor for local-file links inside assistant markdown. When a
 * provider is present (desktop workspace), a link that points at a file in the
 * project opens in the Stage instead of the browser. It returns true if it
 * handled the href; false/absent falls back to window.open. Kept as context so
 * this shared component stays pure — mobile and other callers provide nothing.
 */
export const LocalLinkContext = createContext<((href: string) => boolean) | null>(null)

/** Preserve Koda-local anchor identities until LocalLinkContext sees them. react-markdown's default
 * sanitizer treats `file://`, `koda://`, and `src/a.ts:12` as unknown protocols and otherwise erases
 * the href before our click handler can route it. Unknown/active schemes still use the safe default. */
export function markdownUrlTransform(url: string, key: string): string {
  if (key === 'href') {
    if (/^(?:file:\/\/|koda:\/\/session\/)/i.test(url)) return url
    // Keep active browser schemes on react-markdown's deny path even when a numeric payload makes
    // them look like a source location (for example `javascript:12`).
    if (!/^(?:javascript|vbscript|data):/i.test(url) && /^[^?#]+:\d+(?::\d+)?(?:#L\d+(?:C\d+)?)?$/i.test(url))
      return url
  }
  if (key === 'src' && url.startsWith('data:image/')) return url
  return defaultUrlTransform(url)
}

export function isPathShapedInlineCode(value: string): boolean {
  if (!value || value !== value.trim()) return false
  if (/[\s\\*$|><;&`'"!?()[\]{}]/.test(value) || /[@=#]/.test(value)) return false

  // Remove only a valid source location before checking for schemes. Otherwise `name.ts:12`
  // looks like a custom protocol, while `https://example.com/a.ts:12` still retains its scheme.
  const path = value.replace(/:[1-9]\d*(?::[1-9]\d*)?$/, '')
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes(':')) return false
  // A domain is rejected only when it wears `www.` or carries a path. A bare `stem.ext` is exactly
  // what a filename looks like (`archive.7z`), so shape alone cannot separate it from `example.com`;
  // a wrong click there lands on the resolver's ordinary refusal.
  if (/^www\./i.test(path)) return false
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(path)) return false
  if (/^v?\d+(?:\.[a-z0-9]+)+[+-]?[a-z0-9.-]*$/i.test(path)) return false

  let body = path
  if (body.startsWith('~/')) body = body.slice(2)
  else if (body.startsWith('/')) body = body.slice(1)
  else {
    while (body.startsWith('./') || body.startsWith('../')) body = body.slice(body.indexOf('/') + 1)
  }

  if (!body || body.endsWith('/') || body.includes('//')) return false
  const segments = body.split('/')
  if (segments.some((segment) => !/^(?=.*[a-z0-9])[a-z0-9._+-]+$/i.test(segment))) return false
  if (path.includes('/')) return true

  return /^(?:\.[a-z0-9_-]+|[a-z0-9_+-][a-z0-9._+-]*)\.(?:[a-z][a-z0-9]{0,9}|7z)$/i.test(path)
}

/**
 * The single render path for assistant markdown — used both live (streaming
 * buffer) and finalized (AssistantBlock). Holds nothing; the source string is
 * the copy source of truth (kept by the caller). Component overrides map to the
 * design tokens so prose + code switch with the app theme.
 *
 * Memoized on the source string, which is the load-bearing part: remark-gfm +
 * rehype-highlight re-parse and re-tokenize from scratch on every render, and a
 * finalized block's markdown never changes again. Without this, one store patch
 * (a subagent forwarding a line of text during a fan-out) re-highlights every
 * block in the whole conversation — cost per event scales with transcript
 * length, which is what made long fan-out sessions crawl.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="koda-prose text-text/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
        // The default transform drops `data:` URLs as unsafe — but the offline docs replica inlines a
        // doc's images as `data:image/…` (the Mac files aren't reachable from the phone). Let those
        // through; everything else keeps the default protocol allowlist.
        urlTransform={markdownUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

/** True while rendering a link's children: a path chip inside an anchor must stay plain text, because
 *  a button inside a link is invalid interactive nesting and the link already owns the open. */
const InsideLinkContext = createContext(false)

function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const openLocal = useContext(LocalLinkContext)
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return
        const link = classifyStageHref(href)
        // Same-document anchors retain native browser behavior. Every other link is claimed here so
        // an untrusted file/custom scheme can never fall through to window.open without main's check.
        if (link.kind === 'anchor') return
        e.preventDefault()
        if (link.kind === 'external') return void window.open(href, '_blank')
        if (link.kind === 'file' || link.kind === 'session') openLocal?.(href)
      }}
      className="text-accent underline underline-offset-2 hover:opacity-80"
    >
      <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    </a>
  )
}

/** Recursively pull text out of a hast node — for the fenced-block copy payload. */
function hastText(node: any): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  if (Array.isArray(node.children)) return node.children.map(hastText).join('')
  return ''
}

function CodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  async function onCopy() {
    try {
      await copyText(code)
      setState('ok')
    } catch {
      setState('fail')
    }
    setTimeout(() => setState('idle'), 1200)
  }
  return (
    <div className="group relative my-4">
      <button
        onClick={onCopy}
        className="absolute right-2 top-2 rounded-md border border-border bg-bg/80 px-2 py-1 text-[11px] text-text-muted opacity-0 backdrop-blur transition-opacity hover:text-text group-hover:opacity-100"
      >
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Failed' : 'Copy'}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-4 text-[0.9em] leading-relaxed font-mono">
        {children}
      </pre>
    </div>
  )
}

function InlineCode({ children, text }: { children: ReactNode; text: string }) {
  const openLocal = useContext(LocalLinkContext)
  const insideLink = useContext(InsideLinkContext)
  if (!openLocal || insideLink || !isPathShapedInlineCode(text)) {
    return (
      <code className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[0.85em] text-text [overflow-wrap:anywhere]">
        {children}
      </code>
    )
  }

  return (
    <button
      type="button"
      onClick={() => openLocal(text)}
      aria-label={`Open ${text}`}
      className="inline rounded border border-border bg-surface px-1.5 py-0.5 text-left font-mono text-[0.85em] text-text [overflow-wrap:anywhere] hover:cursor-pointer hover:text-accent hover:underline hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  )
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-5 mb-2 font-display text-[1.5em] font-semibold tracking-tight text-text">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 font-display text-[1.34em] font-semibold tracking-tight text-text">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 font-display text-[1.12em] font-semibold text-text">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1.5 text-[0.82em] font-semibold uppercase tracking-wider text-text-muted">{children}</h4>,
  p: ({ children }) => <p className="my-2.5">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-accent/50 pl-4 italic text-text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-5 border-border" />,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-[0.9em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-surface px-3 py-1.5 text-left font-semibold text-text">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
  code: ({ className, children, node }) => {
    const match = /language-(\w+)/.test(className || '')
    const text = hastText(node)
    const isBlock = match || text.includes('\n')
    if (isBlock) return <code className={className}>{children}</code>
    return <InlineCode text={text}>{children}</InlineCode>
  },
  pre: ({ children, node }) => <CodeBlock code={hastText(node)}>{children}</CodeBlock>,
}
