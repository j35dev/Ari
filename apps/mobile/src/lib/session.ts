import { RemoteSession, type SessionDeps as SharedSessionDeps } from '@ari/remote-client/session'
import type { DeviceKeyring } from './device-key'
import { ManagedLeaseClient } from './connect'
export { CLIENT_PROTOCOL_VERSION } from '@ari/remote-client/session'
export type { ConnectionState } from '@ari/remote-client/session'
export interface SessionDeps extends Omit<SharedSessionDeps, 'keyring' | 'lease'> {
  keyring: DeviceKeyring
  managedComputerId?: string
}
/** Browser storage and broker coordination remain mobile adapters. */
export class MobileSession extends RemoteSession {
  constructor(deps: SessionDeps) {
    super({
      ...deps,
      ...(deps.managedComputerId === undefined
        ? {}
        : { lease: new ManagedLeaseClient(deps.managedComputerId, deps.keyring) }),
    })
  }
}
