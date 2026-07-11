/**
 * File-extension → Monaco language id, plus the editor mono font. Kept free of any `monaco-editor`
 * import so both the file editor and the diff editor can share it without pulling Monaco into the
 * conversation-only bundle (the heavy chunk loads only via the lazy editor components).
 */

// Anything unmapped opens as plaintext (still rendered, just no syntax highlighting).
const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
}

export function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANGUAGE[ext] ?? 'plaintext'
}

export const MONO_FONT = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
