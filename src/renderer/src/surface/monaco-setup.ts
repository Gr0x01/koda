import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { registerPackThemes } from './monaco-themes'

// Bundled, same-origin worker chunks. The packaged renderer runs under a strict CSP with no
// `worker-src`/`child-src`, so workers fall back to `script-src 'self'` — the default CDN loader
// (and any blob: worker) is forbidden. Vite's `?worker` suffix emits each as its own same-origin
// chunk, the only CSP-safe shape. We also point @monaco-editor/react at this local `monaco` so it
// never reaches for its CDN AMD loader (the app must work fully offline).
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker()
      case 'typescript':
      case 'javascript':
        return new TsWorker()
      default:
        return new EditorWorker()
    }
  },
}

loader.config({ monaco })

// Register the appearance-pack editor themes once, against this bundled monaco. defineTheme is
// synchronous on the namespace, so a pack theme is ready by the time any editor mounts and asks
// for it by id (the builtins ride monaco's stock vs / vs-dark).
registerPackThemes(monaco)

export { monaco }
