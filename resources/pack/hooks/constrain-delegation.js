// Dual-runtime hook: macOS runs it under osascript JXA (a packaged Finder-launched app cannot
// count on node being on PATH), while Linux CI runs it under node (no osascript exists there).
// hooks.json probes for osascript and falls back to node; both entrypoints share decide().
function decide(text) {
  let event
  try {
    event = JSON.parse(text)
  } catch {
    return ''
  }
  if (!event || event.tool_name !== 'Agent') return ''
  const input = event.tool_input
  if (!input || typeof input !== 'object') return ''
  const backgroundLeaves = new Set([
    'koda:scout',
    'koda:worker',
    'deep-review:detective',
    'deep-review:finding-judge',
  ])
  if (backgroundLeaves.has(input.subagent_type)) return ''
  if (input.run_in_background === false) return ''
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...input, run_in_background: false },
    },
  })
}

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  process.stdout.write(decide(require('node:fs').readFileSync(0, 'utf8')))
}

function run() {
  ObjC.import('Foundation')
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  return decide(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))
}
