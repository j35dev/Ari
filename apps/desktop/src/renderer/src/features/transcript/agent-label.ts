import { driverLabel } from '../composer/agent-mark'

/**
 * How a child row names its model. A catalog id such as `qoder/GLM-5.3-Flash`
 * becomes `Pi · GLM 5.3 Flash`. A bare id keeps its spelling.
 */
export function agentModelLabel(driverKind: string, modelId: string | null): string {
  const driver = driverLabel(driverKind)
  if (modelId === null || modelId.trim().length === 0) return driver
  const slash = modelId.lastIndexOf('/')
  if (slash === -1) return `${driver} · ${modelId}`
  const pretty = modelId
    .slice(slash + 1)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (pretty.length === 0) return driver
  return pretty.toLowerCase() === driver.toLowerCase() ? pretty : `${driver} · ${pretty}`
}
