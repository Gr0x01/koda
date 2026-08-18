import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'MonacoFileEditor.tsx'), 'utf8')

function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `${signature} is gone from MonacoFileEditor.tsx`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces after ${signature}`)
}

describe('Monaco file writer', () => {
  it('serializes every save door and exposes that drain to filesystem mutations', () => {
    expect(SOURCE).toContain('createSerialFlush(() => saveRef.current())')
    expect(SOURCE).toContain('registerFileWriter(path, surfacePath, async () => {')
    expect(SOURCE).toContain('await flushSave()')
    expect(SOURCE).toContain('void flushSave().catch(() => {}).finally(unregister)')
    expect(SOURCE).not.toContain('() => void saveRef.current()')
    expect(SOURCE).not.toContain('onClick={() => void save()}')
  })

  it('baselines the content actually sent, never newer text typed during that write', () => {
    const save = functionBody(SOURCE, 'async function save()')
    expect(save).toContain('const content = valueRef.current')
    expect(save).toContain('window.koda.writeFile({ path, content })')
    expect(save).toContain('baselineRef.current = content')
    expect(save).toContain('setDirty(valueRef.current !== content)')
    expect(save).not.toMatch(/readOnly \|\| saving/)
  })
})
