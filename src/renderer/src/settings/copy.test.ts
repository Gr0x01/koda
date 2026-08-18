import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Settings row anatomy is label + ONE sentence + control (B4). That bar is a copy rule, so it
 * only holds if something checks it: a second sentence smuggled into a `description` is exactly the
 * drift that turned these rows into paragraphs before. Section-level context belongs in the
 * `SettingsSection` `note`, which is allowed to run long.
 *
 * Only static string attributes can be read this way; state-derived copy needs focused behavioral
 * coverage. Em dashes are banned in shipped copy across the app.
 */

const DIR = join(__dirname)
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.tsx'))

/** Static `description="…"` / `label="…"` / `note="…"` values, with their file for the failure. */
function staticAttrs(attr: string): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = []
  for (const file of FILES) {
    const src = readFileSync(join(DIR, file), 'utf8')
    for (const m of src.matchAll(new RegExp(`\\s${attr}="([^"]+)"`, 'g'))) {
      found.push({ file, value: m[1] })
    }
  }
  return found
}

/** A sentence break is a period, question mark, or exclamation followed by a capitalised word. */
function sentenceCount(text: string): number {
  return 1 + (text.match(/[.!?]\s+["“(]?[A-Z]/g)?.length ?? 0)
}

describe('settings copy', () => {
  it('keeps every static row description to one sentence', () => {
    const long = staticAttrs('description')
      .filter((d) => sentenceCount(d.value) > 1)
      .map((d) => `${d.file}: ${d.value}`)
    expect(long).toEqual([])
  })

  it('ends every static row description as a sentence', () => {
    const unfinished = staticAttrs('description')
      .filter((d) => !/[.!?]$/.test(d.value.trim()))
      .map((d) => `${d.file}: ${d.value}`)
    expect(unfinished).toEqual([])
  })

  it('uses no em dashes in row or section copy', () => {
    const dashed = [...staticAttrs('description'), ...staticAttrs('label'), ...staticAttrs('note')]
      .filter((d) => d.value.includes('—'))
      .map((d) => `${d.file}: ${d.value}`)
    expect(dashed).toEqual([])
  })
})
