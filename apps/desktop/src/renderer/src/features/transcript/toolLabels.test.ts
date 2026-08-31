import { describe, expect, it } from 'vitest'
import {
  ariToolName,
  classifyTool,
  classifyToolCall,
  describeToolCall,
  effectiveToolName,
  parseToolArgs,
  shortenPath,
  thoughtPreview,
  toolTarget,
} from './toolLabels'

describe('classifyTool', () => {
  it('buckets known tool names case-insensitively', () => {
    expect(classifyTool('Edit')).toBe('edit')
    expect(classifyTool('write_file')).toBe('edit')
    expect(classifyTool('read_file')).toBe('read')
    expect(classifyTool('list_dir')).toBe('read')
    expect(classifyTool('Grep')).toBe('search')
    expect(classifyTool('web_fetch')).toBe('search')
  })

  it('probes unfamiliar names by substring, shells first', () => {
    expect(classifyTool('run_terminal_command')).toBe('run')
    expect(classifyTool('str_replace_based_edit_tool')).toBe('edit')
    expect(classifyTool('view_source_file')).toBe('read')
    expect(classifyTool('codebase_lookup')).toBe('search')
  })

  it('treats anything unrecognised or missing as a command run', () => {
    expect(classifyTool('sparkle')).toBe('run')
    expect(classifyTool(undefined)).toBe('run')
  })
})

describe('ariToolName', () => {
  it('brands every bucket as an Ari tool', () => {
    expect(ariToolName('run')).toBe('Ari Run')
    expect(ariToolName('edit')).toBe('Ari Edit')
    expect(ariToolName('read')).toBe('Ari Read')
    expect(ariToolName('search')).toBe('Ari Search')
  })
})

describe('parseToolArgs', () => {
  it('unwraps ACP envelopes and exposes both records', () => {
    const parsed = parseToolArgs('{"title":"run_terminal_command","input":{"command":"ls"}}')
    expect(parsed?.args).toEqual({ title: 'run_terminal_command', input: { command: 'ls' } })
    expect(parsed?.payload).toEqual({ command: 'ls' })
  })

  it('returns null for missing or non-object payloads', () => {
    expect(parseToolArgs(undefined)).toBeNull()
    expect(parseToolArgs('')).toBeNull()
    expect(parseToolArgs('"just a string"')).toBeNull()
    expect(parseToolArgs('not json')).toBeNull()
  })
})

describe('shortenPath', () => {
  it('keeps the last two segments and normalises separators', () => {
    expect(shortenPath('D:\\Projects\\Ari\\packages\\ui\\src\\tokens.css')).toBe('src/tokens.css')
    expect(shortenPath('/home/u/app/main.ts')).toBe('app/main.ts')
  })

  it('passes short paths through', () => {
    expect(shortenPath('README.md')).toBe('README.md')
    expect(shortenPath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('toolTarget', () => {
  it('prefers the command over other arguments', () => {
    expect(toolTarget('{"command":"git log -1 --oneline","cwd":"D:/Projects/Ari"}')).toBe(
      'git log -1 --oneline',
    )
  })

  it('shortens path-shaped arguments', () => {
    expect(toolTarget('{"target_file":"D:\\\\Projects\\\\Ari\\\\apps\\\\desktop\\\\index.ts"}')).toBe(
      'desktop/index.ts',
    )
  })

  it('collapses newlines and caps long commands', () => {
    const target = toolTarget(JSON.stringify({ command: `echo one\n  echo two` }))
    expect(target).toBe('echo one echo two')
    const long = toolTarget(JSON.stringify({ command: 'x'.repeat(200) }))
    expect(long).toHaveLength(96)
    expect(long.endsWith('…')).toBe(true)
  })

  it('falls back to the first string argument, then to nothing', () => {
    expect(toolTarget('{"unheard_of":"value"}')).toBe('value')
    expect(toolTarget('{"depth":3}')).toBe('')
    expect(toolTarget(undefined)).toBe('')
  })

  it('keeps unparseable payloads as a single line', () => {
    expect(toolTarget('not json\nat all')).toBe('not json at all')
  })
})

describe('describeToolCall', () => {
  it('tenses the verb for settled versus in-flight steps', () => {
    const block = { name: 'read_file', argsJson: '{"file_path":"src/a.ts"}' }
    expect(describeToolCall(block)).toEqual({ kind: 'read', verb: 'Read', target: 'src/a.ts' })
    expect(describeToolCall(block, true).verb).toBe('Reading')
  })

  it('falls back to the tool name when no argument is showable', () => {
    expect(describeToolCall({ name: 'Bash', argsJson: '{}' }).target).toBe('Bash')
  })
})

describe('the ACP { title, input } envelope', () => {
  const shellCall = {
    name: 'tool',
    argsJson: '{"title":"run_terminal_command","input":{"command":"git log -1 --oneline main"}}',
  }
  const readCall = {
    name: 'tool',
    argsJson: '{"title":"read_file","input":{"target_file":"D:\\\\Projects\\\\Ari\\\\.ari\\\\state.json"}}',
  }

  it('recovers the real tool name from the request title', () => {
    expect(effectiveToolName('tool', shellCall.argsJson)).toBe('run_terminal_command')
    expect(effectiveToolName('Bash', shellCall.argsJson)).toBe('Bash')
  })

  it('reads the target out of the nested input', () => {
    expect(toolTarget(shellCall.argsJson)).toBe('git log -1 --oneline main')
    expect(toolTarget(readCall.argsJson)).toBe('.ari/state.json')
  })

  it('buckets the call by its recovered name, not the generic one', () => {
    expect(classifyToolCall(shellCall)).toBe('run')
    expect(classifyToolCall(readCall)).toBe('read')
  })

  it('never shows the envelope title as the target', () => {
    expect(toolTarget('{"title":"some_tool","input":{}}')).toBe('')
    expect(describeToolCall({ name: 'tool', argsJson: '{"title":"some_tool","input":{}}' })).toEqual(
      { kind: 'run', verb: 'Ran', target: 'some_tool' },
    )
  })
})

describe('thoughtPreview', () => {
  it('takes the first meaningful line without markdown noise', () => {
    expect(thoughtPreview('\n\n## **Plan**\nthen details')).toBe('Plan')
    expect(thoughtPreview('- weighing `pnpm verify` first')).toBe('weighing pnpm verify first')
  })

  it('caps long thoughts and handles empty text', () => {
    const preview = thoughtPreview('a'.repeat(300))
    expect(preview).toHaveLength(120)
    expect(preview.endsWith('…')).toBe(true)
    expect(thoughtPreview('   ')).toBe('Thinking')
  })
})
