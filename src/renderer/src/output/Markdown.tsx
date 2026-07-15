import { useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { copyText } from './copy'

/**
 * The single render path for assistant markdown — used both live (streaming
 * buffer) and finalized (AssistantBlock). Holds nothing; the source string is
 * the copy source of truth (kept by the caller). Component overrides map to the
 * design tokens so prose + code switch with the app theme.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="koda-prose text-text/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
        // The default transform drops `data:` URLs as unsafe — but the offline docs replica inlines a
        // doc's images as `data:image/…` (the Mac files aren't reachable from the phone). Let those
        // through; everything else keeps the default protocol allowlist.
        urlTransform={(url) => (url.startsWith('data:image/') ? url : defaultUrlTransform(url))}
      >
        {children}
      </ReactMarkdown>
    </div>
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
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        // Route through main's window-open handler → shell.openExternal; never navigate the shell.
        e.preventDefault()
        if (href) window.open(href, '_blank')
      }}
      className="text-accent underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
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
    return (
      <code className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[0.85em] text-text [overflow-wrap:anywhere]">
        {children}
      </code>
    )
  },
  pre: ({ children, node }) => <CodeBlock code={hastText(node)}>{children}</CodeBlock>,
}
