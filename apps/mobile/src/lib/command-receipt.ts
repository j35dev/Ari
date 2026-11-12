import { RemoteError } from './gateway-client'
import type { MobileSession } from './session'

/** A saved submission is evidence of a possible dispatch, never permission to dispatch again. */
export async function checkCommandReceipt(
  session: Pick<MobileSession, 'query'>,
  idempotencyKey: string,
  validResult: (result: unknown) => boolean = (result) =>
    typeof result === 'object' && result !== null,
): Promise<unknown> {
  try {
    const outcome = await session.query<unknown>('command.status', { idempotencyKey })
    if (
      typeof outcome !== 'object' ||
      outcome === null ||
      !('ok' in outcome) ||
      outcome.ok !== true ||
      !('result' in outcome) ||
      !validResult(outcome.result)
    )
      throw new Error('No authoritative command outcome.')
    return outcome
  } catch (error) {
    // Missing, expired, corrupt or hidden history cannot prove nonexecution.
    // Keep the immutable local receipt even if access or connectivity changed.
    throw new RemoteError(
      'unreachable',
      'This command may have executed, but its outcome cannot be confirmed. Inspect this computer before sending anything again.',
      error instanceof RemoteError ? error.status : 0,
      idempotencyKey,
    )
  }
}
