import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistEngine } from './engine'

const scratch: string[] = []

function helperAnswer(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'koda-assist-test-'))
  scratch.push(dir)
  const path = join(dir, 'helper')
  const envelope = JSON.stringify({ ok: true, output })
  writeFileSync(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)})\n`)
  chmodSync(path, 0o755)
  return path
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('on-device assist output', () => {
  it('cleans a one-line saved-version subject', async () => {
    const engine = new AssistEngine({
      helperPath: helperAnswer('Subject: Fix phone naming.'),
      enabled: () => true,
    })
    await expect(engine.generateVersion('change evidence')).resolves.toBe('Fix phone naming')
  })

  it('rejects a version answer that grows a body', async () => {
    const engine = new AssistEngine({
      helperPath: helperAnswer('Fix phone naming\n\nThis also updates the tests.'),
      enabled: () => true,
    })
    await expect(engine.generateVersion('change evidence')).resolves.toBeNull()
  })

  it('keeps the deterministic title floor when the local model is disabled', async () => {
    const engine = new AssistEngine({
      helperPath: helperAnswer('Ignored model title'),
      enabled: () => false,
    })
    await expect(engine.assist('title', 'fix the phone naming')).resolves.toBe('fix the phone naming')
  })
})
