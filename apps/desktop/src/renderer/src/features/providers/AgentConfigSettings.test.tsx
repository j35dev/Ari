import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfigSettings } from './AgentConfigSettings'
import { pickInitialAgent } from './agent-config-model'
import {
  createLeaveGuardStore,
  guardedLeave,
  LeaveGuardContext,
} from '../settings/settings-leave-guard'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: vi.fn() } }))

const CLAUDE_FILES = {
  dir: '/home/u/.claude',
  files: [
    {
      id: 'settings',
      label: 'settings.json',
      path: '/home/u/.claude/settings.json',
      format: 'json' as const,
      description: 'Model, permission allow/deny rules, hooks, plugins, environment.',
      exists: true,
      size: 1230,
    },
    {
      id: 'memory',
      label: 'CLAUDE.md',
      path: '/home/u/.claude/CLAUDE.md',
      format: 'markdown' as const,
      description: 'Standing instructions for every project.',
      exists: false,
      size: 0,
    },
  ],
}

const CODEX_FILES = {
  dir: '/home/u/.codex',
  files: [
    {
      id: 'config',
      label: 'config.toml',
      path: '/home/u/.codex/config.toml',
      format: 'toml' as const,
      description: 'Model and reasoning effort.',
      exists: true,
      size: 40,
    },
  ],
}

const skill = (name: string, scope: 'user' | 'project', summary?: string) => ({
  kind: 'skill' as const,
  scope,
  provider: 'claude' as const,
  id: `claude:${scope}:skill:${name}`,
  name,
  ...(summary ? { summary } : {}),
  sourcePath: `/home/u/.claude/skills/${name}/SKILL.md`,
  disabled: false,
  delivery: 'delegated' as const,
})

const INVENTORY = {
  truncated: false,
  records: [
    skill('clipper-flash', 'user', 'Turn livestreams into Shorts'),
    skill('figma', 'user', 'Bring Figma into a video'),
    skill('deploy', 'project', 'Ship the app to production'),
    {
      kind: 'mcp' as const,
      scope: 'user' as const,
      provider: 'claude' as const,
      id: 'claude:user:mcp:/home/u/.claude.json:github',
      name: 'github',
      sourcePath: '/home/u/.claude.json',
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envKeys: ['GITHUB_TOKEN'],
      disabled: false,
      delivery: 'delegated' as const,
    },
    {
      kind: 'mcp' as const,
      scope: 'ari' as const,
      provider: 'claude' as const,
      id: 'ari:browser',
      name: 'ari-browser',
      summary: 'Sent as HTTP only when the agent advertises it.',
      sourcePath: null,
      transport: 'http' as const,
      disabled: false,
      delivery: 'injected' as const,
    },
  ],
}

type Handler = (method: string, params?: Record<string, unknown>) => unknown

let defaultKind: string | null = 'claude'
let installed: string[] = ['claude', 'codex', 'pi']
let overrides: Handler = () => undefined

