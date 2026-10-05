export interface TerminalState {
  terminalId: string | null
  creationKey: string | null
  closed: boolean
}

/** Restore a device-owned shell reference without persisting terminal input or credentials. */
export function readTerminalState(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
): TerminalState {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(key(origin, deviceId, sessionId)) ?? 'null',
    )
    if (
      typeof value === 'object' &&
      value !== null &&
      'terminalId' in value &&
      'creationKey' in value &&
      'closed' in value &&
      validId(value.terminalId) &&
      validId(value.creationKey) &&
      typeof value.closed === 'boolean'
    )
      return { terminalId: value.terminalId, creationKey: value.creationKey, closed: value.closed }
  } catch (error) {
    console.warn('Could not restore the mobile terminal reference', error)
  }
  return { terminalId: null, creationKey: null, closed: false }
}

/** Keep shell identity across navigation; closed shells stay closed until explicitly reopened. */
export function writeTerminalState(
  origin: string | null,
  deviceId: string | null,
  sessionId: string,
  state: TerminalState,
): void {
  try {
    sessionStorage.setItem(key(origin, deviceId, sessionId), JSON.stringify(state))
  } catch (error) {
    console.warn('Could not save the mobile terminal reference', error)
  }
}
function validId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200)
}
function key(origin: string | null, deviceId: string | null, sessionId: string): string {
  return `ari.terminal:${origin ?? ''}:${deviceId ?? ''}:${sessionId}`
}
