import { describe, expect, it } from 'vitest'
import { compactToolOutput, compactTranscriptToolOutput } from './tool-output'

describe('compactToolOutput', () => {
  it('keeps short results byte-for-byte and bounds long results to the visible tail', () => {
    expect(compactToolOutput('short result')).toBe('short result')

    const compacted = compactToolOutput(`old-prefix-${'x'.repeat(3_000)}-LATEST`)
    expect(compacted).toHaveLength(2_000)
    expect(compacted).toContain('showing latest')
    expect(compacted).not.toContain('old-prefix')
    expect(compacted.endsWith('-LATEST')).toBe(true)
  })

  it('compacts top-level and delegated tool fields without mutating the live transcript', () => {
    const long = `old-${'x'.repeat(3_000)}-LATEST`
    const items = [
      { kind: 'tool', result: long, liveOutput: long },
      {
        kind: 'subagent',
        children: [
          { kind: 'assistant', markdown: 'kept' },
          { kind: 'tool', result: long },
        ],
      },
    ]

    const compacted = compactTranscriptToolOutput(items)
    const compactedChild = (compacted[1] as { children: { result?: string }[] }).children[1]
    const liveChild = (items[1] as { children: { result?: string }[] }).children[1]

    expect(compacted[0].result).toHaveLength(2_000)
    expect(compacted[0].liveOutput).toHaveLength(2_000)
    expect(compactedChild?.result).toHaveLength(2_000)
    expect(items[0].result).toBe(long)
    expect(liveChild?.result).toBe(long)
  })

  it('keeps AskUserQuestion result state complete for reload parsing', () => {
    const result = JSON.stringify({ answers: { choice: 'x'.repeat(3_000) } })
    const [question] = compactTranscriptToolOutput([
      { kind: 'tool', name: 'AskUserQuestion', result },
    ])

    expect(question.result).toBe(result)
  })
})
