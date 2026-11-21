import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { CatalogEffort, LiveCatalog } from '../catalogs'
import { withClaudeQuery } from './claude-driver'

const LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}
export function claudeCatalog(models: ModelInfo[]): LiveCatalog {
  const rows = models.map((model) => ({
    id: model.value,
    label: model.displayName,
    description: model.description,
    ...(model.resolvedModel && model.resolvedModel !== model.value
      ? { aliases: [model.resolvedModel] }
      : {}),
    efforts: (
      model.supportedEffortLevels ??
      (model.supportsEffort ? ['low', 'medium', 'high', 'xhigh', 'max'] : [])
    ).map((id): CatalogEffort => ({ id, label: LABELS[id] ?? id })),
    effortsSource: 'agent' as const,
  }))
  const defaultModel = models.find((model) => model.value === 'default')
  return {
    models: rows,
    efforts: {
      currentId: null,
      options: [
        ...new Map(
          rows.flatMap((model) => model.efforts).map((effort) => [effort.id, effort]),
        ).values(),
      ],
    },
    modes: {
      currentId: 'default',
      options: [
        { id: 'default', label: 'Ask', ariMode: 'ask' },
        { id: 'acceptEdits', label: 'Allow edits', ariMode: 'allow-edits' },
        { id: 'bypassPermissions', label: 'Full', ariMode: 'full' },
        { id: 'plan', label: 'Plan', ariMode: 'ask' },
      ],
    },
    defaultModelId: defaultModel?.resolvedModel ?? null,
  }
}

export function probeClaudeCatalog(
  binaryPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<LiveCatalog> {
  return withClaudeQuery(binaryPath, cwd, env, async (runtime) =>
    claudeCatalog(await runtime.supportedModels()),
  )
}
