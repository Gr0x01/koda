import type { FileMenuCommand } from '@shared/ipc'
import { windowHasOpenModal } from '../window-modal'

export interface FileMenuActions {
  newDocument: () => void
  newFolder: () => void
  importFiles: () => void
  filesImported: () => void
  exportPdf: () => void
}

/**
 * Native menu accelerators never enter the renderer's keydown chain. Route every project command
 * through the same modal ownership decision before it can create, import, open, or export anything
 * behind the Library.
 */
export function handleFileMenuCommand(
  command: FileMenuCommand,
  actions: FileMenuActions,
  modalOpen = windowHasOpenModal(),
): boolean {
  if (modalOpen) return false
  actions[command]()
  return true
}
