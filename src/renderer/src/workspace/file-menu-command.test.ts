import { describe, expect, it, vi } from 'vitest'
import type { FileMenuCommand } from '@shared/ipc'
import { handleFileMenuCommand, type FileMenuActions } from './file-menu-command'

function actions(): FileMenuActions {
  return {
    newDocument: vi.fn(),
    newFolder: vi.fn(),
    importFiles: vi.fn(),
    filesImported: vi.fn(),
    exportPdf: vi.fn(),
  }
}

describe('native File-menu modal ownership', () => {
  it('declines every project command while a modal owns the window', () => {
    const a = actions()
    const commands: FileMenuCommand[] = [
      'newDocument',
      'newFolder',
      'importFiles',
      'filesImported',
      'exportPdf',
    ]

    for (const command of commands) expect(handleFileMenuCommand(command, a, true)).toBe(false)
    for (const action of Object.values(a)) expect(action).not.toHaveBeenCalled()
  })

  it('dispatches exactly the accepted command when no modal is open', () => {
    const a = actions()
    expect(handleFileMenuCommand('newDocument', a, false)).toBe(true)
    expect(a.newDocument).toHaveBeenCalledOnce()
    expect(a.newFolder).not.toHaveBeenCalled()
  })
})
