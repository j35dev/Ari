import { driverKindSchema, type DriverKind, type PermissionMode } from '@ari/contracts/common'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import type { Endpoint } from '@ari/ari-core/endpoints'
import type { CatalogModel, CatalogSource } from '@ari/providers/catalogs'

interface CatalogInputs {
  detections: readonly { kind: string; installed: boolean; authStatus: string }[]
  registered(kind: DriverKind): boolean
  models(kind: DriverKind): readonly CatalogModel[]
  source(kind: DriverKind): CatalogSource
  endpoints: readonly Pick<Endpoint, 'id' | 'name' | 'model' | 'models'>[]
}

/** Projects desktop detection, merged catalogs and configured endpoint models without local paths or secrets. */
export function remoteCatalogProviders(inputs: CatalogInputs): RemoteModelCatalog['providers'] {
  return driverKindSchema.options.map((driverKind) => {
    const core = driverKind === 'ari-core'
    const detection = inputs.detections.find((row) => row.kind === driverKind)
    const installed = core || detection?.installed === true
    const authStatus = core
      ? 'authenticated'
      : detection?.authStatus === 'authenticated' || detection?.authStatus === 'unauthenticated'
        ? detection.authStatus
        : 'unknown'
    const registered = inputs.registered(driverKind)
    const available =
      installed &&
      authStatus !== 'unauthenticated' &&
      registered &&
      (!core || inputs.endpoints.length > 0)
    const reason = !installed
      ? 'Not installed on this computer.'
      : authStatus === 'unauthenticated'
        ? 'Sign in to this provider on the desktop.'
        : !registered
          ? 'The desktop is still preparing this provider. Try again shortly.'
          : core && inputs.endpoints.length === 0
            ? 'Add a model endpoint in desktop settings.'
            : null
    const first = inputs.endpoints[0]
    return {
      driverKind,
      installed,
      available,
      authStatus,
      reason,
      source: core ? 'live' : inputs.source(driverKind),
      defaultModelId: core && first !== undefined ? `ep:${first.id}:${first.model}` : null,
      models: core
        ? inputs.endpoints.flatMap((endpoint) => {
            const models =
              endpoint.models.length > 0
                ? endpoint.models
                : [{ id: endpoint.model, label: endpoint.model, contextWindow: null }]
            return models.map((model) => ({
              id: `ep:${endpoint.id}:${model.id}`,
              label: `${endpoint.name} · ${model.label}`,
              ...(model.id === endpoint.model
                ? { aliases: [`ep:${endpoint.id}`, endpoint.id] }
                : {}),
              ...(model.contextWindow === null
                ? {}
                : { contextHint: `${Math.round(model.contextWindow / 1000)}k` }),
            }))
          })
        : inputs.models(driverKind).map((model) => ({
            id: model.id,
            label: model.label,
            ...(model.aliases === undefined ? {} : { aliases: model.aliases }),
            ...(model.contextHint === undefined ? {} : { contextHint: model.contextHint }),
            ...(model.isLegacy === undefined ? {} : { isLegacy: model.isLegacy }),
          })),
    }
  })
}

/** Uses the saved desktop preference, then desktop detection order, then a configured built-in endpoint. */
export function remoteCatalogDefaults(
  providers: RemoteModelCatalog['providers'],
  configuredDriverKind: DriverKind | null,
  permissionMode: PermissionMode,
): NonNullable<RemoteModelCatalog['defaults']> {
  const available = providers.filter((provider) => provider.available !== false)
  const provider =
    available.find((row) => row.driverKind === configuredDriverKind) ??
    available.find((row) => row.driverKind !== 'ari-core') ??
    available.find((row) => row.driverKind === 'ari-core')
  return {
    driverKind: provider?.driverKind ?? null,
    modelId: provider?.defaultModelId ?? null,
    configuredDriverKind,
    permissionMode,
  }
}
