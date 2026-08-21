/**
 * The desktop document editor's single Milkdown runtime boundary.
 *
 * Vite can replace dependency pre-bundles while Koda Dev is running. If Crepe and a custom plugin
 * survive from different module generations, Milkdown's symbol-keyed timers and contexts no longer
 * identify each other and editor creation fails with `Timer "InitReady" not found`. Every runtime
 * value used by the desktop document surface comes through this module so an old graph or a new graph
 * stays internally consistent. Type-only imports may still come directly from Milkdown packages.
 */
export { Crepe } from '@milkdown/crepe'
export { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
export {
  addBlockTypeCommand,
  clearTextInCurrentBlockCommand,
  selectTextNearPosCommand,
  wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark'
export { wrappingInputRule } from '@milkdown/kit/prose/inputrules'
export { $inputRule, $nodeSchema, $remark, $view, replaceAll } from '@milkdown/kit/utils'
