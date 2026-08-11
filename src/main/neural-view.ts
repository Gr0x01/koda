/**
 * Developer prototype for the living-codebase view.
 *
 * The experiment renderer stays an ordinary web page, but its event source is Koda's normalized
 * engine stream rather than a Claude log tail. One pop-out belongs to one project and receives
 * every Claude/Codex session in that project. Nothing is persisted.
 */
import http, { type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { EngineEvent, EngineId } from '@shared/ipc'
import { log } from './logger'
import { knownProjectPaths } from './session-store'

/** The bodies in the sky: every project ever worked in on this Mac that still exists (Koda's own
 * registry — the phone's whitelist too, never an arbitrary directory scan), plus the pop-out's own
 * project. So the whole solar system is there without opening each project in its own window. */
function skyProjectPaths(current: string): string[] {
  return [...new Set([current, ...knownProjectPaths()])]
}

interface NeuralGraph {
  project: { id: string; name: string }
  nodes: { path: string; area: string; lines: number; birth: number }[]
  edges: [number, number][]
  commits: { t: number; f: number[] }[]
}

interface NeuralProject {
  id: string
  path: string
  graph: NeuralGraph | null
  files: number
}

interface NeuralViewState {
  win: BrowserWindow
  server: http.Server
  clients: Set<ServerResponse>
  ring: NeuralActivity[]
  pendingWrites: Map<string, string[]>
  projects: Map<string, NeuralProject>
}

interface NeuralActivity {
  projectId?: string
  sessionId: string
  engine?: EngineId
  verb: string
  path?: string
  pattern?: string
  parentToolUseId?: string
  subagentId?: string
  links?: string[]
}

const views = new Map<string, NeuralViewState>()
const opening = new Map<string, Promise<void>>()
const RING_MAX = 60

function experimentDir(): string {
  return join(app.getAppPath(), 'experiments', 'neural-view')
}

function projectId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12)
}

/** Subsystem = the top-level folder (under a leading src/ if present). Generic across project
 * shapes: Koda → main/renderer/shared/preload/mobile; a Next app → app/components/lib/hooks. */
function graphArea(path: string): string {
  const segments = path.split('/')
  if (segments[0] === 'src' && segments.length > 2) return segments[1]
  return segments.length > 1 ? segments[0] : 'other'
}

/** The project's OWN tsconfig path aliases (e.g. Next.js `@/*` → `./src/*`) so imports through
 * aliases resolve for any project shape. Standard tsconfig is plain JSON; a JSONC one just yields
 * no aliases (relative imports still resolve). */
function tsconfigAliases(root: string): { prefix: string; dir: string }[] {
  const file = join(root, 'tsconfig.json')
  if (!existsSync(file)) return []
  let cfg: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const options = cfg.compilerOptions ?? {}
  const base = options.baseUrl ? join(root, options.baseUrl) : root
  const aliases: { prefix: string; dir: string }[] = []
  for (const [key, targets] of Object.entries(options.paths ?? {}))
    if (Array.isArray(targets) && targets.length)
      aliases.push({ prefix: key.replace(/\*$/, ''), dir: join(base, targets[0].replace(/\*$/, '')) })
  return aliases
}

/** A deliberately small runtime graph builder for other *open* TypeScript projects. The Koda
 * graph keeps its richer committed history; other projects only need enough structure to be a sun
 * now and a connectome when selected. */
function graphForProject(path: string): NeuralGraph | null {
  if (path === app.getAppPath()) {
    return JSON.parse(readFileSync(join(experimentDir(), 'neuron-graph.json'), 'utf8')) as NeuralGraph
  }
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['.git', '.koda', '.next', '.venv', 'node_modules', 'dist', 'out', 'build', 'coverage', 'Pods', 'DerivedData'].includes(name)) continue
      const file = join(dir, name)
      const stat = statSync(file)
      if (stat.isDirectory()) walk(file)
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|swift|html|css)$/.test(name) && !name.endsWith('.d.ts')) files.push(file)
    }
  }
  try { walk(path) } catch { return null }
  if (!files.length) return null
  const paths = files.map((file) => relative(path, file))
  const index = new Map(paths.map((file, i) => [file, i]))
  const aliases = tsconfigAliases(path)
  const resolveImport = (from: string, spec: string): string | null => {
    let base: string
    if (spec.startsWith('.')) base = resolve(dirname(from), spec)
    else {
      const hit = aliases.find((alias) => spec.startsWith(alias.prefix))
      if (hit) base = join(hit.dir, spec.slice(hit.prefix.length))
      else if (spec.startsWith('@renderer')) base = join(path, 'src', 'renderer/src', spec.slice('@renderer'.length + 1))
      else if (spec.startsWith('@shared')) base = join(path, 'src', 'shared', spec.slice('@shared'.length + 1))
      else return null
    }
    for (const candidate of [base + '.ts', base + '.tsx', base + '.js', base + '.jsx', join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')])
      if (existsSync(candidate)) return relative(path, candidate)
    return null
  }
  const edges: [number, number][] = []
  for (const file of files) {
    const from = index.get(relative(path, file))
    if (from == null) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, match[1])
      const to = target == null ? undefined : index.get(target)
      if (to != null && to !== from) edges.push([from, to])
    }
  }
  const now = Math.floor(Date.now() / 1000)
  return {
    project: { id: projectId(path), name: basename(path) || path },
    nodes: files.map((file) => ({ path: relative(path, file), area: graphArea(relative(path, file)), lines: readFileSync(file, 'utf8').split('\n').length, birth: now })),
    edges,
    commits: [],
  }
}

