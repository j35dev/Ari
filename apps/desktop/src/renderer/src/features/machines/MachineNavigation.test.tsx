import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectViewSchema } from '@ari/contracts/project'
import { sessionSummarySchema } from '@ari/contracts/rpc'
import type { RemoteProjectCatalog } from '@ari/contracts/remote'
import { MachinesProvider, useMachines } from './use-machines'
import { useMachineProjects } from './use-machine-projects'
import { SessionsUnderProjects } from '../../shell/Sidebar'
import { desktopMachineFixture, projectCatalogFixture, localSnapshotFixture, resourcesFixture, versionFixture, catalogFixture } from './fixtures.test-support'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn<(name: string, params: Record<string, unknown>, listener: (raw: unknown) => void) => () => void>(() => () => {}) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
const localProject = projectViewSchema.parse({ id: 'same-project', name: 'Ari', path: 'D:/code/Ari', open: true, createdAt: 1, status: 'ok' })
const localSession = sessionSummarySchema.parse({ id: 'sess_same', projectId: 'same-project', title: 'Local task', updatedAt: 2, messageCount: 1 })
const remoteSession = { ...localSession, title: 'Host task' }
let hosts = [desktopMachineFixture()]
let update: (raw: unknown) => void
let projects: RemoteProjectCatalog = projectCatalogFixture()
const select = vi.fn()
function ResourceProbe() {
  const metadata = useMachines()
  return <><output data-testid="resources">{JSON.stringify([...metadata.resources])}</output>
    <button onClick={() => void metadata.refreshInventory()}>Refresh inventory</button>
    <button onClick={() => void metadata.refreshResources(['local', 'host-a'])}>Sample Auto resources</button></>
}
afterEach(() => vi.useRealTimers())
function Sidebar() {
  const nav = useMachineProjects([localProject], [localSession])
  const metadata = useMachines()
  return <><output data-testid="cache">{JSON.stringify([...metadata.inventories])}</output>
    <SessionsUnderProjects projects={nav.sidebarProjects} sessions={nav.sessions} activeSessionId={null}
      hostOf={(id) => nav.hosts.get(id)} onSelect={select} onRename={vi.fn()} onDelete={vi.fn()}
      onTogglePin={vi.fn()} onToggleArchive={vi.fn()} /></>
}
beforeEach(() => {
  localStorage.clear(); select.mockReset(); hosts = [desktopMachineFixture()]; projects = projectCatalogFixture()
  mocks.invoke.mockReset(); mocks.subscribe.mockReset()
  mocks.subscribe.mockImplementation((_name, _params, listener) => { update = listener; return () => {} })
  mocks.invoke.mockImplementation(async (method, params) => {
    if (method === 'machines.list') return hosts
    if (method === 'machines.localSnapshot') return localSnapshotFixture()
    if (method === 'machines.preferences') return { autoEnabled: false, hostTiers: {}, projectHosts: {} }
    const op = params?.query?.op
    const result = op === 'project.catalog' ? projects : op === 'session.list' ? [remoteSession] :
      op === 'models.list' ? catalogFixture : op === 'host.resources' ? resourcesFixture() :
      op === 'host.permissions' ? { deviceId: 'device', projectScope: { kind: 'all' }, allowTerminal: false, managedLeaseExpiresAt: null } :
      op === 'host.version' ? versionFixture : undefined
    if (result === undefined) throw new Error(`Unexpected ${method}`)
    return { ok: true, result }
  })
})
it('merges local and remote rows into one repository, retains offline ownership, and disables host administration', async () => {
  const user = userEvent.setup()
  render(<MachinesProvider><Sidebar /></MachinesProvider>)
  await screen.findByText('Host task')
  expect(screen.getAllByRole('region', { name: 'Ari' })).toHaveLength(1)
  const group = screen.getByRole('region', { name: 'Ari' })
  expect(group).toHaveTextContent('Local task'); expect(group).toHaveTextContent('Studio computer')
  expect(group).not.toHaveTextContent('This PC')
  expect(screen.getByRole('button', { name: 'Archive Host task' })).toBeDisabled()
  await user.click(screen.getByText('Host task'))
  expect(select).toHaveBeenCalledWith(JSON.stringify(['host-a', 'sess_same']))
  hosts = [{ ...hosts[0]!, status: 'offline' }]
  act(() => update(hosts))
  await waitFor(() => expect(group).toHaveTextContent('offline'))
  expect(screen.getByText('Host task')).toBeInTheDocument()
  await user.click(screen.getByText('Host task'))
  expect(select).toHaveBeenLastCalledWith(JSON.stringify(['host-a', 'sess_same']))
})
it('keeps a fork with a different origin in its own labeled repository', async () => {
  projects = { projects: [{ ...projects.projects[0]!, repositoryIdentity: { ...projects.projects[0]!.repositoryIdentity,
    origin: { canonicalKey: 'github.com/fork/ari', displayName: 'fork/Ari' } } }] }
  render(<MachinesProvider><Sidebar /></MachinesProvider>)
  await screen.findByText('Host task')
  expect(within(screen.getByRole('region', { name: 'Ari' })).queryByText('Host task')).toBeNull()
  expect(screen.getByRole('region', { name: 'Ari · fork/Ari' })).toHaveTextContent('Host task')
})
it('purges revoked inventory and rejects late failed reads from the old authorization generation', async () => {
  let reject!: (error: Error) => void
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation((method, params) => params?.query?.op === 'project.catalog'
    ? new Promise((_resolve, fail) => { reject = fail }) : original(method, params))
  render(<MachinesProvider><Sidebar /></MachinesProvider>)
  await waitFor(() => expect(reject).toBeTypeOf('function'))
  hosts = [{ ...hosts[0]!, status: 'revoked' }]
  act(() => update(hosts))
  await act(async () => reject(new Error('Old transport closed')))
  expect(screen.getByTestId('cache')).toHaveTextContent('[]')
  expect(screen.queryByText('Host task')).toBeNull()
})
it('purges the old public identity before accepting replacement inventory under a saved registry id', async () => {
  render(<MachinesProvider><Sidebar /></MachinesProvider>)
  await screen.findByText('Host task')
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation((method, params) => params?.query?.op === 'project.catalog'
    ? new Promise(() => {}) : original(method, params))
  hosts = [{ ...hosts[0]!, identity: { ...hosts[0]!.identity, machineId: 'different-public-id' } }]
  act(() => update(hosts))
  await waitFor(() => expect(screen.queryByText('Host task')).toBeNull())
  expect(screen.getByTestId('cache')).toHaveTextContent('[]')
})
it('does not sample resources on mount, inventory interval or manual inventory refresh; demand samples exact hosts', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  render(<MachinesProvider><Sidebar /><ResourceProbe /></MachinesProvider>)
  await screen.findByText('Host task')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  const resourceCalls = () => mocks.invoke.mock.calls.filter(([, params]) => params?.query?.op === 'host.resources')
  expect(resourceCalls()).toHaveLength(0)
  expect(mocks.invoke.mock.calls.filter(([method]) => method === 'machines.localSnapshot')
    .every(([, params]) => params === undefined)).toBe(true)
  expect(screen.getByTestId('resources')).toHaveTextContent('[]')
  fireEvent.click(screen.getByRole('button', { name: 'Sample Auto resources' }))
  await waitFor(() => expect(screen.getByTestId('resources')).toHaveTextContent('cpuUtilization'))
  expect(resourceCalls()).toHaveLength(1)
  expect(resourceCalls()[0]?.[1]).toMatchObject({ machineId: 'host-a' })
  expect(mocks.invoke).toHaveBeenCalledWith('machines.localSnapshot', { sampleResources: true })
})
it('drops demand resource responses after disconnect and does not restore eligibility after reconnect', async () => {
  let resolve!: (result: unknown) => void
  const original = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation((method, params) => params?.query?.op === 'host.resources'
    ? new Promise((done) => { resolve = done }) : original(method, params))
  render(<MachinesProvider><Sidebar /><ResourceProbe /></MachinesProvider>)
  await screen.findByText('Host task')
  fireEvent.click(screen.getByRole('button', { name: 'Sample Auto resources' }))
  await waitFor(() => expect(resolve).toBeTypeOf('function'))
  hosts = [{ ...hosts[0]!, status: 'offline' }]
  act(() => update(hosts))
  await act(async () => resolve({ ok: true, result: resourcesFixture() }))
  expect(screen.getByTestId('resources')).not.toHaveTextContent('host-a')
  hosts = [{ ...hosts[0]!, status: 'connected' }]
  act(() => update(hosts))
  await waitFor(() => expect(screen.getByText('Host task')).toBeInTheDocument())
  expect(screen.getByTestId('resources')).not.toHaveTextContent('host-a')
})
