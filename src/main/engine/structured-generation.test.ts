import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { EngineId } from '@shared/ipc'
import type { StructuredGenerationResult } from './structured-generation'

const spawn = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin?: string }[],
  claudeStdout: '{"ok":true}',
  codexStdout: '',
}))

vi.mock('node:child_process', async () => {
  const { promisify: p } = await import('node:util')
  const { writeFile: write } = await import('node:fs/promises')
  const execFile = (): never => {
    throw new Error('structured generation must use the promisified form')
  }
  Object.defineProperty(execFile, p.custom, {
    value: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
      const call = { file, args, env: opts.env, cwd: opts.cwd, stdin: undefined as string | undefined }
      spawn.calls.push(call)
      const promise = (async () => {
        const outputIndex = args.indexOf('--output-last-message')
        if (outputIndex >= 0) await write(args[outputIndex + 1], '{"ok":true}', 'utf8')
        return {
          stdout: file.endsWith('/codex') ? spawn.codexStdout : spawn.claudeStdout,
          stderr: '',
        }
      })() as Promise<{ stdout: string; stderr: string }> & {
        child: { stdin: { end: (input?: string) => void } }
      }
      promise.child = { stdin: { end: (input?: string) => { call.stdin = input ?? '' } } }
      return promise
    },
  })
  return { execFile }
})

vi.mock('./binary', () => ({
  resolveEnginePath: ({ binaryName }: { binaryName: string }) => ({ path: `/fake/${binaryName}` }),
}))
vi.mock('./env', () => ({ buildEngineEnv: (base: NodeJS.ProcessEnv) => ({ ...base }) }))

const { runStructuredGeneration } = await import('./structured-generation')
const { generateStructuredText } = await import('./generated-text')

function run(
  engineId: EngineId,
  thinking: 'off' | 'engine-default' = 'off',
  model = engineId === 'claude' ? 'haiku' : 'gpt-current',
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): Promise<StructuredGenerationResult> {
  return runStructuredGeneration({
    engineId,
    prompt: 'name this',
    model,
    effort,
    systemPrompt: 'be brief',
    jsonSchema: { type: 'object' },
    timeoutMs: 1000,
    thinking,
  })
}

describe('the shared structured-generation contract', () => {
  beforeEach(() => {
    spawn.calls = []
    spawn.claudeStdout = '{"ok":true}'
    spawn.codexStdout = ''
  })

  it('keeps Claude tool-free, stateless, and on a neutral cwd', async () => {
    await run('claude')
    const { args, cwd, stdin } = spawn.calls[0]
    expect(cwd).toBe(tmpdir())
    expect(args).toContain('--safe-mode')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(stdin).toBe('')
  })

  it('pins Claude thinking off unless the user selected an effort', async () => {
    await run('claude')
    expect(spawn.calls[0].env.MAX_THINKING_TOKENS).toBe('0')

    process.env.MAX_THINKING_TOKENS = '1234'
    try {
      await run('claude', 'engine-default', 'sonnet', 'high')
      const { args, env } = spawn.calls[1]
      expect(args[args.indexOf('--effort') + 1]).toBe('high')
      expect(env.MAX_THINKING_TOKENS).toBeUndefined()
    } finally {
      delete process.env.MAX_THINKING_TOKENS
    }
  })

  it('unwraps Claude output and usage inside the provider adapter', async () => {
    spawn.claudeStdout = JSON.stringify({
      structured_output: { ok: true },
      total_cost_usd: 0.012,
      modelUsage: {
        'claude-haiku-current': {
          inputTokens: 120,
          outputTokens: 8,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 4,
          costUSD: 0.012,
        },
      },
    })

    await expect(run('claude')).resolves.toEqual({
      output: '{"ok":true}',
      costUsd: 0.012,
      models: [{
        model: 'claude-haiku-current',
        costUsd: 0.012,
        inputTokens: 120,
        outputTokens: 8,
        cacheReadTokens: 20,
        cacheCreationTokens: 4,
      }],
    })
  })

  it('runs Codex ephemerally and read-only from the same neutral cwd', async () => {
    spawn.codexStdout = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 180,
          cached_input_tokens: 40,
          cache_write_input_tokens: 10,
          output_tokens: 12,
        },
      }),
    ].join('\n')
    const result = await run('codex', 'engine-default', 'gpt-current', 'high')
    const { file, args, cwd, stdin } = spawn.calls[0]
    expect(file).toBe('/fake/codex')
    expect(cwd).toBe(tmpdir())
    expect(args.slice(0, 6)).toEqual([
      'exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--model',
    ])
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-current')
    expect(args[args.indexOf('--config') + 1]).toBe('model_reasoning_effort="high"')
    expect(args).toContain('--json')
    expect(args).toContain('--output-schema')
    expect(args).toContain('--output-last-message')
    expect(args.at(-1)).toBe('-')
    expect(stdin).toBe('be brief\n\nname this')
    expect(result).toEqual({
      output: '{"ok":true}',
      models: [{
        model: 'gpt-current',
        costUsd: 0,
        inputTokens: 130,
        outputTokens: 12,
        cacheReadTokens: 40,
        cacheCreationTokens: 10,
      }],
    })
    expect(existsSync(args[args.indexOf('--output-schema') + 1])).toBe(false)
  })

  it('interprets generated-text off as the Codex default instead of inventing an unsupported level', async () => {
    await generateStructuredText({
      what: 'test-generation',
      engineId: 'codex',
      prompt: 'name this',
      model: 'gpt-current',
      effort: 'off',
      systemPrompt: 'be brief',
      jsonSchema: { type: 'object' },
      ownKey: 'ok',
      read: (obj) => obj.ok === true,
      timeoutMs: 1000,
    })
    expect(spawn.calls[0].args).not.toContain('--config')
  })
})

it("Node's execFile still exposes the child through custom promisify", async () => {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  expect(typeof (real.execFile as unknown as Record<symbol, unknown>)[promisify.custom]).toBe('function')
})
