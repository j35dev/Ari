export const TRIAGE_EVENT = 'ari:triage'
export function requestTriage(description = ''): void {
  window.dispatchEvent(
    new CustomEvent(TRIAGE_EVENT, { detail: { description: description.slice(0, 16_000) } }),
  )
}
