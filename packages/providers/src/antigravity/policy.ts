import type { CatalogModel } from '../catalogs'

/** Google documents non-Gemini ACP models only for named clients, not Ari.
 * https://antigravity.google/docs/ide/extensions/acp#models-and-thinking-level
 */
export const ANTIGRAVITY_MODEL_RESTRICTION =
  'Antigravity supports Gemini models in Ari. Google limits third-party models to specified ACP clients.'

export function isAntigravityGeminiModel(modelId: string): boolean {
  return /^gemini-/i.test(modelId)
}

export function antigravityModels(models: CatalogModel[]): CatalogModel[] {
  return models
    .filter((model) => isAntigravityGeminiModel(model.id))
    .map((model) => ({
      ...model,
      ...(model.aliases ? { aliases: model.aliases.filter(isAntigravityGeminiModel) } : {}),
    }))
}

/** Never inherit a non-Gemini CLI default, including when resuming a conversation. */
export function antigravitySessionModel(
  requested: string | null,
  current: string | null,
  offered: CatalogModel[],
): string {
  const models = antigravityModels(offered)
  if (requested !== null && requested !== 'default') {
    if (!isAntigravityGeminiModel(requested)) throw new Error(ANTIGRAVITY_MODEL_RESTRICTION)
    if (!models.some((model) => model.id === requested || model.aliases?.includes(requested)))
      throw new Error(`Antigravity does not offer Gemini model ${requested}.`)
    return requested
  }
  const defaultModel = models.find((model) => model.id === current) ?? models[0]
  if (!defaultModel) throw new Error('Antigravity offers no Gemini models for this account.')
  return defaultModel.id
}
