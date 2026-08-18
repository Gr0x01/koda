/**
 * One engine-neutral contract for small schema-constrained background generations.
 *
 * Every provider runs with its normal engine-owned auth/billing environment, a neutral cwd, no
 * durable conversation, a bounded lifetime, and no project mutation. Native containment stays in
 * the adapters below: Claude removes tools and MCP entirely; Codex uses its ephemeral read-only exec
 * mode and exchanges the prompt/schema/result through a private temporary job directory.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { engineCapabilities } from '@shared/engine-capabilities'
import type { ModelTurnUsage, TextGenerationEffort } from '@shared/ipc'
import { extractModelUsage } from './adapter'
import { resolveEnginePath } from './binary'
import { buildEngineEnv, type EngineEnvOptions } from './env'
import type { EngineId } from './profile'

const execFileP = promisify(execFile)

export interface StructuredGenerationSpec {
  engineId: EngineId
  prompt: string
  /** Omitted only for system jobs that deliberately use the provider's current default. */
  model?: string
  /** `off` is represented by `thinking: 'off'`; native effort flags receive only real levels. */
  effort?: Exclude<TextGenerationEffort, 'off'>
  systemPrompt: string
  jsonSchema: object
  timeoutMs: number
  /** Claude can truly disable thinking. Codex has no equivalent and uses its engine default. */
  thinking: 'off' | 'engine-default'
  resourcesPath?: string
  env?: EngineEnvOptions
  signal?: AbortSignal
}

interface LaunchContext {
  path: string
  env: NodeJS.ProcessEnv
  cwd: string
}

/** The only result shape callers above the provider adapters may see. `output` is the model's
 * schema-constrained payload, never a CLI envelope or JSONL event stream. Usage remains optional
 * because an engine may not report a cost or may not identify the model behind its default. */
export interface StructuredGenerationResult {
  output: string
  models?: ModelTurnUsage[]
  costUsd?: number
}

type StructuredGenerationAdapter = (
  spec: StructuredGenerationSpec,
  context: LaunchContext,
) => Promise<StructuredGenerationResult>

export function canRunStructuredGeneration(engineId: EngineId): boolean {
  return engineCapabilities(engineId).structuredGeneration
}

export async function runStructuredGeneration(
  spec: StructuredGenerationSpec,
): Promise<StructuredGenerationResult> {
  if (!canRunStructuredGeneration(spec.engineId)) {
    throw new Error(`${spec.engineId} does not provide structured generation`)
  }
  const loc = resolveEnginePath({ resourcesPath: spec.resourcesPath, binaryName: spec.engineId })
  const env = buildEngineEnv(process.env, { ...spec.env, engineId: spec.engineId })
  return STRUCTURED_GENERATION_ADAPTERS[spec.engineId](spec, {
    path: loc.path,
    env,
    // Generated-text evidence is already in the prompt. Never load a project's instructions, files,
    // plugins, or workstream lease merely because that project caused the background job.
    cwd: tmpdir(),
  })
}

const STRUCTURED_GENERATION_ADAPTERS: Record<EngineId, StructuredGenerationAdapter> = {
  claude: runClaudeStructuredGeneration,
  codex: runCodexStructuredGeneration,
}

async function runClaudeStructuredGeneration(
  spec: StructuredGenerationSpec,
  context: LaunchContext,
): Promise<StructuredGenerationResult> {
  // Set after buildEngineEnv so an ambient shell value cannot quietly re-enable thinking. Conversely,
  // an explicit UI choice owns the turn and must not inherit an old token cap.
  if (spec.thinking === 'off') context.env.MAX_THINKING_TOKENS = '0'
  else if (spec.effort) delete context.env.MAX_THINKING_TOKENS

  const run = execFileP(
    context.path,
    [
      '-p', spec.prompt,
      ...(spec.model ? ['--model', spec.model] : []),
      ...(spec.effort ? ['--effort', spec.effort] : []),
      '--safe-mode',
      '--tools', '',
      '--system-prompt', spec.systemPrompt,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(spec.jsonSchema),
      '--strict-mcp-config',
      '--no-session-persistence',
    ],
    execOptions(spec, context),
  )
  // There is no stdin input on this CLI path. Close the pipe immediately so Claude does not spend
  // several seconds waiting to learn that no more input is coming.
  run.child.stdin?.end()
  const { stdout } = await run
  return normalizeClaudeResult(stdout)
}

