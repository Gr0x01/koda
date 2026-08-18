ObjC.import('Foundation')

function stdinText() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
}

function run() {
  let event
  try {
    event = JSON.parse(stdinText())
  } catch {
    return ''
  }
  const input = event && event.tool_input
  if (event.tool_name !== 'Agent' || !input || typeof input !== 'object') return ''
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
