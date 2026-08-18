/**
 * Global keyboard listeners bypass DOM `inert`, so every window-level workspace shortcut consults
 * this one ownership signal before changing background state. Modal-local listeners deliberately do
 * not use it: the active dialog still owns Escape/Tab while everything behind it yields.
 */
export function windowHasOpenModal(doc: Pick<Document, 'querySelector'> = document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null
}

/**
 * Is a menu currently open anywhere in this window? Same shape as the modal check above, and used for
 * the same reason: a surface that appears on hover has to yield to one the user deliberately summoned.
 * Window-scoped on purpose — a menu opened from one session row must suppress the hover card on every
 * OTHER row too, which per-component state cannot see.
 */
export function windowHasOpenMenu(doc: Pick<Document, 'querySelector'> = document): boolean {
  return doc.querySelector('[data-open-menu]') !== null
}
