import { describe, it, expect } from 'vitest'
import {
  DurableAttachmentPayloadSchema,
  MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
  SendTurnRequestSchema,
  StageReceiptSchema,
  ResolveStageLinkRequestSchema,
  TurnFailureTargetSchema,
  undoPointRefusal,
} from './ipc'

describe('Stage presentation contracts', () => {
  it('accepts portable receipts and rejects absolute or traversing paths', () => {
    const base = {
      kind: 'present-file' as const,
      id: 'receipt-1',
      sessionId: 'session-1',
      view: 'file' as const,
    }
    expect(StageReceiptSchema.safeParse({ ...base, path: 'src/app.ts', line: 12, column: 3 }).success).toBe(true)
    expect(StageReceiptSchema.safeParse({ ...base, path: '/tmp/app.ts' }).success).toBe(false)
    expect(StageReceiptSchema.safeParse({ ...base, path: '../app.ts' }).success).toBe(false)
    expect(StageReceiptSchema.safeParse({ ...base, path: 'src/app.ts', column: 3 }).success).toBe(false)
  })

  it('bounds local href input at the IPC boundary', () => {
    expect(ResolveStageLinkRequestSchema.safeParse({ sessionId: 's1', href: 'src/app.ts#L4' }).success).toBe(true)
    expect(ResolveStageLinkRequestSchema.safeParse({ sessionId: 's1', href: 'x'.repeat(8193) }).success).toBe(false)
  })

  it('makes the portable safety baseline part of every explicit diff receipt', () => {
    const diff = {
      kind: 'present-file' as const,
      id: 'receipt-diff',
      sessionId: 'session-1',
      path: 'src/app.ts',
      view: 'diff' as const,
    }
    expect(StageReceiptSchema.safeParse(diff).success).toBe(false)
    expect(StageReceiptSchema.safeParse({ ...diff, checkpointId: 'abcdef1' }).success).toBe(true)
    expect(
      StageReceiptSchema.safeParse({ ...diff, view: 'file', checkpointId: 'abcdef1' }).success,
    ).toBe(false)
  })
})

/**
 * The renderer's half of the "your undo net failed" contract (debt item 17). Main refuses a destroying
 * edit it couldn't first make undoable and rejects with a sentence written for the user — but Electron
 * wraps a rejection's message inside its own text and drops the error type across the boundary, so the
 * renderer has to recover that sentence from a string. Every surface that shows the refusal (the Files
 * browser, the Find overlay's replace, Settings → Guardrails) goes through this one function.
 */
describe('undoPointRefusal', () => {
  it('recovers the user-facing sentence from a real Electron-wrapped rejection', () => {
    const wrapped = new Error(
      "Error invoking remote method 'fs:deletePath': Error: Couldn't make an undo point, so nothing was deleted.",
    )
    expect(undoPointRefusal(wrapped)).toBe("Couldn't make an undo point, so nothing was deleted.")
  })

  it('keeps each action’s own tail, so the message says what did not happen', () => {
    const replace = "Error: Couldn't make an undo point, so nothing was replaced."
    expect(undoPointRefusal(replace)).toBe("Couldn't make an undo point, so nothing was replaced.")
  })

  it('returns null for an unrelated failure, so ordinary errors keep their own copy', () => {
    expect(undoPointRefusal(new Error('a file or folder with that name already exists'))).toBeNull()
    expect(undoPointRefusal(undefined)).toBeNull()
  })
})

describe('TurnFailureTargetSchema attachment invariants', () => {
  it('accepts a bounded exact document retry only with coherent provenance', () => {
    expect(
      TurnFailureTargetSchema.safeParse({
        clientTurnId: 'logical-a',
        text: 'inspect',
        hadImages: false,
        hadAttachments: true,
        attachments: [{ mediaType: 'application/pdf', name: 'report.pdf' }],
        images: [{ mediaType: 'application/pdf', name: 'report.pdf', dataBase64: 'AAAA' }],
      }).success,
    ).toBe(true)
  })

  it('rejects exact document bytes or provenance that deny attachment presence', () => {
    const base = {
      clientTurnId: 'logical-a',
      text: 'inspect',
      hadImages: false,
      attachments: [{ mediaType: 'text/csv', name: 'rows.csv' }],
      images: [{ mediaType: 'text/csv', name: 'rows.csv', dataBase64: 'AAAA' }],
    }
    expect(TurnFailureTargetSchema.safeParse(base).success).toBe(false)
    expect(
      TurnFailureTargetSchema.safeParse({ ...base, hadAttachments: false }).success,
    ).toBe(false)
  })

  it('still requires a stable logical, replay, or rendered user identity', () => {
    expect(
      TurnFailureTargetSchema.safeParse({
        text: 'orphaned',
        hadImages: false,
        hadAttachments: false,
      }).success,
    ).toBe(false)
  })
})

describe('durable attachment payload cap', () => {
  it('accepts the exact aggregate boundary and rejects one character above it', () => {
    const boundary = [
      { mediaType: 'application/pdf', dataBase64: 'A'.repeat(1_000_000) },
      { mediaType: 'text/csv', dataBase64: 'B'.repeat(1_000_000) },
    ]
    expect(DurableAttachmentPayloadSchema.safeParse(boundary).success).toBe(true)
    expect(
      DurableAttachmentPayloadSchema.safeParse([
        ...boundary,
        { mediaType: 'text/plain', dataBase64: 'C' },
      ]).success,
    ).toBe(false)
    expect(boundary.reduce((sum, item) => sum + item.dataBase64.length, 0)).toBe(
      MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS,
    )
  })

  it('does not impose the durable cap on the generic send transport schema', () => {
    expect(
      SendTurnRequestSchema.safeParse({
        sessionId: 's1',
        text: '',
        images: [
          {
            mediaType: 'image/png',
            dataBase64: 'A'.repeat(MAX_DURABLE_TURN_ATTACHMENT_BASE64_CHARS + 1),
          },
        ],
      }).success,
    ).toBe(true)
  })
})
