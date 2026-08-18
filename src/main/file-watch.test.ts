import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import {
  projectFileWatchRefsForTest,
  unwatchProjectFile,
  watchProjectFile,
} from './file-watch'

let root: string
let path: string
let destroyed: (() => void) | undefined
let wc: WebContents

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'koda-file-watch-'))
  path = join(root, 'document.md')
  writeFileSync(path, '# Document\n')
  destroyed = undefined
  wc = {
    once: vi.fn((_event: string, listener: () => void) => {
      destroyed = listener
      return wc
    }),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  } as unknown as WebContents
})

afterEach(() => {
  destroyed?.()
  rmSync(root, { recursive: true, force: true })
})

describe('project file watcher ownership', () => {
  it('keeps a shared path armed until every consumer releases it', () => {
    watchProjectFile(wc, root, path)
    watchProjectFile(wc, root, path)
    expect(projectFileWatchRefsForTest(wc, path)).toBe(2)

    unwatchProjectFile(wc, path)
    expect(projectFileWatchRefsForTest(wc, path)).toBe(1)

    unwatchProjectFile(wc, path)
    expect(projectFileWatchRefsForTest(wc, path)).toBe(0)
  })
})
