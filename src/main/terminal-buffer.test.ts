import { describe, expect, it } from 'vitest'
import { TerminalOutputBuffer } from './terminal-buffer'

describe('TerminalOutputBuffer', () => {
  it('returns only output newer than the phone cursor', () => {
    const output = new TerminalOutputBuffer(100)
    output.append('prompt')
    output.append('result')

    expect(output.read(1)).toEqual({ cursor: 2, data: 'result', reset: false })
    expect(output.read(2)).toEqual({ cursor: 2, data: '', reset: false })
  })

  it('explicitly resets a cursor that fell behind the bounded replay', () => {
    const output = new TerminalOutputBuffer(5)
    output.append('abc')
    output.append('de')
    output.append('fg')

    expect(output.read(0)).toEqual({ cursor: 3, data: 'defg', reset: true })
    expect(output.read(2)).toEqual({ cursor: 3, data: 'fg', reset: false })
  })

  it('resets a cursor from a shell that has since respawned', () => {
    const output = new TerminalOutputBuffer(100)
    output.append('$ ')

    expect(output.read(9)).toEqual({ cursor: 1, data: '$ ', reset: true })
  })
})
