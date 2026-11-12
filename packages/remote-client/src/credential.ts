import type { PairingPublicKey } from '@ari/contracts/remote'
/** Only signing and device metadata are shared; key storage is platform owned. */
export interface DeviceCredential {
  readonly deviceId: string | null
  load(): Promise<void>
  publicKey(): Promise<PairingPublicKey>
  sign(nonce: string): Promise<string>
  remember(record: { deviceId: string; displayName: string; projectIds: string[] }): Promise<void>
}
export interface LeaseAdapter {
  token(force?: boolean): Promise<string>
}
