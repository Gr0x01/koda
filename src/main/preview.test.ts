import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_PREVIEW_CSP,
  documentPreviewPathsForTest,
  documentPreviewUrl,
  documentTokenForTest,
  forgetWindowDocuments,
  isDocumentFrameEscape,
  servePreviewRequest,
  staticPreviewUrl,
} from './preview'
import { previewTokenForWindow, registerWindow, unregisterWindow } from './window-registry'

/**
 * The document mode's containment (typed-documents plan §4). These run the shipped request handler,
 * because the whole claim being made is about what that function refuses.
 */
const WIN_ID = 4101
const DOC_REL = 'Documents/report.html'
const SECRET_REL = 'secrets.env'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'koda-doc-preview-')))
  mkdirSync(join(root, 'Documents'), { recursive: true })
  writeFileSync(join(root, DOC_REL), '<!doctype html><p id="body">Report</p>')
  writeFileSync(join(root, SECRET_REL), 'TOKEN=not-a-real-secret')
  registerWindow({ id: WIN_ID } as never, root)
})

afterEach(() => {
  forgetWindowDocuments(WIN_ID)
  unregisterWindow(WIN_ID)
  rmSync(root, { recursive: true, force: true })
})

const previewToken = (): string => previewTokenForWindow(WIN_ID)!
// The document origin's host is an INDEPENDENT token (never `doc-` + the app-preview token), so read it
// from the URL the server actually hands out. Registering DOC_REL is idempotent — the token mints once.
const docOrigin = (): string => {
  const parsed = new URL(documentPreviewUrl(WIN_ID, DOC_REL)!)
  return `${parsed.protocol}//${parsed.hostname}`
}

describe('document-mode policy', () => {
  it('withdraws the network and keeps the frame origin opaque', () => {
    expect(DOCUMENT_PREVIEW_CSP).toContain("default-src 'none'")
    expect(DOCUMENT_PREVIEW_CSP).toContain('sandbox allow-scripts')
    // Interaction is the format's reason to exist, so inline scripts stay.
    expect(DOCUMENT_PREVIEW_CSP).toContain("script-src 'unsafe-inline'")
    // Each of these would hand back exactly what the mode exists to withhold: a same-origin frame
    // (storage, cookies, reads), a UI-thread-holding dialog, or a way off the machine.
    expect(DOCUMENT_PREVIEW_CSP).not.toContain('allow-same-origin')
    expect(DOCUMENT_PREVIEW_CSP).not.toContain('allow-modals')
    expect(DOCUMENT_PREVIEW_CSP).not.toContain('allow-top-navigation')
    expect(DOCUMENT_PREVIEW_CSP).not.toContain('connect-src')
    expect(DOCUMENT_PREVIEW_CSP).not.toMatch(/https?:/)
  })
})

