import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeSdkExecutable } from './executable'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
const platform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(existsSync).mockReset()
})
afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

it('follows a Windows npm shim to the installed native Claude binary', () => {
  const shim = join('C:/npm', 'claude.cmd')
  const native = join(dirname(shim), 'node_modules/@anthropic-ai/claude-code/bin/claude.exe')
  vi.mocked(existsSync).mockImplementation((path) => path === native)
  expect(claudeSdkExecutable(shim)).toBe(native)
})
it('uses the installed JavaScript entry for older npm installations', () => {
  const shim = join('C:/npm', 'claude.ps1')
  const entry = join(dirname(shim), 'node_modules/@anthropic-ai/claude-code/cli.js')
  vi.mocked(existsSync).mockImplementation((path) => path === entry)
  expect(claudeSdkExecutable(shim)).toBe(entry)
  expect(claudeSdkExecutable('installed.exe')).toBe('installed.exe')
})
it('keeps custom launchers on the compatibility path instead of using a different bundled CLI', () => {
  vi.mocked(existsSync).mockReturnValue(false)
  expect(() => claudeSdkExecutable('custom.cmd')).toThrow(
    'Cannot locate the installed Claude executable',
  )
})
