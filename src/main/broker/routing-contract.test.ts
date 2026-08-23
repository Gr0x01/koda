import { describe, expect, it } from 'vitest'
import { resolveDocFormat } from '@shared/document-contract'
import type { DocFormat } from '@shared/ipc'
import { CREATABLE_DOCUMENT_FORMATS } from '../doc-commands'
import { CREATE_DOCUMENT_GUIDANCE, CREATE_INTERACTIVE_GUIDANCE } from './server'

/**
 * The routing assay (typed-documents plan, Slice 0). Given a representative ask, the contract BOTH
 * engines read must route it to the intended artifact:
 *
 *   - durable prose (writing / revising / citing / maintaining) → a Markdown document
 *   - interactive (comparing / inspecting / navigating / tuning) → a self-contained HTML document
 *   - office handoff (a Word workflow, print, or signature)      → DOCX/PDF, which Koda cannot make yet
 *   - recurring workflow with persistent data                    → a mini app, NOT a document
 *
 * This pins the CONTRACT: the create verbs' guidance carries each of the four branches, and format
 * resolution agrees about which target each branch names. It deliberately does NOT prove that a live
 * model reads the guidance and routes a real request correctly — that would be a model eval, out of
 * scope for a deterministic lab check. What is under test is the two surfaces that ENCODE the rule
 * (`resolveDocFormat` and the create verbs' guidance in server.ts), never an engine's judgment. The
 * `ask` field on each case is a representative fixture that documents the branch, not an input to a model.
 */
interface RoutingCase {
  branch: string
  ask: string
  /** The canonical path the branch's artifact carries, or null when the branch is not a document. */
  artifactPath: string | null
  /** What `resolveDocFormat` must call that path, or null for the non-document branch. */
  format: DocFormat | null
  /** Whether Koda can author that format today. */
  creatable: boolean
  /** Phrases the create_document guidance must carry so the agent can reach this branch. */
  markers: string[]
}

const CASES: RoutingCase[] = [
  {
    branch: 'durable prose → Markdown',
    ask: 'Write up the launch retro as a memo I can revise and quote from later.',
    artifactPath: 'Documents/launch-retro.md',
    format: 'markdown',
    creatable: true,
    markers: ['Writing, revising, citing, or maintaining', 'markdown'],
  },
  {
    branch: 'interactive → HTML',
    ask: 'Build me a filterable table comparing the three shipping routes so I can tune the inputs.',
    artifactPath: 'Documents/route-comparison.html',
    format: 'html',
    creatable: true,
    markers: ['Comparing, inspecting, navigating, or interacting', 'self-contained', 'html'],
  },
  {
    branch: 'office handoff → DOCX (not yet available)',
    ask: 'Turn this brief into a Word document I can send to legal.',
    artifactPath: 'brief.docx',
    format: 'docx',
    creatable: false,
    markers: ['Word workflow', 'Koda cannot produce yet'],
  },
  {
    branch: 'recurring workflow → mini app (not a document)',
    ask: 'I want a habit tracker I open every day that remembers my streak.',
    artifactPath: null,
    format: null,
    creatable: false,
    markers: ['mini app, NOT a document'],
  },
]

describe('document routing contract', () => {
  it('the create_document guidance carries every one of the four routing branches', () => {
    for (const c of CASES) {
      for (const marker of c.markers) {
        expect(CREATE_DOCUMENT_GUIDANCE, `${c.branch} (ask: "${c.ask}") is missing marker "${marker}"`).toContain(
          marker,
        )
      }
    }
  })

  it('resolveDocFormat agrees with each branch about the artifact it names', () => {
    for (const c of CASES) {
      if (c.artifactPath === null || c.format === null) {
        // The non-document branch has no artifact extension to resolve: it is routed away from
        // create_document entirely, which its guidance marker (asserted above) is what pins.
        expect(c.creatable, `${c.branch} must not be a creatable document`).toBe(false)
        continue
      }
      expect(resolveDocFormat(c.artifactPath), `${c.branch}: resolveDocFormat`).toBe(c.format)
      expect(CREATABLE_DOCUMENT_FORMATS.has(c.format), `${c.branch}: creatable`).toBe(c.creatable)
    }
  })

  it('the two creatable branches are exactly the formats Koda can author', () => {
    // Guards the contract against drift: if a future format becomes creatable, this assay must be
    // updated deliberately rather than passing by accident.
    expect([...CREATABLE_DOCUMENT_FORMATS].sort()).toEqual(['html', 'markdown'])
  })

  it('create_interactive restates the same routing rule and its write-one-file boundary', () => {
    // The selection → view move carries the interactive, mini-app, and office-handoff branches too, so
    // a passage is never forced into the wrong artifact from the selection route either.
    expect(CREATE_INTERACTIVE_GUIDANCE).toContain('comparing, inspecting, navigating, or tuning')
    expect(CREATE_INTERACTIVE_GUIDANCE).toContain('mini app, not a document')
    expect(CREATE_INTERACTIVE_GUIDANCE).toContain('not available yet')
    expect(CREATE_INTERACTIVE_GUIDANCE).toContain('does not touch the source document')
  })
})
