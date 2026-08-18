import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageHistoryDay } from '@shared/ipc'
import { buildUsageValue } from '@shared/usage-value'
import { EngineUsageBody } from './ProvidersSection'

const MIXED_PRICED_AND_UNPRICED: UsageHistoryDay[] = [
  {
    date: '2026-08-15',
    costUsd: 9.5,
    inputTokens: 360_000,
    outputTokens: 61_000,
    cacheReadTokens: 2_500_000,
    cacheCreationTokens: 125_000,
    turns: 40,
    byModel: {
      'claude-sonnet-4-6': {
        costUsd: 4.1,
        inputTokens: 210_000,
        outputTokens: 38_000,
        cacheReadTokens: 1_800_000,
        cacheCreationTokens: 90_000,
      },
      opusplan: {
        costUsd: 3,
        inputTokens: 60_000,
        outputTokens: 9_000,
        cacheReadTokens: 300_000,
        cacheCreationTokens: 15_000,
      },
      'gpt-5.2-codex': {
        costUsd: 2.4,
        inputTokens: 90_000,
        outputTokens: 14_000,
        cacheReadTokens: 400_000,
        cacheCreationTokens: 20_000,
      },
    },
    byEngine: { claude: 7.1, codex: 2.4 },
  },
]

describe('the rendered provider usage body', () => {
  it('renders only citable dollars for a mixed priced and unpriced engine', () => {
    const claude = buildUsageValue(MIXED_PRICED_AND_UNPRICED).byEngine.claude
    const html = renderToStaticMarkup(createElement(EngineUsageBody, { value: claude, apiActive: false }))

    expect(html).toMatch(/data-testid="usage-headline"[^>]*>\$4\.10<\/span>/)
    expect(html).toContain('Opusplan')
    expect(html).not.toContain('$7.10')
    expect(html).not.toContain('$3.00')
  })

  it('renders tokens and no dollar sign for an engine with no published price', () => {
    const codex = buildUsageValue(MIXED_PRICED_AND_UNPRICED).byEngine.codex
    const html = renderToStaticMarkup(createElement(EngineUsageBody, { value: codex, apiActive: false }))

    expect(html).toMatch(/data-testid="usage-headline"[^>]*>524\.0K tokens<\/span>/)
    expect(html).not.toContain('$')
  })
})