async function runCodexStructuredGeneration(
  spec: StructuredGenerationSpec,
  context: LaunchContext,
): Promise<StructuredGenerationResult> {
  const jobDir = await mkdtemp(join(tmpdir(), 'koda-structured-generation-'))
  const schemaPath = join(jobDir, 'schema.json')
  const resultPath = join(jobDir, 'result.json')
  try {
    await writeFile(schemaPath, JSON.stringify(spec.jsonSchema), { encoding: 'utf8', mode: 0o600 })
    const run = execFileP(
      context.path,
      [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '-s', 'read-only',
        ...(spec.model ? ['--model', spec.model] : []),
        ...(spec.effort
          ? ['--config', `model_reasoning_effort="${spec.effort}"`]
          : []),
        '--json',
        '--output-schema', schemaPath,
        '--output-last-message', resultPath,
        '-',
      ],
      execOptions(spec, context),
    )
    // Codex exec accepts the prompt on stdin. Keep Koda's instruction first and explicitly frame the
    // task evidence as quoted data; the caller's schema remains the final shape authority.
    run.child.stdin?.end(`${spec.systemPrompt}\n\n${spec.prompt}`)
    const { stdout } = await run
    return {
      output: await readFile(resultPath, 'utf8'),
      models: readCodexModels(stdout, spec.model),
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true })
  }
}

function execOptions(spec: StructuredGenerationSpec, context: LaunchContext) {
  return {
    cwd: context.cwd,
    env: context.env,
    timeout: spec.timeoutMs,
    maxBuffer: 1 << 20,
    signal: spec.signal,
  }
}

/** Claude puts both the answer and its billed facts in one `--output-format json` envelope. Unwrap
 * it here so no caller learns Claude field names. A malformed envelope still returns its raw text;
 * the caller's schema reader remains the final authority over whether the answer is usable. */
function normalizeClaudeResult(raw: string): StructuredGenerationResult {
  const envelope = parseRecord(raw)
  if (!envelope) return { output: raw }
  const nativeOutput = envelope.structured_output ?? envelope.result
  return {
    output:
      nativeOutput === undefined
        ? raw
        : typeof nativeOutput === 'string'
          ? nativeOutput
          : JSON.stringify(nativeOutput),
    models: extractModelUsage(envelope.modelUsage),
    costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined,
  }
}

/** `codex exec --json` emits JSONL and places per-turn token facts on `turn.completed`. The stream
 * does not identify the resolved model when the CLI chose its default, so keep that usage
 * unattributed rather than inventing an id. For an explicit model, map the totals into Koda's
 * existing exclusive input/cache buckets; Codex does not report an authoritative dollar cost. */
function readCodexModels(raw: string, model: string | undefined): ModelTurnUsage[] | undefined {
  if (!model) return undefined
  let usage: Record<string, unknown> | undefined
  for (const line of raw.split(/\r?\n/)) {
    const event = parseRecord(line)
    if (event?.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      usage = event.usage as Record<string, unknown>
    }
  }
  if (!usage) return undefined
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  const totalInput = number(usage.input_tokens)
  const cacheReadTokens = number(usage.cached_input_tokens)
  const cacheCreationTokens = number(usage.cache_write_input_tokens)
  const outputTokens = number(usage.output_tokens)
  const inputTokens = Math.max(0, totalInput - cacheReadTokens - cacheCreationTokens)
  if (inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens === 0) return undefined
  return [{
    model,
    costUsd: 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  }]
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw.trim()) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}
