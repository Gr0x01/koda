import type { KodaApi } from '@shared/ipc'

declare global {
  interface Window {
    koda: KodaApi
  }
}

export {}
