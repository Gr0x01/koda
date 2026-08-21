/**
 * Bounded replay for a pty's output. A phone cannot stay subscribed while it is backgrounded, so it
 * polls from a monotonic chunk cursor and gets either the missing suffix or one explicit reset when
 * its cursor fell behind the retained window.
 */
export interface TerminalBufferRead {
  cursor: number
  data: string
  reset: boolean
}

interface OutputChunk {
  seq: number
  data: string
}

export class TerminalOutputBuffer {
  private readonly chunks: OutputChunk[] = []
  private cursor = 0
  private chars = 0

  constructor(private readonly maxChars = 512 * 1024) {}

  append(data: string): void {
    if (!data) return
    this.cursor += 1
    const kept = data.length > this.maxChars ? data.slice(-this.maxChars) : data
    this.chunks.push({ seq: this.cursor, data: kept })
    this.chars += kept.length
    while (this.chunks.length > 1 && this.chars > this.maxChars) {
      this.chars -= this.chunks.shift()!.data.length
    }
  }

  read(after: number): TerminalBufferRead {
    const oldest = this.chunks[0]?.seq ?? this.cursor + 1
    const reset = after > this.cursor || after < oldest - 1
    const chunks = reset ? this.chunks : this.chunks.filter((chunk) => chunk.seq > after)
    return { cursor: this.cursor, data: chunks.map((chunk) => chunk.data).join(''), reset }
  }
}
