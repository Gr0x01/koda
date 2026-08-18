import { describe, expect, it } from 'vitest'
import {
  buildSessionCapabilitySnapshot,
  capabilitySnapshotFingerprint,
  codexMcpServers,
  codexSkillNames,
} from './session-capabilities'

describe('effective session capabilities', () => {
  it('reports only observed tools as ready and keeps disabled distinct from degraded', () => {
    const snapshot = buildSessionCapabilitySnapshot({
      engine: 'codex',
      cwd: '/project',
      source: 'native-probe',
      expected: { kodaTools: true, playbooks: true, browserTesting: false },
      skills: ['koda:code-work', 'project:custom'],
      mcpServers: [
        { name: 'koda_broker', status: 'connected', tools: ['preview', 'capabilities'] },
      ],
      observedAt: 10,
    })

    expect(snapshot.tools).toEqual([
      'mcp__koda_broker__capabilities',
      'mcp__koda_broker__preview',
    ])
    expect(snapshot.capabilities).toEqual([
      { id: 'koda-tools', label: 'Koda tools', status: 'ready' },
      { id: 'playbooks', label: 'Koda playbooks', status: 'ready' },
      { id: 'browser-testing', label: 'Browser testing', status: 'disabled' },
    ])
  })

  it('fails closed when native inventory calls are unreadable', () => {
    const snapshot = buildSessionCapabilitySnapshot({
      engine: 'codex',
      cwd: '/project',
      source: 'native-probe',
      expected: { kodaTools: true, playbooks: true, browserTesting: true },
      probeFailed: { skills: true, mcp: true },
      observedAt: 20,
    })
    expect(snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'degraded'],
      ['playbooks', 'degraded'],
      ['browser-testing', 'degraded'],
    ])
  })

  it('does not call cached tools ready when their MCP server reports failure', () => {
    const snapshot = buildSessionCapabilitySnapshot({
      engine: 'claude',
      cwd: '/project',
      source: 'engine-init',
      expected: { kodaTools: true, playbooks: true, browserTesting: true },
      tools: [
        'mcp__koda_broker__capabilities',
        'mcp__playwright__browser_navigate',
      ],
      skills: ['koda:memory', 'koda:browser-verify'],
      mcpServers: [
        { name: 'koda_broker', status: 'failed', tools: ['capabilities'] },
        { name: 'playwright', status: 'disconnected', tools: ['browser_navigate'] },
      ],
    })

    expect(snapshot.tools).toEqual([])
    expect(snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'degraded'],
      ['playbooks', 'ready'],
      ['browser-testing', 'degraded'],
    ])
  })

  it('treats observed runtime evidence as ready even when configuration expected it off', () => {
    const snapshot = buildSessionCapabilitySnapshot({
      engine: 'claude',
      cwd: '/project',
      source: 'engine-init',
      expected: { kodaTools: false, playbooks: false, browserTesting: false },
      tools: ['mcp__koda_broker__capabilities', 'mcp__playwright__browser_navigate'],
      skills: ['koda:memory', 'koda:browser-verify'],
    })
    expect(snapshot.capabilities.map(({ id, status }) => [id, status])).toEqual([
      ['koda-tools', 'ready'],
      ['playbooks', 'ready'],
      ['browser-testing', 'ready'],
    ])
  })

  it('selects Codex skills from the exact workspace instead of the first cached cwd', () => {
    const result = {
      data: [
        { cwd: '/other', skills: [{ name: 'other:skill' }] },
        {
          cwd: '/project',
          skills: [
            { name: 'koda:memory', enabled: true },
            { name: 'koda:documents', enabled: false },
            { name: 'project:local' },
          ],
        },
      ],
    }
    expect(codexSkillNames(result, '/project')).toEqual(['koda:memory', 'project:local'])
    expect(codexSkillNames(result, '/missing')).toEqual([])
    expect(codexSkillNames({}, '/project')).toBeNull()
  })

  it('recognizes every Koda-managed playbook namespace', () => {
    for (const name of ['koda:memory', 'koda-staging:create-mini-app', 'koda-skills:canvas-design']) {
      const snapshot = buildSessionCapabilitySnapshot({
        engine: 'claude',
        cwd: '/project',
        source: 'engine-init',
        expected: { kodaTools: false, playbooks: true, browserTesting: false },
        skills: [name],
      })
      expect(snapshot.capabilities.find((entry) => entry.id === 'playbooks')?.status).toBe('ready')
    }
  })

  it('parses MCP object keys and fingerprints content without the observation time', () => {
    const servers = codexMcpServers({
      data: [{ name: 'koda_broker', tools: { preview: {}, capabilities: {} } }],
    })
    expect(servers).toEqual([
      { name: 'koda_broker', status: 'connected', tools: ['preview', 'capabilities'] },
    ])
    const first = buildSessionCapabilitySnapshot({
      engine: 'claude',
      cwd: '/project',
      source: 'engine-init',
      expected: { kodaTools: true, playbooks: true, browserTesting: false },
      tools: ['mcp__koda_broker__capabilities'],
      skills: ['koda:memory'],
      observedAt: 1,
    })
    expect(capabilitySnapshotFingerprint({ ...first, observedAt: 999 })).toBe(
      capabilitySnapshotFingerprint(first),
    )
  })
})
