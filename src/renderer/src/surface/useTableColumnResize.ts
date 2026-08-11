import { useEffect } from 'react'
import type { DocMeta } from '@shared/ipc'

/**
 * Notion-grade table column resizing for the Crepe doc surface — without forking Crepe's table NodeView
 * and without touching the markdown.
 *
 * Crepe renders tables through a Vue-managed NodeView (nice row/col drag-reorder + add/delete handles)
 * that has no `colgroup`/`colwidth`, so ProseMirror's built-in `columnResizing` can't ride on it. It also
 * RECONCILES its own DOM: any inline `width` we write onto a `<th>`/`<td>` is discarded on the next
 * re-render (and, worse, mutating the cells' inline style attributes provokes an immediate reconcile that
 * detaches them mid-drag). So we cannot size columns by writing cell styles.
 *
 * Instead we size columns from a layer Vue doesn't own — an injected `<style>`:
 *   - each table block is tagged `data-koda-tbl="<ordinal>"`, and one stylesheet holds
 *     `[data-koda-tbl="i"] table tr>*:nth-child(k){width:…}` + `table{table-layout:fixed}` rules,
 *   - a CSS rule keeps applying to the freshly-rendered cells after every Crepe re-render, so widths
 *     survive agent edits / add-row-col with no re-write,
 *   - drag handles at each interior column border (absolutely positioned over the table) edit the CSS
 *     rule live; the drag uses pointer capture so Crepe's own drag-reorder never engages and the dragged
 *     handle element is never rebuilt out from under the gesture,
 *   - widths persist to the doc's `.koda/docmeta/` sidecar, keyed by the table's ordinal in the doc.
 *
 * The file on disk stays canonical markdown; only presentation lives in the sidecar. A restructured table
 * (column count no longer matches the saved `cols`) silently falls back to auto-width — stale widths
 * never show. NOTE: this overlay rides Crepe's private DOM (the two-table drag-preview markup, the Vue
 * reconcile behaviour) — re-verify it after every `@milkdown/crepe` upgrade. See
 * [[notion-replacement-no-jank]], main/docmeta.ts.
 */
const MIN_COL_PX = 56
const HANDLE_CLASS = 'koda-col-resize'
const TBL_ATTR = 'data-koda-tbl'

