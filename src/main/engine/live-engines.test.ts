import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { liveEngineVersion, resolveEnginePath, setLiveEngineRoot } from './binary'
import { pruneLiveEngines, updateLiveEngine } from './live-engines'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
/** A stand-in engine: a shell script that answers `--version` the way the real binary does. */
const fakeClaude = (version: string) => `#!/bin/sh\necho "${version} (Claude Code)"\n`

function claudeUpstream(version: string, body: string, checksum = sha256(body)): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith('/latest')) return new Response(version)
    if (url.endsWith(`/${version}/manifest.json`)) {
      return Response.json({ platforms: { 'test-platform': { checksum } } })
    }
    if (url.endsWith(`/${version}/test-platform/claude`)) return new Response(body)
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'koda-live-engines-'))
  setLiveEngineRoot(root)
})

afterEach(() => {
  setLiveEngineRoot(null)
  rmSync(root, { recursive: true, force: true })
})

describe('live engines', () => {
  it('installs upstream latest and resolves it ahead of the bundled copy', async () => {
    const installed = await updateLiveEngine(root, 'claude', {
      fetchImpl: claudeUpstream('9.9.1', fakeClaude('9.9.1')),
      platform: 'test-platform',
    })

    expect(installed).toBe('9.9.1')
    expect(resolveEnginePath()).toEqual({ path: join(root, 'claude', '9.9.1', 'claude'), source: 'live' })
  })

  it('does nothing when the live engine already matches upstream', async () => {
    const opts = { fetchImpl: claudeUpstream('9.9.1', fakeClaude('9.9.1')), platform: 'test-platform' }
    await updateLiveEngine(root, 'claude', opts)

    expect(await updateLiveEngine(root, 'claude', opts)).toBeNull()
  })

  it('keeps the previous engine when the download fails its checksum', async () => {
    await updateLiveEngine(root, 'claude', {
      fetchImpl: claudeUpstream('9.9.1', fakeClaude('9.9.1')),
      platform: 'test-platform',
    })

    await expect(
      updateLiveEngine(root, 'claude', {
        fetchImpl: claudeUpstream('9.9.2', fakeClaude('9.9.2'), 'f'.repeat(64)),
        platform: 'test-platform',
      }),
    ).rejects.toThrow(/checksum mismatch/)
    expect(liveEngineVersion(root, 'claude')).toBe('9.9.1')
    expect(existsSync(join(root, 'claude', '9.9.2'))).toBe(false)
  })

  it('refuses a build that does not report the version it was published as', async () => {
    await expect(
      updateLiveEngine(root, 'claude', {
        fetchImpl: claudeUpstream('9.9.3', fakeClaude('1.0.0')),
        platform: 'test-platform',
      }),
    ).rejects.toThrow(/reported/)
    expect(liveEngineVersion(root, 'claude')).toBeNull()
  })

  it('leaves superseded versions in place while running and prunes them at the next launch', async () => {
    for (const version of ['9.9.1', '9.9.2', '9.9.3']) {
      await updateLiveEngine(root, 'claude', {
        fetchImpl: claudeUpstream(version, fakeClaude(version)),
        platform: 'test-platform',
      })
    }
    // A session started on 9.9.1 may still be running out of that directory.
    expect(existsSync(join(root, 'claude', '9.9.1', 'claude'))).toBe(true)

    pruneLiveEngines(root)

    expect(existsSync(join(root, 'claude', '9.9.1'))).toBe(false)
    expect(existsSync(join(root, 'claude', '9.9.2'))).toBe(false)
    expect(existsSync(join(root, 'claude', '9.9.3', 'claude'))).toBe(true)
    expect(readFileSync(join(root, 'claude', 'current'), 'utf8').trim()).toBe('9.9.3')
  })

  it('falls back past a current marker that names a missing version', () => {
    mkdirSync(join(root, 'claude'), { recursive: true })
    writeFileSync(join(root, 'claude', 'current'), '9.9.9\n')

    // Whatever resolves next (bundled, an installed CLI, or nothing on a bare CI box), it is not live.
    let source: string
    try {
      source = resolveEnginePath().source
    } catch {
      source = 'none'
    }
    expect(source).not.toBe('live')
  })
})
