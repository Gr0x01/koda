/**
 * face-kit — interaction physics for a Koda mini-app face. COPY the whole face-kit/ folder
 * VERBATIM into the face's src (e.g. web/src/face-kit/) and import from here:
 *
 *   import { AppShell, Sheet, Field, Pressable, pick, haptic, hostCaps, onHost } from './face-kit'
 *
 * Five primitives own feel (safe-area frame, sheet spring, keyboard contract, tap states, native
 * attach); the app owns every visual choice through their className props. Requires koda-face.js
 * in index.html (it feeds the inset variables) and face-kit.css imported once.
 */

export { AppShell } from './AppShell.jsx'
export { Sheet } from './Sheet.jsx'
export { Field } from './Field.jsx'
export { Pressable } from './Pressable.jsx'
export { pick, asDataUrl } from './pick.js'
export { haptic, hostCaps, onHost } from './host.js'
