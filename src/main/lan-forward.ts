/**
 * LAN preview forwarder. A session's dev server binds 127.0.0.1:<devPort> (localhost only), so a phone
 * on the same WiFi can't reach it directly. This opens a tiny raw-TCP relay on 0.0.0.0:<ephemeral> that
 * pipes bytes to 127.0.0.1:<devPort>, so the phone loads http://<mac-lan-ip>:<forwardPort> and gets the
 * REAL page natively — crisp, and staying entirely on the local network (no cloud-relay hairpin).
 *
 * Raw byte forwarding is deliberately protocol-agnostic: it carries the dev server's HTTP *and* its HMR
 * WebSocket upgrade with zero awareness of either, so hot-reload works for free. The forwarded origin is
 * the whole dev server (root and all), which is what lets Vite's root-relative asset paths (/@vite/client,
 * /src/…) resolve — a sub-path proxy on the control port could not.
 *
 * Auth is network-scoped, matching the same-WiFi control posture: the forwarder only ever exists while a
 * paired phone has Preview open, and it exposes the user's own dev output on their own LAN (the convention
 * for dev servers). It is torn down the moment preview stops or the session ends.
 */
import net from 'node:net'
import { log } from './logger'

/** The forwarder needs one capability, not the private remote stack that minted it. Keeping this
 * structural also lets the curated public build retain same-WiFi preview plumbing after that stack is
 * pruned, without a type-only import into a directory that deliberately does not ship. */
interface LanForwardActivationPermit {
  valid(): boolean
}

interface Forward {
  server: net.Server
  devPort: number
  port: number
  /** Live spliced socket pairs, so stop can drop them at once — server.close() only stops accepting, and a
   *  long-lived connection (a Vite HMR WebSocket rides this forwarder) would otherwise linger past teardown. */
  conns: Set<net.Socket>
}

/** One forwarder per session (v1: a single phone watching a single session, but keyed for correctness). */
const forwards = new Map<string, Forward>()
const forwardGenerations = new Map<string, number>()
let lifecycleEpoch = 0

/**
 * Ensure a LAN forwarder to `devPort` for this session, returning the public port the phone loads. Reuses
 * an existing forwarder unless the dev port changed (a restarted dev server on a new port re-points it).
 */
export function ensureLanForward(
  sessionId: string,
  devPort: number,
  // Required, deliberately: this binds 0.0.0.0. A default permit would let the next caller open that
  // listener without passing the activation gate, and no grep would ever find the omission.
  permit: LanForwardActivationPermit,
): Promise<number> {
  if (!permit.valid()) return Promise.reject(new Error('lan-forward: remote access activation is blocked'))
  const existing = forwards.get(sessionId)
  if (existing && existing.devPort === devPort) return Promise.resolve(existing.port)
  if (existing) stopLanForward(sessionId)
  const generation = (forwardGenerations.get(sessionId) ?? 0) + 1
  forwardGenerations.set(sessionId, generation)
  const epoch = lifecycleEpoch

  const conns = new Set<net.Socket>()
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      // Dial the dev server; splice the two sockets both ways. destroy-on-error keeps a flaky page from
      // leaking half-open sockets. The dev server only listens on loopback, so this never leaves the Mac.
      const upstream = net.connect(devPort, '127.0.0.1')
      conns.add(client)
      conns.add(upstream)
      const kill = (): void => {
        conns.delete(client)
        conns.delete(upstream)
        client.destroy()
        upstream.destroy()
      }
      client.on('close', kill)
      upstream.on('close', kill)
      client.on('error', kill)
      upstream.on('error', kill)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    server.once('error', reject)
    // Ephemeral port on all interfaces so the phone can reach it on the Mac's LAN IP.
    server.listen(0, '0.0.0.0', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      if (typeof addr !== 'object' || !addr) {
        server.close()
        return reject(new Error('lan-forward: no bound address'))
      }
      if (!permit.valid() || lifecycleEpoch !== epoch || forwardGenerations.get(sessionId) !== generation) {
        server.close()
        for (const socket of conns) socket.destroy()
        return reject(new Error('lan-forward: activation was cancelled'))
      }
      forwards.set(sessionId, { server, devPort, port: addr.port, conns })
      log.info('lan-forward', 'started', { sessionId, devPort, port: addr.port })
      resolve(addr.port)
    })
  })
}

/** Tear down a session's forwarder (preview closed / session ended). Idempotent. */
export function stopLanForward(sessionId: string): void {
  forwardGenerations.set(sessionId, (forwardGenerations.get(sessionId) ?? 0) + 1)
  const f = forwards.get(sessionId)
  if (!f) return
  forwards.delete(sessionId)
  f.server.close()
  for (const s of f.conns) s.destroy() // drop live pairs (e.g. an HMR WebSocket); close() only stops accepting
  log.info('lan-forward', 'stopped', { sessionId })
}

/** Tear down every forwarder (remote tier off / app quit). */
export function stopAllLanForwards(): void {
  lifecycleEpoch += 1
  for (const id of [...forwards.keys()]) stopLanForward(id)
}
