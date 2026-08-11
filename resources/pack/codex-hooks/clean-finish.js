ObjC.import('Foundation')

function stdinText() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
}

function runGit(cwd, args) {
  const task = $.NSTask.alloc.init
  const output = $.NSPipe.pipe
  const error = $.NSPipe.pipe
  task.launchPath = '/usr/bin/git'
  // JXA's older JavaScriptCore can bridge a concatenated Array to NSArray reliably; spread syntax
  // here produced a malformed NSTask argument list on macOS even though ordinary JS accepted it.
  task.arguments = ['-C', cwd].concat(args)
  task.standardOutput = output
  task.standardError = error
  task.launch
  task.waitUntilExit
  const data = output.fileHandleForReading.readDataToEndOfFile
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
  return { ok: Number(task.terminationStatus) === 0, text: String(text ?? '') }
}

function main() {
  let event
  try {
    event = JSON.parse(stdinText())
  } catch {
    return '{}'
  }

  // Codex offers one continuation pass. Let the second stop through so an explicit user instruction
  // not to commit, or a real git problem, can still end honestly instead of looping forever.
  if (event.stop_hook_active === true) return '{}'

  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath)
  const status = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (!status.ok || !status.text.trim()) return '{}'

  return JSON.stringify({
    decision: 'block',
    reason: 'This Git worktree still has loose files. Finish verification and review, then commit every task-owned change in clear logical commits. Do not commit pre-existing or unrelated changes. If none of the loose files belong to this task, or the user explicitly told you not to commit, say so and finish without changing them.',
  })
}

main()
