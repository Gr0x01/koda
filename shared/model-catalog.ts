import type {
  CodexAuthStatus,
  CodexModel,
  ProviderCatalogAvailability,
  ProviderModelCatalogs,
} from './ipc'

/** One normalization point for the providers Koda currently ships. The exhaustive return type makes a
 *  newly registered EngineId update this service before either picker can quietly omit it. */
export function providerModelCatalogs({
  codexModels = [],
  codexAuthStatus = null,
  codexProbeFailed = false,
}: {
  codexModels?: readonly CodexModel[]
  codexAuthStatus?: CodexAuthStatus | null
  codexProbeFailed?: boolean
} = {}): ProviderModelCatalogs {
  let codexAvailability: ProviderCatalogAvailability
  if (codexProbeFailed || codexAuthStatus?.probeFailed) codexAvailability = 'probe-failed'
  else if (codexAuthStatus === null) codexAvailability = 'checking'
  else if (!codexAuthStatus.signedIn) codexAvailability = 'signed-out'
  else if (codexModels.length === 0) codexAvailability = 'empty'
  else codexAvailability = 'ready'

  return {
    // Claude exposes stable aliases instead of an enumerable account catalog. Its choices are curated
    // by the shared picker model, so the transport only needs to say that provider is ready.
    claude: { availability: 'ready', models: [] },
    codex: { availability: codexAvailability, models: [...codexModels] },
  }
}

/** Compatibility adapter for a phone talking to a Mac that predates provider-keyed catalogs. */
export function legacyProviderModelCatalogs(
  codexModels: readonly CodexModel[] = [],
  codexAuthStatus?: CodexAuthStatus | null,
): ProviderModelCatalogs {
  return providerModelCatalogs({
    codexModels,
    codexAuthStatus:
      codexAuthStatus ?? {
        signedIn: false,
        authMethod: null,
        requiresOpenaiAuth: null,
      },
  })
}
