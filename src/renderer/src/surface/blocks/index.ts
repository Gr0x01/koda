/*
 * Koda's custom doc blocks for the Crepe (Milkdown) surface. Each block stays canonical markdown on
 * disk (see the per-block files). Wired in CrepeDocEditor: `crepe.editor.use(docBlockPlugins)` plus
 * `buildDocBlockMenu` as the BlockEdit `buildMenu` so they appear in the slash / `+` insert menu.
 */
import { calloutIcon, calloutInputRule, calloutRemark, calloutSchema, runInsertCallout } from './callout'
import {
  detailsSchema,
  detailsSummarySchema,
  detailsView,
  runInsertToggle,
  toggleIcon,
  toggleRemark,
} from './toggle'

/** Plugins to register on the editor (remark transformers + node schemas + views + input rules). */
export const docBlockPlugins = [
  calloutRemark,
  calloutSchema,
  calloutInputRule,
  toggleRemark,
  detailsSummarySchema,
  detailsSchema,
  detailsView,
].flat()

/** Minimal shape of the BlockEdit group builder we use (Crepe's internal builder, untyped publicly). */
interface BlockMenuGroup {
  addItem: (
    key: string,
    item: { label: string; icon: string; onRun: (ctx: import('@milkdown/kit/ctx').Ctx) => void },
  ) => BlockMenuGroup
}
interface BlockMenuGroupBuilder {
  addGroup: (key: string, label: string) => BlockMenuGroup
}

/** Append Koda's block group to the slash / `+` insert menu. */
export function buildDocBlockMenu(builder: BlockMenuGroupBuilder): void {
  builder
    .addGroup('koda', 'Blocks')
    .addItem('callout', { label: 'Callout', icon: calloutIcon, onRun: (ctx) => runInsertCallout(ctx) })
    .addItem('toggle', { label: 'Toggle', icon: toggleIcon, onRun: (ctx) => runInsertToggle(ctx) })
}
