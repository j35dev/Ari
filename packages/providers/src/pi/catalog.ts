import type { CatalogModel, EffortCatalog } from '../catalogs'
import { PiRpcConnection } from './rpc-connection'
import type { PiConnectionOptions } from './rpc-connection'

interface PiModel {
  id: string
  provider: string
  name?: string
  contextWindow?: number
  reasoning?: boolean
  thinkingLevelMap?: Record<string, string | null>
}

const defaultThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high']
const extendedThinkingLevels = ['xhigh', 'max']

/** Pi documents the level map on each RPC model; a catalog read never switches models. */
function modelEfforts(model: PiModel) {
  if (!model.reasoning) return [{ id: 'off', label: 'off' }]
  const overrides = model.thinkingLevelMap
  return [
    ...defaultThinkingLevels.filter((level) => overrides?.[level] !== null),
    ...extendedThinkingLevels.filter((level) => typeof overrides?.[level] === 'string'),
  ].map((id) => ({ id, label: id }))
}

/** The installed Pi merges built-ins, extensions and ~/.pi/agent/models.json itself. No model request. */
export async function probePiCatalog(
  binary: string,
  cwd: string,
  env: Record<string, string | undefined>,
  options: PiConnectionOptions = {},
): Promise<{
  models: CatalogModel[]
  efforts: EffortCatalog
  defaultModelId: string | null
}> {
  const wire = new PiRpcConnection(
    binary,
    ['--mode', 'rpc', '--no-session', '--offline', '--no-mcp'],
    {
      cwd,
      env,
      ...options,
    },
  )
  try {
    const state = (await wire.request('get_state')) as
      { model?: PiModel; thinkingLevel?: string } | undefined
    const available = (await wire.request('get_available_models')) as
      { models?: PiModel[] } | undefined
    if (!Array.isArray(available?.models)) throw new Error('Pi returned an invalid model catalog.')
    const models: CatalogModel[] = available.models.flatMap((model) => {
      if (typeof model?.id !== 'string' || typeof model.provider !== 'string') return []
      return [
        {
          id: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.name ?? model.id}`,
          ...(model.contextWindow
            ? { contextHint: `${Math.round(model.contextWindow / 1000)}k` }
            : {}),
          efforts: modelEfforts(model),
          effortSource: 'agent',
        },
      ]
    })
    const defaultModelId = state?.model ? `${state.model.provider}/${state.model.id}` : null
    return {
      models,
      defaultModelId,
      efforts: {
        currentId: state?.thinkingLevel ?? null,
        options: models.find((model) => model.id === defaultModelId)?.efforts ?? [],
      },
    }
  } finally {
    await wire.dispose()
  }
}
