import type {
  EngineId,
  SessionCapability,
  SessionCapabilitySnapshot,
  SessionMcpServer,
} from './ipc'

export interface CapabilityObservation {
  engine: EngineId
  cwd: string
  source: SessionCapabilitySnapshot['source']
  tools?: string[]
  skills?: string[]
  agents?: string[]
  plugins?: string[]
  mcpServers?: SessionMcpServer[]
  expected: {
    kodaTools: boolean
    playbooks: boolean
    browserTesting: boolean
  }
  /** A native inventory call failed or returned an unreadable shape. */
  probeFailed?: { skills?: boolean; mcp?: boolean }
  observedAt?: number
}

const KODA_SERVER = 'koda_broker'
const PLAYWRIGHT_SERVER = 'playwright'
const KODA_PLAYBOOK_PREFIXES = ['koda:', 'koda-staging:', 'koda-skills:']

function unique(values: string[] = []): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function mcpServerUsable(server: SessionMcpServer): boolean {
  return !/(?:pending|starting|failed|error|disconnected|unreachable|cancelled|needs.?auth|not.?logged.?in)/i.test(
    server.status,
  )
}

function namespacedTools(servers: SessionMcpServer[]): string[] {
  return servers.flatMap((server) =>
    mcpServerUsable(server) ? server.tools.map((tool) => `mcp__${server.name}__${tool}`) : [],
  )
}

function capability(
  id: SessionCapability['id'],
  label: string,
  status: SessionCapability['status'],
  detail?: string,
): SessionCapability {
  return { id, label, status, ...(detail ? { detail } : {}) }
}

/** Build one normalized runtime snapshot from either engine's native evidence. */
export function buildSessionCapabilitySnapshot(observation: CapabilityObservation): SessionCapabilitySnapshot {
  const mcpServers = [...(observation.mcpServers ?? [])]
    .map((server) => ({ ...server, tools: unique(server.tools) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const unusableServers = new Set(
    mcpServers.filter((server) => !mcpServerUsable(server)).map((server) => server.name),
  )
  const observedTools = (observation.tools ?? []).filter(
    (tool) => ![...unusableServers].some((server) => tool.startsWith(`mcp__${server}__`)),
  )
  const tools = unique([...observedTools, ...namespacedTools(mcpServers)])
  const skills = unique(observation.skills)
  const agents = unique(observation.agents)
  const plugins = unique(observation.plugins)

  const kodaToolCount = tools.filter((name) => name.startsWith(`mcp__${KODA_SERVER}__`)).length
  const browserToolCount = tools.filter((name) => name.startsWith(`mcp__${PLAYWRIGHT_SERVER}__`)).length
  const kodaPlaybookCount = skills.filter((name) =>
    KODA_PLAYBOOK_PREFIXES.some((prefix) => name.startsWith(prefix)),
  ).length
  const capabilityDirectoryReady = tools.includes(`mcp__${KODA_SERVER}__capabilities`)
  const browserPlaybookReady = skills.some(
    (name) => name === 'browser-verify' || name.endsWith(':browser-verify'),
  )

  const capabilities: SessionCapability[] = []
  capabilities.push(
    kodaToolCount > 0 && capabilityDirectoryReady && !observation.probeFailed?.mcp
        ? capability('koda-tools', 'Koda tools', 'ready')
        : !observation.expected.kodaTools
          ? capability('koda-tools', 'Koda tools', 'disabled')
          : capability(
            'koda-tools',
            'Koda tools',
            'degraded',
            observation.probeFailed?.mcp
              ? 'The engine could not inspect its MCP servers.'
              : kodaToolCount > 0
                ? 'The Koda broker loaded without its capability directory.'
                : 'The Koda broker exposed no usable tools.',
          ),
  )
  capabilities.push(
    kodaPlaybookCount > 0 && !observation.probeFailed?.skills
        ? capability('playbooks', 'Koda playbooks', 'ready')
        : !observation.expected.playbooks
          ? capability('playbooks', 'Koda playbooks', 'disabled')
          : capability(
            'playbooks',
            'Koda playbooks',
            'degraded',
            observation.probeFailed?.skills
              ? 'The engine could not inspect its playbooks.'
              : 'No Koda playbooks were observed in this workspace.',
          ),
  )
  capabilities.push(
    browserToolCount > 0 && browserPlaybookReady && !observation.probeFailed?.mcp
        ? capability('browser-testing', 'Browser testing', 'ready')
        : !observation.expected.browserTesting
          ? capability('browser-testing', 'Browser testing', 'disabled')
          : capability(
            'browser-testing',
            'Browser testing',
            'degraded',
            observation.probeFailed?.mcp
              ? 'The engine could not inspect its MCP servers.'
              : browserToolCount === 0
                ? 'Playwright was enabled but exposed no browser tools.'
                : 'Browser tools loaded without Koda\'s browser-verification playbook.',
          ),
  )

  return {
    engine: observation.engine,
    cwd: observation.cwd,
    observedAt: observation.observedAt ?? Date.now(),
    source: observation.source,
    capabilities,
    tools,
    skills,
    agents,
    plugins,
    mcpServers,
  }
}

/** Stable content identity for deduping repeated native init messages (timestamp deliberately absent). */
export function capabilitySnapshotFingerprint(snapshot: SessionCapabilitySnapshot): string {
  const { observedAt: _observedAt, ...stable } = snapshot
  return JSON.stringify(stable)
}

/** Codex returns one skill group per cwd. Never borrow another workspace's list: prefer the exact cwd;
 * accept an unscoped single group only for protocol versions that omit the field. */
export function codexSkillNames(result: unknown, cwd: string): string[] | null {
  if (!result || typeof result !== 'object') return null
  const data = (result as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const groups = data.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
  const exact = groups.filter((entry) => entry.cwd === cwd)
  const selected = exact.length > 0 ? exact : groups.length === 1 && groups[0].cwd === undefined ? groups : []
  const names: string[] = []
  for (const group of selected) {
    if (!Array.isArray(group.skills)) return null
    for (const skill of group.skills) {
      if (!skill || typeof skill !== 'object') continue
      const metadata = skill as { name?: unknown; enabled?: unknown }
      if (metadata.enabled !== undefined && typeof metadata.enabled !== 'boolean') return null
      if (metadata.enabled === false) continue
      const name = metadata.name
      if (typeof name === 'string') names.push(name)
    }
  }
  return unique(names)
}

/** Parse Codex's full MCP inventory without treating an unreadable response as an empty, healthy one. */
export function codexMcpServers(result: unknown): SessionMcpServer[] | null {
  if (!result || typeof result !== 'object') return null
  const data = (result as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const servers: SessionMcpServer[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') return null
    const server = entry as Record<string, unknown>
    if (typeof server.name !== 'string') return null
    const rawTools = server.tools
    const tools = Array.isArray(rawTools)
      ? rawTools.filter((tool): tool is string => typeof tool === 'string')
      : rawTools && typeof rawTools === 'object'
        ? Object.keys(rawTools)
        : []
    const rawStatus = typeof server.status === 'string' ? server.status : server.state
    servers.push({
      name: server.name,
      status: typeof rawStatus === 'string' ? rawStatus : tools.length > 0 ? 'connected' : 'unknown',
      tools,
    })
  }
  return servers
}
