import { describe, expect, it } from 'vitest'
import { containsDsml, parseDsmlToolCalls } from './dsml'

const WIRE = `<|DSML|tool_calls>
<|DSML|tool_invoke name="read">
<|DSML|parameter name="file" string="true">PROGRESS.md</|DSML|parameter>
</|DSML|tool_invoke>
<|DSML|invoke name="read">
<|DSML|parameter name="file" string="true">PLAN.md</|DSML|parameter>
</|DSML|invoke>
<|DSML|invoke name="bash">
<|DSML|parameter name="command" string="true">git status</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>`

const RENDERED = `< | DSML | tool_calls>
< | DSML | tool_invoke name="read">
< | DSML | parameter name="file" string="true">PROGRESS.md</ | DSML | parameter>
</ | DSML | tool_invoke>
</ | DSML | tool_calls>`

describe('parseDsmlToolCalls', () => {
  it('extracts invokes from the wire format and aliases file → path', () => {
    const calls = parseDsmlToolCalls(WIRE)
    expect(calls).toEqual([
      { name: 'read', args: { path: 'PROGRESS.md' } },
      { name: 'read', args: { path: 'PLAN.md' } },
      { name: 'bash', args: { command: 'git status' } },
    ])
  })

  it('tolerates the spaced form markdown makes of the same markup', () => {
    const calls = parseDsmlToolCalls(RENDERED)
    expect(calls).toEqual([{ name: 'read', args: { path: 'PROGRESS.md' } }])
  })

  it('parses a one-line invoke the streamer actually holds', () => {
    const oneLine =
      '<|DSML|invoke name="read"><|DSML|parameter name="file" string="true">PROGRESS.md</|DSML|parameter></|DSML|invoke>'
    expect(parseDsmlToolCalls(oneLine)).toEqual([{ name: 'read', args: { path: 'PROGRESS.md' } }])
  })

  it('returns [] for ordinary assistant text', () => {
    expect(parseDsmlToolCalls('Let me look around.')).toEqual([])
    expect(containsDsml('Let me look around.')).toBe(false)
  })

  it('detects a DSML open tag', () => {
    expect(containsDsml('<|DSML|tool_calls>')).toBe(true)
    expect(containsDsml('< | DSML | invoke name="read">')).toBe(true)
  })
})
