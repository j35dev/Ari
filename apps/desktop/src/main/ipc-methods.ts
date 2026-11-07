import type { WebContents } from 'electron'
import { rpcParams, type RpcMethod } from '@ari/contracts/rpc'

/**
 * Electron registers one handler per channel. Derive those channels from the
 * validated RPC contract so a backend method cannot be omitted from a second
 * hand-maintained list. Sender checks below still gate privileged calls.
 */
export const IPC_METHODS = Object.keys(rpcParams) as readonly RpcMethod[]

/**
 * Phase-A trust boundary: only the main window's own webContents may invoke
 * privileged RPC handlers. The preload bridge (`window.ari`) is exposed to
 * every document hosted in the window, so a cross-context caller — a popup
 * that escaped the window-open guard, a stray webContents, a second window —
 * must never reach the registry. Compares by identity against the contents
 * `registerRpc` was given; a destroyed window serves nothing.
 */
export function isTrustedIpcSender(sender: WebContents, contents: WebContents): boolean {
  return sender === contents && !contents.isDestroyed()
}
