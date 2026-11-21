import { describe, expect, it } from 'vitest'
import {
  ARI_SLASH_COMMANDS,
  filterSlashCommands,
  findSlashCommand,
  isHiddenSlashCommand,
  parseSlashCommand,
  slashCommandSchema,
  type SlashCommand,
} from './slash-commands'

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: '',
  argumentHint: null,
  source: 'builtin',
  run: 'prompt-text',
  ...extra,
})

describe('parseSlashCommand', () => {
  it('reads a leading command and its arguments', () => {
    expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseSlashCommand('  /goal ship the beta  ')).toEqual({
      name: 'goal',
      args: 'ship the beta',
    })
    expect(parseSlashCommand('/review focus on\nthe parser')).toEqual({
      name: 'review',
      args: 'focus on\nthe parser',
    })
    expect(parseSlashCommand('/superpowers:brainstorming x')?.name).toBe(
      'superpowers:brainstorming',
    )
    expect(parseSlashCommand('/$imagegen a cat')).toEqual({ name: '$imagegen', args: 'a cat' })
  })

  it('reads Ari’s two-word command as one name', () => {
    expect(parseSlashCommand('/ari theme neon cyan')).toEqual({
      name: 'ari theme',
      args: 'neon cyan',
    })
    expect(parseSlashCommand('/ARI theme')).toEqual({ name: 'ari theme', args: '' })
  })

  it('leaves paths and slashes inside prose alone', () => {
    expect(parseSlashCommand('/usr/bin is a path')).toBeNull()
    expect(parseSlashCommand('see /docs')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand('// comment')).toBeNull()
  })
})

describe('hidden commands', () => {
  it('hides terminal-only and internal names, plus a provider’s own extras', () => {
    expect(isHiddenSlashCommand('quit')).toBe(true)
    expect(isHiddenSlashCommand('Vim')).toBe(true)
    expect(isHiddenSlashCommand('terminal-setup')).toBe(true)
    expect(isHiddenSlashCommand('__remote-workflow')).toBe(true)
    expect(isHiddenSlashCommand('compact')).toBe(false)
    expect(isHiddenSlashCommand('bashes', new Set(['bashes']))).toBe(true)
  })
})

describe('filterSlashCommands', () => {
  const list = [
    command('compact', { description: 'Free up context' }),
    command('context', { description: 'Show context usage' }),
    command('model', { run: 'unsupported', reason: 'Use the picker' }),
    command('code-review', { source: 'user', description: 'Review the diff' }),
    command('usage', { aliases: ['cost', 'stats'] }),
    command('quit'),
    command('quit', { source: 'project' }),
    ...ARI_SLASH_COMMANDS,
  ]

  it('drops hidden built-ins but keeps a user command that shares a hidden name', () => {
    const names = filterSlashCommands([command('vim'), command('vim', { source: 'user' })], '')
    expect(names).toEqual([command('vim', { source: 'user' })])
  })

  it('ranks name prefixes, then word starts and aliases, then descriptions', () => {
    expect(filterSlashCommands(list, 'co').map((c) => c.name)).toEqual([
      'code-review',
      'compact',
      'context',
      'usage',
    ])
    expect(filterSlashCommands(list, 'review').map((c) => c.name)).toEqual(['code-review'])
    expect(filterSlashCommands(list, 'diff').map((c) => c.name)).toEqual(['code-review'])
  })

  it('lists Ari’s commands first and disabled ones after runnable ones', () => {
    const names = filterSlashCommands(list, '').map((c) => c.name)
    expect(names[0]).toBe('ari theme')
    expect(names.indexOf('model')).toBeGreaterThan(names.indexOf('usage'))
    expect(filterSlashCommands(list, 'ari t').map((c) => c.name)).toEqual(['ari theme'])
  })

  it('finds commands by alias, ignoring case', () => {
    expect(findSlashCommand(list, 'COST')?.name).toBe('usage')
    expect(findSlashCommand(list, 'nope')).toBeUndefined()
  })

  it('validates the wire shape', () => {
    expect(slashCommandSchema.safeParse(command('x', { source: 'mcp' })).success).toBe(true)
    expect(slashCommandSchema.safeParse({ ...command('x'), run: 'maybe' }).success).toBe(false)
  })
})
