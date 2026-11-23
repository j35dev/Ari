import type { ProjectAgent } from '@ari/contracts/project'

export const TRIAGE_EVENT = 'ari:triage'
export function requestTriage(description = '', agent?: ProjectAgent): void {
  window.dispatchEvent(
    new CustomEvent(TRIAGE_EVENT, {
      detail: { description: description.slice(0, 16_000), ...(agent ? { agent } : {}) },
    }),
  )
}
