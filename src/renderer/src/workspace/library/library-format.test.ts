import { describe, expect, it } from 'vitest'
import { ASK_ENGINE_REFUSAL, askRefusedEngine } from '@shared/ipc'
import {
  askRefusalCopy,
  countLabel,
  docTitle,
  docTopic,
  excerptLine,
  fileContext,
  kindFilterLabel,
  kindLabel,
  librarySubtitle,
  libraryResultActionable,
  timeBucket,
  whenLabel,
} from './library-format'

describe('stale Library result actions', () => {
  it('gates keyboard, pointer, preview-open, and keep actions behind the settled current query', () => {
    expect(libraryResultActionable(true, 'phone', 'pricing')).toBe(false)
    expect(libraryResultActionable(false, 'phone', 'pricing')).toBe(false)
    expect(libraryResultActionable(true, 'pricing', 'pricing')).toBe(false)
    expect(libraryResultActionable(false, '  pricing  ', 'pricing')).toBe(true)
  })
})

// A fixed clock at a mid-afternoon so the hour arithmetic below never crosses midnight by accident.
const NOW = new Date('2026-08-13T15:00:00').getTime()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('docTitle', () => {
  it('prefers the authored title', () => {
    expect(docTitle({ title: 'The document workspace', name: 'document-workspace.md' })).toBe(
      'The document workspace',
    )
  })

  it('falls back to a readable filename, never a path or an extension', () => {
    expect(docTitle({ name: 'branch-management_notes.md' })).toBe('branch management notes')
  })

  it('ignores a blank authored title', () => {
    expect(docTitle({ title: '   ', name: 'notes.md' })).toBe('notes')
  })
})

describe('docTopic', () => {
  it('names the innermost topic folder', () => {
    expect(docTopic('Documents/architecture/document-workspace.md')).toBe('Architecture')
    expect(docTopic('Documents/goals/Debt designs/usage-gauge.md')).toBe('Debt designs')
  })

  it('humanizes a slug folder', () => {
    expect(docTopic('Documents/release-notes/v2.md')).toBe('Release notes')
  })

  it('has no topic for the home folder or the project root', () => {
    expect(docTopic('Documents/brief.md')).toBe('')
    expect(docTopic('README.md')).toBe('')
  })
})

describe('whenLabel', () => {
  it('counts minutes, then hours', () => {
    expect(whenLabel(NOW - 30_000, NOW)).toBe('Just now')
    expect(whenLabel(NOW - 12 * MIN, NOW)).toBe('12 min ago')
    expect(whenLabel(NOW - HOUR, NOW)).toBe('1 hour ago')
    expect(whenLabel(NOW - 5 * HOUR, NOW)).toBe('5 hours ago')
  })

  it('rounds down so nothing reads as 60 min ago', () => {
    expect(whenLabel(NOW - (HOUR - 1_000), NOW)).toBe('59 min ago')
  })

  it('switches to calendar language once a day boundary is crossed', () => {
    // 20 hours back from 3pm lands on the previous evening: a day apart, not "20 hours".
    expect(whenLabel(NOW - 20 * HOUR, NOW)).toBe('Yesterday')
    expect(whenLabel(NOW - 3 * DAY, NOW)).toBe('Monday')
  })

  it('falls back to a date past a week', () => {
    expect(whenLabel(NOW - 10 * DAY, NOW)).toBe('Aug 3')
    expect(whenLabel(new Date('2025-11-02T09:00:00').getTime(), NOW)).toBe('Nov 2, 2025')
  })

  it('never renders a future stamp as negative time', () => {
    expect(whenLabel(NOW + 5 * MIN, NOW)).toBe('Just now')
  })
})

describe('timeBucket', () => {
  it('groups by calendar distance', () => {
    expect(timeBucket(NOW - 2 * HOUR, NOW)).toBe('Today')
    expect(timeBucket(NOW - 20 * HOUR, NOW)).toBe('Yesterday')
    expect(timeBucket(NOW - 4 * DAY, NOW)).toBe('This week')
    expect(timeBucket(NOW - 20 * DAY, NOW)).toBe('This month')
    expect(timeBucket(NOW - 200 * DAY, NOW)).toBe('Earlier')
  })
})

describe('excerptLine', () => {
  it('collapses prose to one line', () => {
    expect(excerptLine('# Heading\n\nA first   paragraph.\nAnd more.')).toBe(
      'Heading A first paragraph. And more.',
    )
  })

  it('cuts on a word boundary', () => {
    const line = excerptLine('alpha bravo charlie delta echo foxtrot', 20)
    expect(line).toBe('alpha bravo charlie…')
  })

  it('is empty when there is nothing to show', () => {
    expect(excerptLine(undefined)).toBe('')
  })
})

