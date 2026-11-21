import { describe, expect, it } from 'vitest'
import { AcpUpdateFolder } from './acp/protocol'
import { ClaudeMessageMapper } from './claude/mapper'
import {
  acpCommandsFromUpdate,
  claudeSlashCommands,
  codexSlashCommands,
  withClientSideCommands,
  type ClaudeSdkCommand,
} from './slash-commands'

/** `available_commands_update` as codex-acp 1.7.0 sends it (trimmed). */
const CODEX_ACP_UPDATE = {
  sessionUpdate: 'available_commands_update',
  availableCommands: [
    { name: 'plan', description: 'Turn plan mode on.', input: null },
    {
      name: 'review',
      description: 'Review uncommitted changes, or review with custom instructions.',
      input: { hint: 'optional review instructions' },
    },
    { name: 'compact', description: 'Summarize conversation to avoid hitting the context limit.' },
    {
      name: 'goal',
      description: 'Set a goal to keep pursuing.',
      input: { hint: '[<objective>|clear|pause|resume]' },
    },
    { name: 'logout', description: 'Sign out of Codex.', input: null },
    { name: '$imagegen', description: 'Generate images', input: null },
  ],
}

describe('ACP command lists', () => {
  it('maps an advertised list, with Ari’s own controls answering what they own', () => {
    expect(acpCommandsFromUpdate(CODEX_ACP_UPDATE)).toEqual([
      {
        name: 'plan',
        description: 'Turn plan mode on.',
        argumentHint: null,
        source: 'builtin',
        run: 'prompt-text',
      },
      {
        name: 'review',
        description: 'Review uncommitted changes, or review with custom instructions.',
        argumentHint: 'optional review instructions',
        source: 'builtin',
        run: 'prompt-text',
      },
      expect.objectContaining({ name: 'compact', run: 'prompt-text' }),
      expect.objectContaining({
        name: 'goal',
        argumentHint: '[<objective>|clear|pause|resume]',
        run: 'prompt-text',
      }),
      expect.objectContaining({
        name: 'logout',
        run: 'unsupported',
        reason: expect.stringContaining('provider settings') as string,
      }),
      expect.objectContaining({ name: '$imagegen', source: 'skill', run: 'prompt-text' }),
    ])
  })

  it('drops terminal-only, nameless and malformed entries without throwing', () => {
    expect(
      acpCommandsFromUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: '/quit' },
          { name: '' },
          null,
          42,
          { name: 'mcp__github__pr', description: 'Open a PR (MCP)' },
          { name: 'web', description: 'Search', input: { hint: 7 } },
          { name: 'web', description: 'twice' },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ name: 'mcp__github__pr', source: 'mcp' }),
      expect.objectContaining({ name: 'web', argumentHint: null, description: 'Search' }),
    ])
    expect(
      acpCommandsFromUpdate({ sessionUpdate: 'available_commands_update', availableCommands: {} }),
    ).toEqual([])
    expect(acpCommandsFromUpdate({ sessionUpdate: 'agent_message_chunk' })).toBeNull()
    expect(acpCommandsFromUpdate(null)).toBeNull()
  })

  it('folds the update into a commands event', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({ sessionId: 's', update: CODEX_ACP_UPDATE })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'commands' })
    expect(events[0]?.type === 'commands' && events[0].commands.map((c) => c.name)).toContain(
      'goal',
    )
  })
})

