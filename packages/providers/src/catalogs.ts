import type { DriverKind } from '@ari/contracts/common'

/** One curated model entry for a driver's picker. */
export interface CatalogModel {
  id: string
  label: string
  /** Short context-window hint rendered beside the label, e.g. `200k`. */
  contextHint?: string
}

const CLI_DEFAULT_MODELS: CatalogModel[] = [{ id: 'default', label: 'CLI default' }]

/**
 * Static model catalogs backing the new-session provider picker, one list per
 * {@link DriverKind}. CLIs whose model flags vary by install ship a single
 * `default` entry; `ari-core` stays empty because its endpoints supply their
 * own models at session-create time.
 */
export const MODEL_CATALOGS: Record<DriverKind, CatalogModel[]> = {
  claude: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextHint: '200k' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', contextHint: '200k' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextHint: '200k' },
  ],
  codex: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', contextHint: '400k' },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', contextHint: '400k' },
  ],
  opencode: CLI_DEFAULT_MODELS,
  grok: CLI_DEFAULT_MODELS,
  pi: CLI_DEFAULT_MODELS,
  hermes: CLI_DEFAULT_MODELS,
  'ari-core': [],
}

/** Catalog entries for a driver kind; empty for kinds without static models. */
export function modelsFor(kind: DriverKind): CatalogModel[] {
  return MODEL_CATALOGS[kind]
}
