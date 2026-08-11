/**
 * face-kit/host.js — the kit's line to the Koda shell. COPY VERBATIM (do not edit per app).
 *
 * Every primitive that needs a native power routes through here: capability flags from the
 * `koda:host` announce, haptics, and the native picker (`koda:pick`). It is a PASSIVE observer —
 * it posts `koda:ready` (idempotent; an app bridge posting its own is harmless) and records what
 * the host answers, but it never claims the agent line or handles agent messages. An app that owns
 * its agent line keeps its own bridge module alongside this one; the two listen to the same
 * announce without conflict.
 *
 * Every power is absent until announced: on a host without haptics `haptic()` is silent, on a host
 * without the picker `pick()` (see pick.js) falls back to a file input. The same face degrades
 * honestly on every surface.
 */

const caps = { known: false, viewport: false, haptics: false, pick: false, agentBridge: false }
const capListeners = new Set()
const picks = new Map()
let pickSeq = 0

function post(msg) {
  try {
    window.parent?.postMessage(msg, '*')
  } catch {
    /* no parent (plain browser tab) — powers stay absent */
  }
}

if (typeof window !== 'undefined' && !window.__kodaFaceKitHost) {
  window.__kodaFaceKitHost = true

  let announceTimer = null
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== 'object') return
    const msg = e.data
    if (msg.type === 'koda:host') {
      clearInterval(announceTimer)
      caps.known = true
      caps.viewport = !!msg.viewport
      caps.haptics = !!msg.haptics
      caps.pick = !!msg.pick
      caps.agentBridge = !!msg.agentBridge
      for (const fn of capListeners) fn({ ...caps })
    }
    if (msg.type === 'koda:pick-result' && picks.has(msg.id)) {
      const { resolve, reject } = picks.get(msg.id)
      picks.delete(msg.id)
      if (msg.error) reject(new Error(msg.error))
      else resolve(Array.isArray(msg.files) ? msg.files : [])
    }
  })

  // Announce until the host answers — a single shot loses the race when this frame loads before
  // the stage attaches its listener. Give up quietly after ~15s (a plain tab has no host).
  post({ type: 'koda:ready' })
  let tries = 0
  announceTimer = setInterval(() => {
    if (caps.known || ++tries > 50) return clearInterval(announceTimer)
    post({ type: 'koda:ready' })
  }, 300)
}

/** The powers this surface lends, as last announced. `known` is false until the host answers. */
export function hostCaps() {
  return { ...caps }
}

/** Be told when the announce lands (fires immediately if it already has). Returns unsubscribe. */
export function onHost(fn) {
  capListeners.add(fn)
  if (caps.known) fn({ ...caps })
  return () => capListeners.delete(fn)
}

/** Fire a haptic: 'light' | 'medium' | 'success' | 'warning'. Silent (never broken) on surfaces
 *  without it. Only for deliberate user actions and genuine completions — a buzz on every event
 *  is noise. */
export function haptic(style = 'light') {
  if (caps.haptics) post({ type: 'koda:haptic', style })
}

/** Ask the shell to present the native picker. pick.js is the public door — it adds the fallback. */
export function requestPick({ kind, multiple, types }) {
  const id = `pick-${++pickSeq}`
  return new Promise((resolve, reject) => {
    picks.set(id, { resolve, reject })
    post({ type: 'koda:pick', id, kind, multiple: !!multiple, types })
  })
}
