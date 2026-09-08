import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { rpcParams } from '@ari/contracts/rpc'
import { IPC_METHODS, isTrustedIpcSender } from './ipc-methods'

describe('IPC_METHODS', () => {
  it('registers an ipcMain.handle for every contracts method — a miss makes the renderer invoke reject as unknown', () => {
    const listed = new Set<string>(IPC_METHODS)
    expect(listed.size).toBe(IPC_METHODS.length)
    for (const method of Object.keys(rpcParams)) {
      expect(
        listed.has(method),
        `${method} has a registry handler but no ipcMain.handle — unreachable from the renderer`,
      ).toBe(true)
    }
  })
})

describe('isTrustedIpcSender', () => {
  const contents = (destroyed: boolean): WebContents =>
    ({ isDestroyed: () => destroyed }) as WebContents

  it('trusts the main window contents invoking itself', () => {
    const main = contents(false)
    expect(isTrustedIpcSender(main, main)).toBe(true)
  })

  it('rejects a foreign webContents (popup, second window, stray context)', () => {
    expect(isTrustedIpcSender(contents(false), contents(false))).toBe(false)
  })

  it('serves nothing once the window is destroyed', () => {
    const main = contents(true)
    expect(isTrustedIpcSender(main, main)).toBe(false)
  })
})
