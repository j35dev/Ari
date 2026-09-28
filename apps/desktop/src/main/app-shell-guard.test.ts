import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))

vi.mock('electron', () => ({
  shell: { openExternal },
}))

import { attachAppShellNavigationGuard } from './app-shell-guard'

function fakeContents(): {
  contents: WebContents
  fire: (event: string, url: string) => boolean
} {
  const listeners = new Map<string, Array<(event: { preventDefault(): void }, url: string) => void>>()
  const contents = {
    setWindowOpenHandler: vi.fn(),
    on: (event: string, listener: (event: { preventDefault(): void }, url: string) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return contents
    },
  } as unknown as WebContents
  return {
    contents,
    fire: (event, url) => {
      let prevented = false
      const navEvent = { preventDefault: () => { prevented = true } }
      for (const listener of listeners.get(event) ?? []) listener(navEvent, url)
      return prevented
    },
  }
}

describe('attachAppShellNavigationGuard', () => {
  it('sends YouTube to the OS browser instead of replacing the ADE', () => {
    const { contents, fire } = fakeContents()
    attachAppShellNavigationGuard(contents)
    expect(fire('will-navigate', 'https://youtube.com/')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://youtube.com/')
  })
})
