import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { PermissionsSettings } from './PermissionsSettings'

function storedAllowlist(): string[] {
  const raw = localStorage.getItem('ari.allowlist')
  return raw == null ? [] : (JSON.parse(raw) as string[])
}

describe('PermissionsSettings', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips an allowlist entry through localStorage', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    await user.type(screen.getByRole('textbox', { name: 'Command to always allow' }), 'git push')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('git push')).toBeInTheDocument()
    expect(storedAllowlist()).toEqual(['git push'])

    await user.click(screen.getByRole('button', { name: 'Remove git push' }))

    expect(screen.queryByText('git push')).not.toBeInTheDocument()
    expect(storedAllowlist()).toEqual([])
  })

  it('persists the default permission mode selection', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    expect(localStorage.getItem('ari.defaultMode')).toBeNull()
    await user.click(screen.getByRole('radio', { name: /Full access/ }))

    expect(localStorage.getItem('ari.defaultMode')).toBe('full')
  })
})