beforeEach(() => {
  defaultKind = 'claude'
  installed = ['claude', 'codex', 'pi']
  overrides = () => undefined
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    const custom = overrides(method, params)
    if (custom !== undefined) return custom
    switch (method) {
      case 'settings.get':
        return { sessions: { defaultDriverKind: defaultKind, defaultPermissionMode: 'ask' } }
      case 'providers.detect':
        return installed.map((kind) => ({ kind, installed: true }))
      case 'providers.configFiles':
        return params?.['kind'] === 'codex'
          ? CODEX_FILES
          : params?.['kind'] === 'claude'
            ? CLAUDE_FILES
            : { dir: null, files: [] }
      case 'providers.extensionInventory':
        return params?.['kind'] === 'claude' ? INVENTORY : { records: [], truncated: false }
      case 'providers.readConfig':
        return params?.['fileId'] === 'config'
          ? { content: 'model = "gpt-5"\n', exists: true, path: 'x', truncated: false }
          : { content: '{\n  "model": "opus"\n}\n', exists: true, path: 'x', truncated: false }
      case 'providers.readExtensionFile':
        return { content: '---\nname: figma\n---\nBody\n', truncated: false }
      case 'providers.writeConfig':
        return { ok: true, bytesWritten: 10 }
      case 'providers.revealPath':
        return { revealed: true }
      case 'sessions.importable':
        return []
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
})

async function openClaudePage() {
  const user = userEvent.setup()
  render(<AgentConfigSettings />)
  await screen.findByRole('button', { name: 'Edit settings.json' })
  return user
}

describe('default agent', () => {
  it("opens on the user's default agent with its display name", async () => {
    render(<AgentConfigSettings />)
    expect(await screen.findByRole('button', { name: 'Claude Code', pressed: true })).toBeVisible()
    expect(await screen.findByText('/home/u/.claude')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pi' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'pi' })).not.toBeInTheDocument()
  })

  it('falls back to the first installed agent when there is no default', async () => {
    defaultKind = null
    installed = ['pi', 'codex']
    render(<AgentConfigSettings />)
    // Switcher order is Claude Code, Codex, Grok, Pi…, so Codex wins.
    expect(await screen.findByRole('button', { name: 'Codex', pressed: true })).toBeVisible()
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('providers.configFiles', { kind: 'codex' }),
    )
  })

  it('picks the default, then installed, then the first agent', () => {
    expect(pickInitialAgent('grok', new Set())).toBe('grok')
    expect(pickInitialAgent('hermes', new Set(['qoder', 'pi']))).toBe('pi')
    expect(pickInitialAgent(null, new Set())).toBe('claude')
  })
})

describe('tabs', () => {
  it('counts files, skills and MCP servers, and keeps MCP out of the skill list', async () => {
    const user = await openClaudePage()
    const tabs = screen.getByRole('tablist')
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: 'Skills 3' })).toBeVisible())
    expect(within(tabs).getByRole('tab', { name: 'Files 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(within(tabs).getByRole('tab', { name: 'MCP servers 2' })).toBeVisible()

    expect(screen.getByText('1.2 KB')).toBeInTheDocument()
    expect(screen.getByText('not created')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create CLAUDE.md' })).toBeInTheDocument()

    await user.click(within(tabs).getByRole('tab', { name: 'Skills 3' }))
    const list = screen.getByRole('list', { name: 'Skills' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).queryByText('github')).not.toBeInTheDocument()
  })

  it('opens the agent folder through the provider reveal RPC', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(mocks.invoke).toHaveBeenCalledWith('providers.revealPath', {
      kind: 'claude',
      workspacePath: null,
      path: null,
    })
  })

  it('says so plainly when Ari has no layout for an agent', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Qoder' }))
    expect(await screen.findByText(/no confirmed config layout/i)).toBeInTheDocument()
  })
})

