import { describe, expect, it } from 'vitest'
import { providerModelCatalogs } from '@shared/model-catalog'
import { modelChoicesFor, prettyModel, providerAvailability } from './models'

describe('shared model picker catalog', () => {
  it('builds Claude aliases, useful recents, and the resolved default once for both surfaces', () => {
    const choices = modelChoicesFor('claude', {
      engineId: 'claude',
      activeModel: 'claude-opus-4-8',
      recentModels: ['sonnet', 'claude-legacy-3-7', 'gpt-typed'],
      providerCatalogs: providerModelCatalogs(),
    })

    expect(choices[0]).toMatchObject({ id: 'fable', badge: 'Recommended' })
    expect(choices).toContainEqual({
      id: 'claude-legacy-3-7',
      label: 'Legacy 3.7',
      description: 'claude-legacy-3-7',
    })
    expect(choices).not.toContainEqual(expect.objectContaining({ id: 'sonnet', description: 'sonnet' }))
    // One recents list serves both providers; an OpenAI-shaped id belongs to the Codex picker.
    expect(choices).not.toContainEqual(expect.objectContaining({ id: 'gpt-typed' }))
    expect(choices.at(-1)).toEqual({
      id: undefined,
      label: 'Engine default',
      description: 'Currently Opus 4.8',
      badge: 'Auto',
    })
  })

  it('renders a provider-reported Codex catalog without a surface-specific model map', () => {
    const catalogs = providerModelCatalogs({
      codexModels: [{ id: 'gpt-current', label: 'GPT Current', isDefault: true }],
      codexAuthStatus: {
        signedIn: true,
        authMethod: 'chatgpt',
        requiresOpenaiAuth: false,
      },
    })
    expect(
      modelChoicesFor('codex', {
        engineId: 'claude',
        model: 'opus',
        recentModels: [],
        providerCatalogs: catalogs,
      }),
    ).toEqual([
      { id: 'gpt-current', label: 'GPT Current', badge: 'Recommended' },
      {
        id: undefined,
        label: 'Engine default',
        description: 'Let Codex choose',
        badge: 'Auto',
      },
    ])
    expect(providerAvailability('codex', catalogs)).toBe('ready')
    expect(
      providerAvailability('codex', providerModelCatalogs({ codexProbeFailed: true })),
    ).toBe('probe-failed')
  })

  it('offers a typed Codex id the user has run before, unless the catalog already lists it', () => {
    const catalogs = providerModelCatalogs({
      codexModels: [{ id: 'gpt-current', label: 'GPT Current', isDefault: true }],
      codexAuthStatus: { signedIn: true, authMethod: 'chatgpt', requiresOpenaiAuth: false },
    })
    const choices = modelChoicesFor('codex', {
      engineId: 'codex',
      recentModels: ['gpt-current', 'gpt-6-next', 'claude-legacy-3-7'],
      providerCatalogs: catalogs,
    })
    expect(choices.map((choice) => choice.id)).toEqual(['gpt-current', 'gpt-6-next', undefined])
    expect(choices[1]).toEqual({ id: 'gpt-6-next', label: 'GPT-6 Next', description: 'gpt-6-next' })
  })

  it('labels ids generically, keeping the tier word that tells OpenAI models apart', () => {
    expect(prettyModel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(prettyModel('claude-opus-5[1m]')).toBe('Opus 5')
    expect(prettyModel('gpt-5.5')).toBe('GPT-5.5')
    expect(prettyModel('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(prettyModel('gpt-6-astra')).toBe('GPT-6 Astra')
    expect(prettyModel('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
    expect(prettyModel('fable')).toBe('Fable')
    expect(prettyModel('something-odd')).toBe('something-odd')
  })
})