export function useTableColumnResize({
  hostRef,
  path,
  ready,
  readOnly,
  fullWidth = false,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>
  path: string
  /** Crepe finished mounting — only then is there table DOM to manage. */
  ready: boolean
  readOnly: boolean
  /** The doc's layout mode — a dep only: flipping it reflows every table, so the overlay tears down
   *  and re-applies to reposition its handles against the new geometry. */
  fullWidth?: boolean
}): void {
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready) return

    // The loaded sidecar, mutated as the user resizes. `meta.tables[i]` = {cols, widths} per table ordinal.
    let meta: DocMeta = {}
    let disposed = false
    // Guards: don't let our own DOM writes re-trigger the observer, and freeze re-apply mid-drag.
    let applying = false
    let dragging = false

    // Live width model the stylesheet is generated from, keyed by table ordinal. Seeded from the sidecar
    // on load/re-render and updated in place during a drag. A missing entry = auto-width (no rule emitted).
    const widthsByTable = new Map<number, number[]>()

    // Our own stylesheet, appended OUTSIDE `.milkdown` so it never trips the content MutationObserver.
    const styleEl = document.createElement('style')
    host.appendChild(styleEl)

    const tableBlocks = (): HTMLElement[] =>
      Array.from(host.querySelectorAll<HTMLElement>('.milkdown-table-block'))

    // Crepe's table NodeView renders TWO <table>s per block: an empty `.drag-preview` ghost (shown while
    // dragging a row/col to reorder) AND the real content table. The ghost sorts FIRST in DOM order, so a
    // bare `block.querySelector('table')` grabs the empty one. Always resolve by excluding the preview.
    const contentTable = (block: HTMLElement): HTMLElement | null =>
      Array.from(block.querySelectorAll<HTMLElement>('table')).find((t) => !t.closest('.drag-preview')) ?? null

    const headerCells = (table: HTMLElement): HTMLElement[] => {
      const row = table.querySelector('tr')
      return row ? Array.from(row.children).filter((c): c is HTMLElement => c instanceof HTMLElement) : []
    }

    // Regenerate the whole stylesheet from `widthsByTable`. Cheap (a doc has few tables / few columns).
    const renderCss = (): void => {
      const rules: string[] = []
      widthsByTable.forEach((widths, i) => {
        if (!widths.length) return
        const total = widths.reduce((a, b) => a + b, 0)
        rules.push(`[${TBL_ATTR}="${i}"] table{table-layout:fixed;width:${total}px}`)
        widths.forEach((w, k) => rules.push(`[${TBL_ATTR}="${i}"] table tr>*:nth-child(${k + 1}){width:${w}px}`))
      })
      styleEl.textContent = rules.join('\n')
    }

    const removeHandles = (block: HTMLElement): void =>
      block.querySelectorAll(`.${HANDLE_CLASS}`).forEach((h) => h.remove())

    /** Ensure exactly `count-1` interior handle elements exist as children of the block (create the
     *  missing ones with their pointerdown wired, drop any extras). Never touches a handle that already
     *  exists — so a drag holding pointer capture on one is never rebuilt out from under it. */
    const ensureHandles = (block: HTMLElement, i: number, count: number): HTMLElement[] => {
      if (readOnly || count < 2) {
        removeHandles(block)
        return []
      }
      block.style.position = 'relative'
      const existing = Array.from(block.querySelectorAll<HTMLElement>(`.${HANDLE_CLASS}`))
      // Drop extras (column removed).
      for (let k = count - 1; k < existing.length; k++) existing[k].remove()
      const handles: HTMLElement[] = []
      for (let k = 0; k < count - 1; k++) {
        let handle = existing[k]
        if (!handle) {
          handle = document.createElement('div')
          handle.className = HANDLE_CLASS
          handle.style.position = 'absolute'
          handle.addEventListener('pointerdown', (e) => startDrag(e, block, i, k))
          block.appendChild(handle)
        }
        handles.push(handle)
      }
      return handles
    }

    /** Position each interior handle over its column border, reading fresh cell rects. */
    const positionHandles = (block: HTMLElement): void => {
      const table = contentTable(block)
      if (!table) return
      const cells = headerCells(table)
      const handles = Array.from(block.querySelectorAll<HTMLElement>(`.${HANDLE_CLASS}`))
      if (!handles.length) return
      const blockRect = block.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      handles.forEach((handle, k) => {
        const cell = cells[k]
        if (!cell) return
        handle.style.top = `${tableRect.top - blockRect.top}px`
        handle.style.height = `${tableRect.height}px`
        handle.style.left = `${cell.getBoundingClientRect().right - blockRect.left}px`
      })
    }

    /** (Re)tag blocks with their ordinal, seed widths from the sidecar, rebuild the stylesheet + handles.
     *  Called on load and after each Crepe re-render. Disconnects the observer around its own writes. */
    const applyAll = (): void => {
      if (dragging) return
      applying = true
      observer.disconnect()
      widthsByTable.clear()
      tableBlocks().forEach((block, i) => {
        block.setAttribute(TBL_ATTR, String(i))
        const table = contentTable(block)
        if (!table) return
        const cells = headerCells(table)
        const saved = meta.tables?.[i]
        if (saved && saved.cols === cells.length && saved.widths.length === cells.length) {
          widthsByTable.set(i, saved.widths.slice())
        }
        ensureHandles(block, i, cells.length)
      })
      renderCss()
      tableBlocks().forEach(positionHandles)
      // Observe only the editor content, not the whole host — page chrome (icon/cover popovers) lives in
      // the same scroll host and its mutations would otherwise churn re-apply on every open/close.
      observer.observe(host.querySelector('.milkdown') ?? host, { childList: true, subtree: true })
      applying = false
    }

    const persist = (i: number): void => {
      const widths = widthsByTable.get(i)
      if (!widths) return
      const tables = meta.tables ? [...meta.tables] : []
      while (tables.length <= i) tables.push({ cols: 0, widths: [] })
      tables[i] = { cols: widths.length, widths: widths.map((w) => Math.round(w)) }
      meta = { ...meta, tables }
      // Send ONLY our key — main shallow-merges, so a stale `icon`/`cover` snapshot here would clobber
      // whatever page chrome wrote since mount. `cols: 0` placeholder rows are inert. See docmeta.ts.
      void window.koda.setDocMeta({ path, meta: { tables } })
    }

    // The in-flight drag's teardown, or null when idle (used by effect cleanup so an unmount mid-drag
    // releases capture + listeners instead of leaking them).
    let activeDragCleanup: (() => void) | null = null

    const startDrag = (e: PointerEvent, block: HTMLElement, i: number, k: number): void => {
      const table = contentTable(block)
      if (!table) return
      const cells = headerCells(table)
      if (cells.length < 2) return
      e.preventDefault()
      e.stopPropagation()
      const handle = e.currentTarget as HTMLElement
      // Capture the pointer on our handle so every move/up routes here — Crepe never sees them, so its own
      // column drag-reorder (and the reconcile it triggers) never starts.
      handle.setPointerCapture(e.pointerId)
      dragging = true

      // Seed this table's widths from the live render if we don't have them yet (first resize / new cols).
      let widths = widthsByTable.get(i)
      if (!widths || widths.length !== cells.length) {
        widths = cells.map((c) => Math.round(c.getBoundingClientRect().width))
        widthsByTable.set(i, widths)
        renderCss()
      }
      const wK = widths[k]
      const wNext = widths[k + 1]
      const startX = e.clientX

      const onMove = (ev: PointerEvent): void => {
        // Keep total width constant: what one column gains the next loses, both clamped to a minimum.
        let delta = ev.clientX - startX
        delta = Math.max(-(wK - MIN_COL_PX), Math.min(wNext - MIN_COL_PX, delta))
        const next = widths!.slice()
        next[k] = wK + delta
        next[k + 1] = wNext - delta
        widthsByTable.set(i, next)
        renderCss() // CSS write only — never touches Crepe's cell nodes, so no reconcile
        positionHandles(block) // borders shifted → re-place handles (same elements; capture preserved)
      }
      const end = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        try {
          handle.releasePointerCapture(e.pointerId)
        } catch {
          /* pointer already gone */
        }
        activeDragCleanup = null
        document.body.style.cursor = ''
        dragging = false
        if (!disposed) persist(i)
      }
      activeDragCleanup = () => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', end)
        handle.removeEventListener('pointercancel', end)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = 'col-resize'
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    }

    // Re-apply after Crepe re-renders (agent edits, add/remove row or column). childList-only + debounced
    // so ordinary typing in a paragraph doesn't churn. Our own writes are masked by `applying`/disconnect
    // (and the stylesheet lives outside `.milkdown`, so CSS edits never reach the observer at all).
    let debounce: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (applying || dragging) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => !disposed && applyAll(), 120)
    })

    // Reposition handles when the pane resizes (the table can reflow if it's narrower than its columns).
    const ro = new ResizeObserver(() => {
      if (dragging || applying) return
      tableBlocks().forEach(positionHandles)
    })
    ro.observe(host)

    void window.koda.getDocMeta({ path }).then((m) => {
      if (disposed) return
      meta = m
      applyAll()
    })

    return () => {
      disposed = true
      activeDragCleanup?.() // unmount mid-drag → release capture + drop listeners now
      if (debounce) clearTimeout(debounce)
      observer.disconnect()
      ro.disconnect()
      styleEl.remove()
      tableBlocks().forEach((b) => {
        removeHandles(b)
        b.removeAttribute(TBL_ATTR)
      })
    }
  }, [hostRef, path, ready, readOnly, fullWidth])
}