describe('countLabel', () => {
  it('names what was counted, and marks a capped list', () => {
    expect(countLabel(1, false, false)).toBe('1 document')
    expect(countLabel(54, false, false)).toBe('54 documents')
    expect(countLabel(1, true, false)).toBe('1 match')
    expect(countLabel(300, false, true)).toBe('300+ documents')
  })
})

describe('librarySubtitle', () => {
  it('promises files are in here too while browsing', () => {
    expect(librarySubtitle(false, 34, false, null, false)).toBe('34 documents, and every file in this project')
    expect(librarySubtitle(false, 1, false, null, false)).toBe('1 document, and every file in this project')
    expect(librarySubtitle(false, 300, true, null, false)).toBe('300+ documents, and every file in this project')
  })

  it('states the split with documents first once searching', () => {
    expect(librarySubtitle(true, 2, false, 3, false)).toBe('2 documents · 3 files')
    expect(librarySubtitle(true, 1, false, 1, false)).toBe('1 document · 1 file')
    expect(librarySubtitle(true, 2, true, 3, true)).toBe('2+ documents · 3+ files')
  })

  it('names only the documents while the file scan has no count to stand behind', () => {
    // Files still loading, a one-letter query, or a kind filter: the file half is withheld, not zeroed.
    expect(librarySubtitle(true, 2, false, null, false)).toBe('2 documents')
  })
})

describe('fileContext', () => {
  it('names the parent folders when a file is nested', () => {
    expect(fileContext('src/main/ipc.ts')).toBe('src/main')
  })

  it('reads as a sentence at the project root', () => {
    expect(fileContext('.env.local')).toBe('at the top of this project')
  })
})

describe('kind labels', () => {
  it('reads as a shelf in the filter row and as a thing on a row', () => {
    expect(kindLabel('decision')).toBe('Decision')
    expect(kindFilterLabel('decision')).toBe('Decisions')
    expect(kindFilterLabel('research')).toBe('Research')
  })
})

describe('askRefusalCopy', () => {
  it('names the engine using the brand the picker offered, never the codename', () => {
    expect(askRefusalCopy('codex')).toContain('OpenAI')
    expect(askRefusalCopy('codex')).not.toMatch(/codex/i)
    expect(askRefusalCopy('claude')).toContain('Claude')
  })

  it('says what happened, why it is permanent, and what still works', () => {
    const copy = askRefusalCopy('codex')
    // What happened. The billing half matters on its own: the ask is the one Library surface that
    // spends the user's plan, so a refusal that stays silent about it reads as a charge for nothing.
    expect(copy).toMatch(/nothing was sent and nothing was billed/)
    // Why. The isolation promise is stated rather than implied.
    expect(copy).toMatch(/isolated background mode/)
    expect(copy).toMatch(/outside your project and unable to change it/)
    // What still works, in the same words the not-wired state uses, so the way out is one sentence a
    // reader learns once.
    expect(copy).toMatch(/Search still finds anything by its title or by a phrase inside it\./)
  })

  it('never invites a retry, which is what makes it a refusal rather than a failure', () => {
    // The whole point of splitting this off `failed`: "try it again" sends a user back to an input
    // that can only refuse them again.
    expect(askRefusalCopy('codex')).not.toMatch(/try (it )?again|retry|just now/i)
  })

  it('follows the repo copy rules', () => {
    const copy = askRefusalCopy('codex')
    expect(copy).not.toMatch(/[—–]/) // em/en dashes are banned in shipped copy
    expect(copy).not.toMatch(/, not /) // the "X, not Y" construction
  })

  it('reads off the error main actually throws, so the two halves cannot drift', () => {
    // The renderer's catch is this pair: main names the engine on the rejection, this file owns the
    // sentence. Proving them together is what stops a changed marker from silently falling through to
    // the generic failure copy.
    const thrown = new Error(`${ASK_ENGINE_REFUSAL}codex cannot run structured generation, so it cannot answer here`)
    const engine = askRefusedEngine(thrown)
    expect(engine).toBe('codex')
    expect(askRefusalCopy(engine!)).toContain('OpenAI')
    // An ordinary failure is not a refusal and must keep falling through to the retryable copy.
    expect(askRefusedEngine(new Error('spawn ENOENT'))).toBeNull()
  })
})