function buildHtml(selected: NeuralProject, projects: Map<string, NeuralProject>): { html: string; csp: string } {
  const dir = experimentDir()
  if (!selected.graph) throw new Error('This project has no source graph yet')
  selected.graph.project = { id: selected.id, name: basename(selected.path) || selected.path }
  const system = systemManifest(projects)
  const html = readFileSync(join(dir, 'neural-view-3d.html'), 'utf8')
    .replace('__GRAPH__', JSON.stringify(selected.graph))
    .replace('__SYSTEM__', JSON.stringify(system))
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!inline) throw new Error('Neural View inline script was not found')
  const hash = createHash('sha256').update(inline).digest('base64')
  return {
    html,
    csp:
      `default-src 'none'; script-src 'sha256-${hash}' https://unpkg.com; ` +
      "style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src 'none'; object-src 'none'; base-uri 'none'",
  }
}

function systemManifest(projects: Map<string, NeuralProject>): { projects: { id: string; name: string; files: number; graph: boolean }[] } {
  return { projects: [...projects.values()].map((project) => ({ id: project.id, name: basename(project.path) || project.path, files: project.files, graph: Boolean(project.graph) })) }
}

/** Reconcile the solar system with Koda's open windows. Keep the view's current project centred
 * while its pop-out is alive, but remove every other project as soon as its window closes. */
