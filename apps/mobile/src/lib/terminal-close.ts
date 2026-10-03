import { RemoteError } from './gateway-client'

/** An absent shell is already closed; an uncertain kill must preserve its reference. */
export async function closeRemoteTerminal(sendKill: () => Promise<unknown>): Promise<void> {
  try {
    await sendKill()
  } catch (error) {
    if (!(error instanceof RemoteError) || error.code !== 'not_found') throw error
  }
}