/** `supportedCommands()` rows as the Claude Agent SDK 0.3.330 returns them (trimmed). */
const CLAUDE_COMMANDS: ClaudeSdkCommand[] = [
  { name: 'hyperframes', description: 'Make videos with HyperFrames. (user)', argumentHint: '' },
  { name: 'deploy', description: 'Ship the current branch (project)', argumentHint: '<env>' },
  { name: 'superpowers:brainstorming', description: 'Use before creative work', argumentHint: '' },
  { name: 'mcp__linear__triage', description: 'Triage issues (MCP)', argumentHint: '' },
  {
    name: 'compact',
    description: 'Free up context',
    argumentHint: '<instructions>',
    builtin: true,
  },
  { name: 'model', description: 'Set the AI model', argumentHint: '<model>', builtin: true },
  {
    name: 'clear',
    description: 'Start a new session',
    argumentHint: '[name]',
    aliases: ['reset', 'new'],
    builtin: true,
  },
  {
    name: 'usage',
    description: 'Show session cost',
    argumentHint: '',
    aliases: ['cost', 'stats'],
    builtin: true,
  },
  { name: 'color', description: 'Set the prompt bar color', argumentHint: '', builtin: true },
  { name: 'statusline', description: 'Set up the status line', argumentHint: '', builtin: true },
  { name: 'heapdump', description: 'Dump the JS heap', argumentHint: '', builtin: true },
  { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
  // A user command sharing a built-in's name never runs: the built-in does.
  { name: 'compact', description: 'my compact (user)', argumentHint: '' },
]

describe('Claude command lists', () => {
  it('classifies sources and how each runs', () => {
    const commands = claudeSlashCommands(CLAUDE_COMMANDS, { skills: ['hyperframes'] })
    expect(commands).toEqual([
      expect.objectContaining({
        name: 'hyperframes',
        description: 'Make videos with HyperFrames.',
        source: 'skill',
        run: 'prompt-text',
      }),
      expect.objectContaining({
        name: 'deploy',
        description: 'Ship the current branch',
        argumentHint: '<env>',
        source: 'project',
      }),
      expect.objectContaining({ name: 'superpowers:brainstorming', source: 'user' }),
      expect.objectContaining({ name: 'mcp__linear__triage', source: 'mcp' }),
      expect.objectContaining({ name: 'compact', source: 'builtin', run: 'prompt-text' }),
      expect.objectContaining({
        name: 'model',
        run: 'unsupported',
        reason: expect.stringContaining('model picker') as string,
      }),
      expect.objectContaining({ name: 'clear', run: 'unsupported', aliases: ['reset', 'new'] }),
      expect.objectContaining({ name: 'usage', run: 'prompt-text', aliases: ['cost', 'stats'] }),
    ])
  })

  it('also hides what init reports as terminal-bound', () => {
    const names = claudeSlashCommands(CLAUDE_COMMANDS, { terminal: ['usage'] }).map((c) => c.name)
    expect(names).not.toContain('usage')
    expect(names).toContain('compact')
  })

  it('maps commands_changed, init and local command output from the SDK stream', () => {
    const mapper = new ClaudeMessageMapper()
    const changed = mapper.map({
      type: 'system',
      subtype: 'commands_changed',
      commands: CLAUDE_COMMANDS,
      uuid: 'u',
      session_id: 's',
    } as never)
    expect(changed).toContainEqual(
      expect.objectContaining({
        type: 'commands',
        commands: expect.arrayContaining([
          expect.objectContaining({ name: 'hyperframes' }),
        ]) as unknown[],
      }),
    )
    // Init names the skills and terminal-bound commands; the list is restated with them.
    const init = mapper.map({
      type: 'system',
      subtype: 'init',
      session_id: 's',
      skills: ['hyperframes'],
      terminal_slash_commands: ['usage'],
    } as never)
    const restated = init.find((event) => event.type === 'commands')
    expect(restated?.type === 'commands' && restated.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'hyperframes', source: 'skill' })]),
    )
    expect(restated?.type === 'commands' && restated.commands.some((c) => c.name === 'usage')).toBe(
      false,
    )
    // `/context` answers with a synthetic assistant message: the CLI, not the model.
    const local = mapper.map({
      type: 'assistant',
      message: {
        id: 'm',
        model: '<synthetic>',
        content: [{ type: 'text', text: '## Context Usage\n\n**Tokens:** 10 / 1m' }],
      },
      parent_tool_use_id: null,
      session_id: 's',
      uuid: 'a',
    } as never)
    expect(local).toEqual([{ type: 'notice', message: '## Context Usage\n\n**Tokens:** 10 / 1m' }])
    expect(
      mapper.map({
        type: 'system',
        subtype: 'local_command_output',
        content: 'Voice mode on',
        uuid: 'l',
        session_id: 's',
      } as never),
    ).toEqual([{ type: 'notice', message: 'Voice mode on' }])
  })
})

describe('Codex command lists', () => {
  it('runs the app-server’s methods and explains the TUI’s other commands', () => {
    const commands = codexSlashCommands([
      { name: 'imagegen', description: 'Generate images', shortDescription: 'Images' },
      { name: 'off', description: 'disabled', enabled: false },
    ])
    const byName = new Map(commands.map((c) => [c.name, c]))
    expect(byName.get('compact')).toMatchObject({ run: 'rpc', source: 'builtin' })
    expect(byName.get('review')).toMatchObject({ run: 'rpc', argumentHint: '[instructions]' })
    expect(byName.get('goal')).toMatchObject({
      run: 'rpc',
      argumentHint: '[<objective>|clear|pause|resume]',
    })
    expect(byName.get('model')).toMatchObject({
      run: 'unsupported',
      reason: expect.stringContaining('model picker') as string,
    })
    expect(byName.get('diff')).toMatchObject({ run: 'unsupported' })
    expect(byName.get('$imagegen')).toMatchObject({
      run: 'rpc',
      source: 'skill',
      description: 'Images',
    })
    expect(byName.has('$off')).toBe(false)
    // Terminal-only commands are not listed at all.
    for (const hidden of ['quit', 'exit', 'vim', 'theme', 'statusline', 'keymap'])
      expect(byName.has(hidden)).toBe(false)
  })

  it('adds the client-side commands an advertised Codex list leaves out', () => {
    const advertised = acpCommandsFromUpdate(CODEX_ACP_UPDATE) ?? []
    const merged = withClientSideCommands('codex', advertised)
    const byName = new Map(merged.map((c) => [c.name, c]))
    // What the adapter advertises wins: it handles /plan itself.
    expect(byName.get('plan')).toMatchObject({ run: 'prompt-text' })
    expect(byName.get('model')).toMatchObject({ run: 'unsupported' })
    expect(byName.get('init')).toMatchObject({ run: 'unsupported' })
    expect(withClientSideCommands('opencode', advertised)).toEqual(advertised)
  })
})
