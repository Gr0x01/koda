import { describe, expect, it } from 'vitest'
import { mcpElicitationResponse, parseMcpToolElicitation } from './codex-driver'

describe('Codex MCP elicitation', () => {
  it('recovers Koda Preview approval as the existing gate tool name + input', () => {
    expect(
      parseMcpToolElicitation({
        mode: 'form',
        serverName: 'koda_broker',
        message: 'Allow the koda_broker MCP server to run tool "preview"?',
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          tool_params: { command: 'npm run dev', cwd: 'site' },
        },
      }),
    ).toEqual({
      toolName: 'mcp__koda_broker__preview',
      input: { command: 'npm run dev', cwd: 'site' },
    })
  })

  it('does not treat general MCP forms or URLs as tool approvals', () => {
    expect(
      parseMcpToolElicitation({
        mode: 'form',
        serverName: 'other',
        message: 'Share an email address',
        _meta: {},
      }),
    ).toBeNull()
    expect(
      parseMcpToolElicitation({
        mode: 'url',
        serverName: 'other',
        message: 'Sign in',
        url: 'https://example.com',
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
    ).toBeNull()
  })

  it('returns Codex\'s complete response shape for either gate decision', () => {
    expect(mcpElicitationResponse(true)).toEqual({ action: 'accept', content: null, _meta: null })
    expect(mcpElicitationResponse(false)).toEqual({ action: 'decline', content: null, _meta: null })
  })
})
