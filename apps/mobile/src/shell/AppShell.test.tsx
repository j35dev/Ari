// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://phone.test/"}
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

vi.mock('../lib/service-worker', () => ({
  registerServiceWorker: vi.fn(),
  applyUpdate: vi.fn(),
  UpdateBanner: () => null,
}))
vi.mock('../features/home/HomeScreen', () => ({
  HomeScreen: (props: { onOpen: (id: string) => void; onSettings: () => void }) => (
    <div>
      <p>Home</p>
      <button onClick={() => props.onOpen('sess_1')}>Open session</button>
      <button onClick={props.onSettings}>Settings</button>
    </div>
  ),
}))
vi.mock('../features/settings/SettingsScreen', () => ({
  SettingsScreen: (props: { onBack: () => void }) => <button onClick={props.onBack}>Back</button>,
}))
vi.mock('../features/session/SessionScreen', () => ({
  SessionScreen: (props: { sessionId: string; onBack: () => void }) => (
    <button onClick={props.onBack}>Leave {props.sessionId}</button>
  ),
}))

beforeEach(() => history.replaceState(null, '', '/'))
afterEach(cleanup)

describe('navigation', () => {
  it('pushes settings over the list and returns with the system back', async () => {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(location.search).toBe('?view=settings')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Home')).toBeTruthy()
    expect(location.search).toBe('')
  })

  it('pushes a session over the list and returns with the system back', async () => {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Leave sess_1' }))
    expect(await screen.findByText('Home')).toBeTruthy()
  })

  it('goes home from a session opened by a link, which has nothing behind it', async () => {
    history.replaceState(null, '', '/?session=sess_9')
    render(<AppShell />)
    fireEvent.click(await screen.findByRole('button', { name: 'Leave sess_9' }))
    expect(await screen.findByText('Home')).toBeTruthy()
    expect(location.search).toBe('')
  })

  it('lands on the list from a link to a tab that no longer exists', () => {
    history.replaceState(null, '', '/?view=projects')
    render(<AppShell />)
    expect(screen.getByText('Home')).toBeTruthy()
  })
})
