/**
 * Forward renderer warnings/errors and uncaught failures into the main-process
 * log file so a dogfood run leaves ONE readable trail (the devtools console is
 * unreachable once you've moved on). warn/error only — never console.log — so
 * the signal isn't drowned by routine render chatter.
 */

function serialize(args: unknown[]): string[] {
  return args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
    if (typeof a === 'string') return a
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  })
}

export function installRendererLogForwarding(): void {
  const koda = window.koda
  if (!koda?.logFromRenderer) return

  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args) // keep devtools behaviour intact; forwarding is additive
      try {
        koda.logFromRenderer({ level, args: serialize(args) })
      } catch {
        // never let logging break the renderer
      }
    }
  }

  window.addEventListener('error', (e) => {
    koda.logFromRenderer({ level: 'error', args: serialize([`window.onerror: ${e.message}`, e.error]) })
  })
  window.addEventListener('unhandledrejection', (e) => {
    // Monaco cancels in-flight worker computations (diff, tokenize) when models swap or a widget
    // disposes; the cancellation rejects a promise nobody holds. That exact signature is control
    // flow, not a fault (VS Code filters it the same way) — keep it out of the log and pageerror.
    const r = e.reason as { name?: string; message?: string } | null
    if (r?.name === 'Canceled' && r?.message === 'Canceled') {
      e.preventDefault()
      return
    }
    koda.logFromRenderer({ level: 'error', args: serialize(['unhandledrejection', e.reason]) })
  })
}
