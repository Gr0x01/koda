/**
 * Remote control seam — open-source build.
 *
 * The phone-control stack (LAN server, cloud relay, pairing, phone tunnel) is part of Koda's hosted
 * cloud service and is not in the public repo. This stub keeps the seam's API
 * so the rest of main compiles unchanged, answers the Settings → Remote channels with inert state
 * (`available: false` hides those surfaces), and wires nothing.
 */
import { ipcMain } from 'electron'
import type { SupabaseClient } from '@supabase/supabase-js'
import { IpcChannels } from '@shared/channels'
import type { EngineSessionManager } from './engine/sessions'

const NOT_IN_BUILD = 'Phone control is part of Koda\'s hosted cloud service. It is not included in this build.'

const remoteState = {
  running: false,
  url: null,
  code: null,
  devices: [],
  connectedClients: 0,
  available: false,
}
const authState = { signedIn: false, email: null, userId: null }
const relayState = { signedIn: false, running: false, paired: false }

export function initRemoteControl(_engineSessions: EngineSessionManager): void {}

export function remoteStatusWatchHooks(): {
  registerRemoteWatch: (engine: string) => Promise<boolean>
  cancelRemoteWatch: (engine: string) => Promise<void>
  phonePush: (title: string, body: string) => void
} {
  return {
    registerRemoteWatch: async () => false,
    cancelRemoteWatch: async () => {},
    phonePush: () => {},
  }
}

export function registerRemoteIpcHandlers(_broadcastSettings: () => void): void {
  ipcMain.handle(IpcChannels.remoteGetState, () => remoteState)
  ipcMain.handle(IpcChannels.remoteSetEnabled, () => {
    throw new Error(NOT_IN_BUILD)
  })
  ipcMain.handle(IpcChannels.remoteNewCode, () => remoteState)
  ipcMain.handle(IpcChannels.remoteRevoke, () => remoteState)
  ipcMain.handle(IpcChannels.remoteAuthState, () => authState)
  ipcMain.handle(IpcChannels.remoteRequestOtp, () => ({ ok: false, error: NOT_IN_BUILD }))
  ipcMain.handle(IpcChannels.remoteVerifyOtp, () => ({ ok: false, error: NOT_IN_BUILD }))
  ipcMain.handle(IpcChannels.remoteSignOut, () => authState)
  ipcMain.handle(IpcChannels.remoteRelayState, () => relayState)
  ipcMain.handle(IpcChannels.remoteCloudEnabled, () => false)
  ipcMain.handle(IpcChannels.remoteRelayPair, () => {
    throw new Error(NOT_IN_BUILD)
  })
  ipcMain.handle(IpcChannels.remoteRelayForget, () => relayState)
}

export async function disposeRemoteControl(): Promise<void> {}

/** backup/ (not itself pruned — it's not part of the phone-control stack) reaches Supabase and the
 *  auth-recovery signal through this seam, same as the real remote-control.ts. There's no cloud
 *  account in this build, so backup simply has no remote here: getSupabase() always throws (every
 *  call site already treats a failed Supabase call as "backup unavailable"), and onAuthState never
 *  fires — nothing is ever signed in to recover into. */
export function getSupabase(): SupabaseClient {
  throw new Error(NOT_IN_BUILD)
}

export function onAuthState(
  _cb: (s: 'signedOut' | 'restoring' | 'signedIn' | 'needsReSignin') => void,
): () => void {
  return () => {}
}
