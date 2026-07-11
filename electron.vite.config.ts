import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
    // Pre-bundle the heavy deps that only the lazy surfaces (Monaco editors, the Crepe doc editor)
    // pull in. Without this Vite discovers them the FIRST time a lazy chunk loads, then re-optimizes
    // and invalidates the module graph mid-session — which makes the in-flight dynamic import 404
    // ("Failed to fetch dynamically imported module") until a full page reload. Listing them here
    // pre-bundles at server start so discover-and-reoptimize never happens while you're working.
    optimizeDeps: {
      include: ['monaco-editor', '@monaco-editor/react', '@milkdown/crepe', '@milkdown/kit'],
    },
    // Monaco's workers are imported via Vite's `?worker` suffix. ES-format keeps each one a real,
    // same-origin chunk (no inlined blob: worker) — required by the renderer's strict CSP, which has
    // no worker-src and so falls workers back to `script-src 'self'`.
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
