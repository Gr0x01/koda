import { useEffect } from 'react'
import type { DocMeta } from '@shared/ipc'

/**
 * Notion-grade table column resizing for the Crepe doc surface — without forking Crepe's `table-block`
 * NodeView and without touching the markdown.
 *
 * Crepe renders tables through its own NodeView (nice row/col drag-reorder + add/delete handles) that
 * has no `colgroup`/`colwidth`, so ProseMirror's built-in `columnResizing` can't ride on it. Instead we
 * overlay a thin imperative layer:
 *   - drag handles at each interior column border (absolutely positioned over the table),
 *   - widths applied as inline `width` on the header row's cells + `table-layout: fixed` — written by US,
 *     OUTSIDE ProseMirror's transaction model, so PM never serializes them into the markdown,
 *   - a MutationObserver re-applies the saved widths after any PM re-render (agent edit, add row/col),
 *   - widths persist to the doc's `.koda/docmeta/` sidecar, keyed by the table's ordinal in the doc.
 *
 * The file on disk stays canonical markdown; only presentation lives in the sidecar. A restructured
 * table (column count no longer matches the saved `cols`) silently falls back to auto-width — stale
 * widths never show. See [[notion-replacement-no-jank]], main/docmeta.ts.
 */
const MIN_COL_PX = 56
const HANDLE_CLASS = 'koda-col-resize'