function reconcileOpenProjects(projects: Map<string, NeuralProject>, paths: string[], keepPath?: string): boolean {
  let changed = false
  const open = new Set(paths)
  for (const [id, project] of projects) {
    if (project.path !== keepPath && !open.has(project.path)) { projects.delete(id); changed = true }
  }
  for (const path of paths) {
    const id = projectId(path)
    if (projects.has(id)) continue
    // Now that the sky spans every known project, one project with an unreadable file must not
    // sink the whole pop-out — it just becomes a graph-less body.
    let graph: NeuralGraph | null = null
    try { graph = graphForProject(path) } catch (err) {
      log.warn('neural-view', `graph build failed for ${path} (shown as a dim body)`, err instanceof Error ? err.message : err)
    }
    projects.set(id, { id, path, graph, files: graph?.nodes.length ?? 0 })
    changed = true
  }
  return changed
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function projectRelative(projectPath: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const path = relative(projectPath, isAbsolute(value) ? value : resolve(projectPath, value))
  return !path || path === '..' || path.startsWith('../') || isAbsolute(path) ? undefined : path
}

/** Match the graph builder's local-import rules after a successful file write. */
function liveImportTargets(projectPath: string, path: string): string[] {
  if (!/^src\/.*\.(ts|tsx)$/.test(path)) return []
  try {
    const source = readFileSync(join(projectPath, path), 'utf8')
    const fromFile = join(projectPath, path)
    const targets = new Set<string>()
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      let base: string
      if (spec.startsWith('@renderer')) base = join(projectPath, 'src', 'renderer', 'src', spec.slice('@renderer'.length + 1))
      else if (spec.startsWith('@shared')) base = join(projectPath, 'src', 'shared', spec.slice('@shared'.length + 1))
      else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
      else continue
      for (const candidate of [base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
        if (existsSync(candidate)) { targets.add(relative(projectPath, candidate)); break }
      }
    }
    return [...targets]
  } catch {
    return []
  }
}

export function neuralActivityForEvent(
  projectPath: string,
  event: EngineEvent,
  engine?: EngineId,
): NeuralActivity | undefined {
  const base = { sessionId: event.sessionId, engine }
  if (event.type === 'ToolRequested') {
    const input = inputRecord(event.input)
    const path = projectRelative(projectPath, input.file_path ?? input.path)
    const name = event.name === 'MultiEdit' ? 'Edit' : event.name
    return {
      ...base,
      verb: name,
      path,
      pattern: typeof input.pattern === 'string' ? input.pattern : undefined,
      parentToolUseId: event.parentToolUseId,
    }
  }
  if (event.type === 'AssistantBlock')
    return { ...base, verb: 'Thinking', parentToolUseId: event.parentToolUseId }
  if (event.type === 'ThinkingDelta' || event.type === 'AssistantDelta')
    return { ...base, verb: 'Thinking' }
  if (event.type === 'SubagentStarted')
    return { ...base, verb: 'Task', subagentId: event.toolUseId }
  if (event.type === 'SubagentProgress')
    return { ...base, verb: 'Task', subagentId: event.toolUseId }
  if (event.type === 'SubagentCompleted')
    return { ...base, verb: 'Report', subagentId: event.toolUseId }
  if (event.type === 'TurnComplete' || (event.type === 'EngineError' && event.fatal))
    return { ...base, verb: 'Idle' }
  return undefined
}

export function publishNeuralEvent(projectPath: string | undefined, event: EngineEvent, engine?: EngineId): void {
  if (!projectPath) return
  for (const [viewPath, state] of views) {
    const refreshed = reconcileOpenProjects(state.projects, skyProjectPaths(viewPath), viewPath)
    if (refreshed) {
      const system = systemManifest(state.projects)
      const update = { sessionId: '', verb: 'System', system }
      state.ring.push(update)
      for (const client of state.clients) client.write(`data: ${JSON.stringify(update)}\n\n`)
    }
    const project = [...state.projects.values()].find((candidate) => candidate.path === projectPath)
    if (!project) continue
    const send = (activity: NeuralActivity) => {
    const scoped = { ...activity, projectId: project.id }
    state.ring.push(scoped)
    if (state.ring.length > RING_MAX) state.ring.shift()
    const line = `data: ${JSON.stringify(scoped)}\n\n`
    for (const client of state.clients) client.write(line)
    }
    if (event.type === 'ToolRequested' && /^(Write|Edit|MultiEdit)$/.test(event.name)) {
    const input = inputRecord(event.input)
    const values = [input.file_path ?? input.path, ...(Array.isArray(input.file_paths) ? input.file_paths : [])]
    const paths = [...new Set(values.map((value) => projectRelative(projectPath, value)).filter((path): path is string => Boolean(path)))]
    if (paths.length) state.pendingWrites.set(`${event.sessionId}:${event.id}`, paths)
    }
    if (event.type === 'ToolResult') {
    const paths = state.pendingWrites.get(`${event.sessionId}:${event.id}`)
    state.pendingWrites.delete(`${event.sessionId}:${event.id}`)
    if (paths && !event.isError) for (const path of paths)
      send({ sessionId: event.sessionId, engine, verb: 'Links', path, links: liveImportTargets(projectPath, path) })
    }
    const activity = neuralActivityForEvent(projectPath, event, engine)
    if (activity) send(activity)
  }
}

export function openNeuralView(projectPath: string): Promise<void> {
  const existing = views.get(projectPath)
  if (existing && !existing.win.isDestroyed()) {
    existing.win.show()
    existing.win.focus()
    return Promise.resolve()
  }
  const pending = opening.get(projectPath)
  if (pending) return pending
  const task = openNeuralViewInner(projectPath).finally(() => opening.delete(projectPath))
  opening.set(projectPath, task)
  return task
}

async function openNeuralViewInner(projectPath: string): Promise<void> {
  const clients = new Set<ServerResponse>()
  const ring: NeuralActivity[] = []
  const pendingWrites = new Map<string, string[]>()
  const projects = new Map<string, NeuralProject>()
  reconcileOpenProjects(projects, skyProjectPaths(projectPath), projectPath)
  const selected = projects.get(projectId(projectPath))
  if (!selected?.graph) throw new Error('This project has no source graph yet')
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/system')) {
      reconcileOpenProjects(projects, skyProjectPaths(projectPath), projectPath)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(systemManifest(projects)))
      return
    }
    if (req.url?.startsWith('/graph')) {
      // A neighbour project's full graph, so the renderer can shape its constellation figure.
      const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('project')
      const project = projects.get(id ?? '')
      if (!project?.graph) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(project.graph))
      return
    }
    if (req.url?.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      for (const activity of ring) res.write(`data: ${JSON.stringify(activity)}\n\n`)
      clients.add(res)
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(res)
      })
      return
    }
    const requested = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('project')
    const requestedProject = projects.get(requested ?? '')
    const page = buildHtml(requestedProject?.graph ? requestedProject : selected, projects)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': page.csp,
    })
    res.end(page.html)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Neural View server did not acquire a local port')
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#05080f',
    title: `Neural View — ${projectPath.split('/').filter(Boolean).pop() || 'Koda'}`,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const state: NeuralViewState = { win, server, clients, ring, pendingWrites, projects }
  views.set(projectPath, state)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (views.get(projectPath) === state) views.delete(projectPath)
    for (const client of clients) client.end()
    server.close()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('render-process-gone', (_event, details) => {
    log.warn('neural-view', `renderer gone (${details.reason})`)
  })
  try {
    await win.loadURL(`http://127.0.0.1:${address.port}/?koda`)
  } catch (err) {
    if (views.get(projectPath) === state) views.delete(projectPath)
    if (!win.isDestroyed()) win.destroy()
    for (const client of clients) client.end()
    if (server.listening) server.close()
    throw err
  }
}

export function closeAllNeuralViews(): void {
  for (const state of views.values()) if (!state.win.isDestroyed()) state.win.close()
}