describe('skills', () => {
  it('searches by name or summary and filters by scope', async () => {
    const user = await openClaudePage()
    await user.click(await screen.findByRole('tab', { name: 'Skills 3' }))
    const search = screen.getByPlaceholderText('Search 3 skills')

    await user.type(search, 'production')
    let list = screen.getByRole('list', { name: 'Skills' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('deploy')).toBeInTheDocument()

    await user.clear(search)
    await user.click(screen.getByRole('button', { name: 'User 2' }))
    list = screen.getByRole('list', { name: 'Skills' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).queryByText('deploy')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Project 1' }))
    await user.type(search, 'zzz')
    expect(screen.getByText(/No skills match/)).toBeInTheDocument()
  })

  it('stops a long list and offers to filter instead', async () => {
    overrides = (method) =>
      method === 'providers.extensionInventory'
        ? {
            truncated: false,
            records: Array.from({ length: 40 }, (_, index) => skill(`skill-${index}`, 'user')),
          }
        : undefined
    const user = await openClaudePage()
    await user.click(await screen.findByRole('tab', { name: 'Skills 40' }))
    expect(screen.getByText('10 more · type to filter')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    expect(
      within(screen.getByRole('list', { name: 'Skills' })).getAllByRole('listitem'),
    ).toHaveLength(40)
  })

  it("opens a skill's SKILL.md read only", async () => {
    const user = await openClaudePage()
    await user.click(await screen.findByRole('tab', { name: 'Skills 3' }))
    await user.click(screen.getByRole('button', { name: 'Open figma' }))
    const editor = await screen.findByRole('textbox', { name: 'SKILL.md contents' })
    expect(editor).toHaveValue('---\nname: figma\n---\nBody\n')
    expect(editor).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('providers.readExtensionFile', {
      kind: 'claude',
      workspacePath: null,
      path: '/home/u/.claude/skills/figma/SKILL.md',
    })
    expect(screen.getByText('Read only')).toBeInTheDocument()
  })
})

describe('MCP servers', () => {
  it('opens details with env names but never values', async () => {
    const user = await openClaudePage()
    await user.click(await screen.findByRole('tab', { name: 'MCP servers 2' }))
    expect(screen.getByText('Added by Ari')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'github details' }))
    expect(screen.getByText('npx -y @modelcontextprotocol/server-github')).toBeInTheDocument()
    const env = screen.getByRole('list', { name: 'Environment variables' })
    expect(env).toHaveTextContent('GITHUB_TOKEN = ••••')
    expect(screen.getByText('/home/u/.claude.json')).toBeInTheDocument()
  })

  it("keeps Ari Core's switch for its own servers", async () => {
    overrides = (method, params) => {
      if (method === 'providers.extensionInventory' && params?.['kind'] === 'ari-core') {
        return {
          truncated: false,
          records: [
            {
              kind: 'mcp',
              scope: 'user',
              provider: 'ari-core',
              id: 'ari-core:user:mcp:srv-1:docs',
              name: 'docs',
              sourcePath: null,
              transport: 'stdio',
              command: 'docs-mcp',
              envKeys: ['API_KEY'],
              disabled: false,
              delivery: 'hosted',
            },
          ],
        }
      }
      if (method === 'ariCore.mcp.upsert') return { id: 'srv-1' }
      return undefined
    }
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Ari Core' }))
    await user.click(await screen.findByRole('tab', { name: 'MCP servers 1' }))
    await user.click(screen.getByRole('switch', { name: 'Turn docs off' }))
    expect(mocks.invoke).toHaveBeenCalledWith('ariCore.mcp.upsert', { id: 'srv-1', disabled: true })
  })
})

describe('editor', () => {
  it('takes the keyboard as the file opens, so typing lands in it', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))

    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    expect(editor).toHaveFocus()

    await user.keyboard('x')
    expect(editor).toHaveValue('x{\n  "model": "opus"\n}\n')
  })

  it('opens a file in place of the tabs and saves with Ctrl+S', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))

    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(crumbs).toHaveTextContent('Agents')
    expect(crumbs).toHaveTextContent('Claude Code')
    expect(crumbs).toHaveTextContent('settings.json')
    expect(screen.getByText('/home/u/.claude/settings.json')).toBeInTheDocument()
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled()

    await user.clear(editor)
    await user.type(editor, '{{"model":"sonnet"}')
    expect(screen.getByText('Edited')).toBeInTheDocument()
    await user.keyboard('{Control>}s{/Control}')

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('providers.writeConfig', {
        kind: 'claude',
        fileId: 'settings',
        content: '{"model":"sonnet"}',
      })
    })
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('reverts to what is on disk', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    await user.type(editor, 'x')
    await user.click(screen.getByRole('button', { name: 'Revert' }))
    expect(editor).toHaveValue('{\n  "model": "opus"\n}\n')
    expect(screen.getByRole('button', { name: 'Revert' })).toBeDisabled()
  })

  it('blocks saving invalid JSON and says where it broke', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    await user.clear(editor)
    await user.type(editor, '{{\n"a": 1,\n}')
    expect(screen.getByRole('status')).toHaveTextContent(/Invalid JSON · Ln 3/)
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled()
    await user.keyboard('{Control>}s{/Control}')
    expect(mocks.invoke).not.toHaveBeenCalledWith('providers.writeConfig', expect.anything())
  })

  it('warns about a TOML problem but still lets you save', async () => {
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    await user.click(await screen.findByRole('button', { name: 'Edit config.toml' }))
    const editor = await screen.findByRole('textbox', { name: 'config.toml contents' })
    expect(screen.getByText('Valid TOML')).toBeInTheDocument()
    await user.clear(editor)
    await user.type(editor, 'model = gpt-5')
    expect(screen.getByRole('status')).toHaveTextContent(/TOML problem · Ln 1/)
    expect(screen.getByRole('button', { name: /^Save/ })).toBeEnabled()
  })

  it('surfaces a rejected save instead of pretending it landed', async () => {
    overrides = (method) =>
      method === 'providers.writeConfig' ? { ok: false, error: 'disk is read only' } : undefined
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    await user.type(editor, ' ')
    await user.click(screen.getByRole('button', { name: /^Save/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk is read only')
    expect(screen.getByText('Edited')).toBeInTheDocument()
  })

  it('refuses to edit a truncated file', async () => {
    overrides = (method) =>
      method === 'providers.readConfig'
        ? { content: '{"big":', exists: true, path: 'x', truncated: true }
        : undefined
    const user = await openClaudePage()
    await user.click(screen.getByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })
    expect(editor).toHaveAttribute('readonly')
    expect(screen.getByText(/too large to edit/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Save/ })).toBeDisabled()
  })

  it('asks before leaving with unsaved edits, from Back and from settings', async () => {
    const store = createLeaveGuardStore()
    const user = userEvent.setup()
    render(
      <LeaveGuardContext.Provider value={store}>
        <AgentConfigSettings />
      </LeaveGuardContext.Provider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Edit settings.json' }))
    const editor = await screen.findByRole('textbox', { name: 'settings.json contents' })

    // Clean: settings may navigate away freely.
    const free = vi.fn()
    act(() => guardedLeave(store, free))
    expect(free).toHaveBeenCalledOnce()

    await user.type(editor, 'x')
    await user.click(screen.getByRole('button', { name: 'Back to Claude Code' }))
    expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(editor).toHaveValue('{\n  "model": "opus"\n}\nx')

    const leave = vi.fn()
    act(() => guardedLeave(store, leave))
    expect(leave).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(leave).toHaveBeenCalledOnce()

    await user.type(editor, 'y')
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(await screen.findByRole('tablist')).toBeInTheDocument()
  })
})