export function useTableColumnResize({
  hostRef,
  path,
  ready,
  readOnly,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>
  path: string
  /** Crepe finished mounting — only then is there table DOM to manage. */
  ready: boolean
  readOnly: boolean
}): void {
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready) return

    // The loaded sidecar (mutated in place as the user resizes). Indexed by table ordinal in the doc.
    let meta: DocMeta = {}
    let disposed = false
    // Guards: don't let our own DOM writes re-trigger the observer, and freeze re-apply mid-drag.
    let applying = false
    let dragging = false

    const tableBlocks = (): HTMLElement[] =>
      Array.from(host.querySelectorAll<HTMLElement>('.milkdown-table-block'))

    const headerCells = (table: HTMLElement): HTMLElement[] => {
      const row = table.querySelector('tr')
      return row ? Array.from(row.children).filter((c): c is HTMLElement => c instanceof HTMLElement) : []
    }

    /** Switch a table to explicit, fixed-layout widths captured from its current render (idempotent). The
     *  precondition for resizing: once fixed, each column has a concrete px width to nudge. */
    const ensureExplicitWidths = (table: HTMLElement, cells: HTMLElement[]): number[] => {
      const widths = cells.map((c) => Math.round(c.getBoundingClientRect().width))
      table.style.tableLayout = 'fixed'
      table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`
      cells.forEach((c, k) => (c.style.width = `${widths[k]}px`))
      return widths
    }

    const removeHandles = (block: HTMLElement): void =>
      block.querySelectorAll(`.${HANDLE_CLASS}`).forEach((h) => h.remove())

    /** Position the interior border handles over a table (one between each adjacent column pair). */
    const layoutHandles = (block: HTMLElement, table: HTMLElement, cells: HTMLElement[]): void => {
      removeHandles(block)
      if (readOnly || cells.length < 2) return
      block.style.position = 'relative'
      const blockRect = block.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      for (let k = 0; k < cells.length - 1; k++) {
        const edge = cells[k].getBoundingClientRect().right
        const handle = document.createElement('div')
        handle.className = HANDLE_CLASS
        handle.style.position = 'absolute'
        handle.style.top = `${tableRect.top - blockRect.top}px`
        handle.style.height = `${tableRect.height}px`
        handle.style.left = `${edge - blockRect.left}px`
        handle.addEventListener('pointerdown', (e) => startDrag(e, block, table, cells, k))
        block.appendChild(handle)
      }
    }

    /** Re-apply saved widths to every table + rebuild handles. Disconnects the observer around its own
     *  writes so it never sees them. Called on load and after each PM re-render. */
    const applyAll = (): void => {
      if (dragging) return
      applying = true
      observer.disconnect()
      tableBlocks().forEach((block, i) => {
        const table = block.querySelector('table')
        if (!table) return
        const cells = headerCells(table)
        const saved = meta.tables?.[i]
        if (saved && saved.cols === cells.length && saved.widths.length === cells.length) {
          table.style.tableLayout = 'fixed'
          table.style.width = `${saved.widths.reduce((a, b) => a + b, 0)}px`
          cells.forEach((c, k) => (c.style.width = `${saved.widths[k]}px`))
        }
        layoutHandles(block, table, cells)
      })
      // Observe only the editor content, not the whole host — page chrome (icon/cover popovers) lives
      // in the same scroll host and its mutations would otherwise churn re-apply on every open/close.
      observer.observe(host.querySelector('.milkdown') ?? host, { childList: true, subtree: true })
      applying = false
    }

    const persist = (tableIndex: number, cells: HTMLElement[]): void => {
      const widths = cells.map((c) => Math.round(parseFloat(c.style.width) || c.getBoundingClientRect().width))
      const tables = meta.tables ? [...meta.tables] : []
      while (tables.length <= tableIndex) tables.push({ cols: 0, widths: [] })
      tables[tableIndex] = { cols: cells.length, widths }
      meta = { ...meta, tables }
      // Send ONLY our key — main shallow-merges, so including a stale `icon`/`cover` snapshot here would
      // clobber whatever page chrome wrote since mount. The `cols: 0` placeholder rows are inert (the
      // apply guard `saved.cols === cells.length` never matches a real table). See docmeta.ts.
      void window.koda.setDocMeta({ path, meta: { tables } })
    }

    // The in-flight drag's listener teardown, or null when not dragging (used by effect cleanup so an
    // unmount mid-drag removes the window listeners instead of leaking them until the next pointerup).
    let activeDragCleanup: (() => void) | null = null

    const startDrag = (
      e: PointerEvent,
      block: HTMLElement,
      table: HTMLElement,
      cells: HTMLElement[],
      k: number,
    ): void => {
      e.preventDefault()
      e.stopPropagation()
      dragging = true
      // Lock in concrete widths to nudge: on the first resize (auto layout), OR if a re-render left the
      // table `fixed` but a freshly-added cell has no inline width (parseFloat → NaN would poison the drag).
      let wK = parseFloat(cells[k].style.width)
      let wNext = parseFloat(cells[k + 1].style.width)
      if (table.style.tableLayout !== 'fixed' || Number.isNaN(wK) || Number.isNaN(wNext)) {
        const w = ensureExplicitWidths(table, cells)
        wK = w[k]
        wNext = w[k + 1]
      }
      const startX = e.clientX
      const tableIndex = tableBlocks().indexOf(block)

      const onMove = (ev: PointerEvent): void => {
        // Keep total width constant: what one column gains the next loses, both clamped to a minimum.
        let delta = ev.clientX - startX
        delta = Math.max(-(wK - MIN_COL_PX), Math.min(wNext - MIN_COL_PX, delta))
        cells[k].style.width = `${wK + delta}px`
        cells[k + 1].style.width = `${wNext - delta}px`
        layoutHandles(block, table, cells) // borders shifted → re-place handles live
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        activeDragCleanup = null
        document.body.style.cursor = ''
        dragging = false
        if (!disposed && tableIndex >= 0) persist(tableIndex, cells)
      }
      // Expose teardown so an unmount mid-drag removes the window listeners (else they outlive the effect).
      activeDragCleanup = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    // Re-apply after PM re-renders (agent edits, add/remove row or column). childList-only + debounced so
    // ordinary typing in a paragraph doesn't churn. Our own writes are masked by `applying`/disconnect.
    let debounce: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (applying || dragging) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => !disposed && applyAll(), 120)
    })

    // Reposition handles when the pane resizes (widths are px; the table doesn't reflow, but its offset
    // within the block can shift). Cheap — just re-place, no width re-apply.
    const ro = new ResizeObserver(() => {
      if (dragging || applying) return
      tableBlocks().forEach((block) => {
        const table = block.querySelector('table')
        if (table) layoutHandles(block, table, headerCells(table))
      })
    })
    ro.observe(host)

    void window.koda.getDocMeta({ path }).then((m) => {
      if (disposed) return
      meta = m
      applyAll()
    })

    return () => {
      disposed = true
      activeDragCleanup?.() // unmount mid-drag → drop the window listeners now (don't wait for pointerup)
      if (debounce) clearTimeout(debounce)
      observer.disconnect()
      ro.disconnect()
      tableBlocks().forEach(removeHandles)
    }
  }, [hostRef, path, ready, readOnly])
}
