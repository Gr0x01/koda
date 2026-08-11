/**
 * koda-face.js — the phone face's viewport runtime. COPY VERBATIM into a mini app's face (do not edit
 * it per app), place it in the served static assets, and include it ONCE, before your app bundle:
 *
 *     <script src="/koda-face.js"></script>
 *
 * Why this file exists (and why it is not hand-written per app): inside Koda the face is a nested
 * document, and iOS tells only the TOP page about the keyboard and the screen edges — a nested frame
 * never hears `visualViewport` shrink, and `env(safe-area-inset-*)` inside it is unreliable. Koda's
 * native shell holds the measured truth (Dynamic Island / home indicator / keyboard) and pushes it
 * over the postMessage bridge (`koda:viewport`). This runtime turns those pushes — and the plain
 * home-screen / browser case — into three CSS variables your layout reads. It is the mechanical twin
 * of `app-data-engine.mjs`: load-bearing glue, shipped as one file so it can't be skipped or drift.
 *
 *     --inset-top      the Dynamic Island / status-bar strip at the top
 *     --inset-bottom   the home indicator at the bottom (0 while the keyboard is up — the keys cover it)
 *     --kb             the soft keyboard's measured height (0 when down)
 *
 * Your CSS never calls env() or guesses a keyboard height directly — it reads these three:
 *
 *     .app       { padding-top: var(--inset-top); }
 *     .bottom-bar{ padding-bottom: var(--inset-bottom); }
 *     .composer  { padding-bottom: calc(var(--kb) + var(--inset-bottom)); transition: padding-bottom .25s ease; }
 *
 * With that, the same face lays out correctly on every surface: inside Koda (measured bridge), as a
 * home-screen web app, and in a plain browser tab.
 */
(function () {
  if (window.__kodaFace) return // idempotent — harmless if included twice
  window.__kodaFace = true

  var de = document.documentElement

  // The vars must exist before the first bridge message lands, seeded from the web platform's own env()
  // — correct for the home-screen / browser case, and a harmless 0 inside Koda until the push overrides.
  var seed = document.createElement('style')
  seed.textContent =
    ':root{' +
    '--inset-top:env(safe-area-inset-top,0px);' +
    '--inset-bottom:env(safe-area-inset-bottom,0px);' +
    '--kb:0px}'
  document.head.appendChild(seed)

  // Backstop `viewport-fit=cover`: the insets only mean something if the face actually renders under the
  // island and over the home indicator. index.html should already carry this — patch it if it doesn't.
  var vp = document.querySelector('meta[name=viewport]')
  if (!vp) {
    vp = document.createElement('meta')
    vp.setAttribute('name', 'viewport')
    vp.setAttribute('content', 'width=device-width, initial-scale=1')
    document.head.appendChild(vp)
  }
  var content = vp.getAttribute('content') || ''
  if (!/viewport-fit\s*=\s*cover/.test(content)) {
    vp.setAttribute('content', content + (content ? ', ' : '') + 'viewport-fit=cover')
  }

  var setPx = function (name, px) {
    de.style.setProperty(name, (px || 0) + 'px')
  }

  // Inside Koda: the shell posts measured geometry with the koda:host reply and on every keyboard change
  // (willShow fires PRE-animation, so the padding tracks the keys like a native view). safeBottom arrives
  // as 0 while the keyboard is up — the keys already cover the home indicator — so the composer calc()
  // pads by exactly the keyboard and never double-counts.
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.type !== 'koda:viewport') return
    setPx('--kb', e.data.keyboard)
    setPx('--inset-top', e.data.safeTop)
    setPx('--inset-bottom', e.data.safeBottom)
  })

  // Top-level (home-screen web app / plain browser tab): there is no parent shell, so the page hears the
  // keyboard itself via visualViewport. env() already covers the safe-area insets here; we only track the
  // keyboard, and zero --inset-bottom while it is up so the calc() matches the bridge's behavior above.
  if (window.parent === window && window.visualViewport) {
    var vv = window.visualViewport
    var onVV = function () {
      var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      setPx('--kb', kb)
      de.style.setProperty('--inset-bottom', kb > 0 ? '0px' : 'env(safe-area-inset-bottom,0px)')
    }
    vv.addEventListener('resize', onVV)
    vv.addEventListener('scroll', onVV)
    onVV()
  }
})()