describe('document-mode admission', () => {
  it('serves the registered document with the policy stamped on the response', async () => {
    const url = documentPreviewUrl(WIN_ID, DOC_REL)
    expect(url).toBe(`${docOrigin()}/Documents/report.html`)

    const res = await servePreviewRequest(url!)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Content-Security-Policy')).toBe(DOCUMENT_PREVIEW_CSP)
    // The surface refreshes by reloading this URL, so a cached body would show the previous draft.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.text()).toContain('id="body"')
  })

  it('ignores the refresh query, which is a cache-buster and never part of the identity', async () => {
    const url = documentPreviewUrl(WIN_ID, DOC_REL)!
    const res = await servePreviewRequest(`${url}?v=3.7`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Report')
  })

  it('admits only HTML, so no other format can borrow the script-running origin', () => {
    expect(documentPreviewUrl(WIN_ID, 'Documents/notes.md')).toBeUndefined()
    expect(documentPreviewUrl(WIN_ID, 'Documents/deck.pdf')).toBeUndefined()
    expect(documentPreviewUrl(WIN_ID, '')).toBeUndefined()
    expect(documentPreviewPathsForTest(WIN_ID)).toEqual([])
    expect(documentPreviewUrl(9999, DOC_REL)).toBeUndefined() // unknown window
  })
})

describe('document-mode refusals', () => {
  it('refuses every path but the open document, including one that exists', async () => {
    documentPreviewUrl(WIN_ID, DOC_REL)
    for (const path of [`/${SECRET_REL}`, '/Documents/', '/', '/index.html']) {
      const res = await servePreviewRequest(`${docOrigin()}${path}`)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('not-a-real-secret')
    }
  })

  it('refuses a registered path that escapes the project root', async () => {
    // Registration is authorization, not containment: the read is still realpath-contained, so a
    // caller that admits a traversing path gets a refusal rather than the file above the root.
    writeFileSync(join(root, '..', 'escape-fixture.html'), '<p>outside</p>')
    const url = documentPreviewUrl(WIN_ID, '../escape-fixture.html')
    expect(url).toBeDefined()
    const res = await servePreviewRequest(`${docOrigin()}/%2E%2E%2Fescape-fixture.html`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('outside')
    rmSync(join(root, '..', 'escape-fixture.html'), { force: true })
  })

  it('stops serving once the window is gone', async () => {
    const url = documentPreviewUrl(WIN_ID, DOC_REL)!
    forgetWindowDocuments(WIN_ID)
    expect((await servePreviewRequest(url)).status).toBe(404)
  })

  it('refuses an unknown document host outright', async () => {
    const res = await servePreviewRequest('koda-preview://doc-not-a-token/Documents/report.html')
    expect(res.status).toBe(404)
  })
})

describe('app preview stays untouched', () => {
  it('keeps its own origin and never inherits the document policy', async () => {
    documentPreviewUrl(WIN_ID, DOC_REL)
    const appUrl = staticPreviewUrl(WIN_ID, DOC_REL)!
    expect(appUrl).toBe(`koda-preview://${previewToken()}/Documents/report.html`)
    // A different host is a different web origin, which is what keeps the two modes from reading each
    // other's responses or storage.
    expect(new URL(appUrl).hostname).not.toBe(new URL(docOrigin()).hostname)

    const res = await servePreviewRequest(appUrl)
    expect(res.status).toBe(200)
    // Stamping the document policy on a previewed app would break the user's own page.
    expect(res.headers.get('Content-Security-Policy')).toBeNull()

    // The app origin still serves ordinary project files; the document origin is the strict one.
    expect((await servePreviewRequest(`koda-preview://${previewToken()}/${SECRET_REL}`)).status).toBe(200)
  })
})

describe('document and app-preview token spaces cannot cross', () => {
  it('the app-preview host is not derivable from the document host, and neither addresses the other', async () => {
    const docReportUrl = documentPreviewUrl(WIN_ID, DOC_REL)!
    const docHost = new URL(docReportUrl).hostname // doc-<docToken>
    expect(docHost.startsWith('doc-')).toBe(true)
    const recovered = docHost.slice('doc-'.length) // exactly what the old exploit stripped off its host

    // The escape the fix closes: the app-preview token is NOT the document host with `doc-` removed. The
    // document token is an independent throwaway id (its own registry too), so the permissive URL can no
    // longer be constructed from anything the document can read.
    expect(recovered).toBe(documentTokenForTest(WIN_ID))
    expect(recovered).not.toBe(previewToken())
    expect(docHost).not.toContain(previewToken())

    // The app-preview token, dressed as a document host, is not a registered document token → refused.
    const forgedDocFromAppToken = `koda-preview://doc-${previewToken()}/Documents/report.html`
    expect((await servePreviewRequest(forgedDocFromAppToken)).status).toBe(404)

    // The document token, used as an app-preview host, resolves to no window — so it can never reach the
    // no-CSP app branch to re-serve the document (or any sibling) without the document policy.
    const forgedAppFromDocToken = `koda-preview://${recovered}/Documents/report.html`
    const asApp = await servePreviewRequest(forgedAppFromDocToken)
    expect(asApp.status).toBe(404)
    expect(asApp.headers.get('Content-Security-Policy')).toBeNull() // the blank app 404, never the doc
    expect(await asApp.text()).not.toContain('id="body"') // and it carried no document bytes

    // A sibling secret is equally unreachable through the forged app host.
    const forgedSecret = await servePreviewRequest(`koda-preview://${recovered}/${SECRET_REL}`)
    expect(forgedSecret.status).toBe(404)
    expect(await forgedSecret.text()).not.toContain('not-a-real-secret')
  })

  it('the frame-navigation guard denies a document frame changing host or scheme, but not its own reload', () => {
    const docReportUrl = documentPreviewUrl(WIN_ID, DOC_REL)!
    const docHost = new URL(docReportUrl).hostname
    const appHost = previewToken()

    // The exploit and its cousins: hop from the document origin to the app-preview origin, to the raw
    // recovered token, or to any external scheme.
    expect(isDocumentFrameEscape(docReportUrl, `koda-preview://${appHost}/Documents/report.html`)).toBe(true)
    expect(isDocumentFrameEscape(docReportUrl, `koda-preview://${docHost.slice('doc-'.length)}/x.html`)).toBe(true)
    expect(isDocumentFrameEscape(docReportUrl, 'https://evil.example/x')).toBe(true)

    // Legitimate in-document navigation stays allowed: reloading itself (live refresh), a same-origin
    // path, and a fragment never change the host or scheme.
    expect(isDocumentFrameEscape(docReportUrl, docReportUrl)).toBe(false)
    expect(isDocumentFrameEscape(docReportUrl, `koda-preview://${docHost}/other.html`)).toBe(false)
    expect(isDocumentFrameEscape(docReportUrl, `${docReportUrl}#section`)).toBe(false)

    // The guard only polices frames CURRENTLY on the document origin; the app-preview origin and the
    // renderer keep their own separate guards and are not touched here.
    expect(isDocumentFrameEscape(`koda-preview://${appHost}/index.html`, 'https://evil.example')).toBe(false)
    expect(isDocumentFrameEscape('file:///renderer/index.html', 'https://evil.example')).toBe(false)
  })
})
