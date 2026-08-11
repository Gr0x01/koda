import type { GitCommitResult } from '@shared/ipc'

export type GitErrorCode = Extract<GitCommitResult, { ok: false }>['code']

export function gitErrorCopy(code: GitErrorCode, action: 'save' | 'restore'): string {
  if (code === 'no_identity') {
    return 'Git needs your name and email first. Ask Koda to set them up.'
  }

  if (action === 'restore') {
    switch (code) {
      case 'not_clean':
        return 'You have unsaved changes — save a version (or discard them) before restoring.'
      case 'nothing_to_commit':
        return 'Your files already match this version.'
      default:
        return 'Could not restore this version.'
    }
  }

  switch (code) {
    case 'nothing_to_commit':
      return 'Nothing changed to save.'
    case 'not_a_repo':
      return "This project isn't tracked by Git yet."
    case 'not_head':
      return "This isn't the latest version anymore."
    case 'not_clean':
      return 'Save or discard your other changes first.'
    default:
      return 'Could not save. See the logs for details.'
  }
}
