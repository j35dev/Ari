import { describe, expect, it } from 'vitest'
import { responseStyleSchema } from '@ari/contracts/settings'
import { responseStyles, resolveResponseStyle } from './response-styles'
import {
  foregroundResponseCall,
  responseResultPreview,
  responseToolInfo,
  responseToolState,
} from './response-presentation'
import type { ToolGroupRow, TranscriptBlock } from './types'

const call: TranscriptBlock = {
  kind: 'tool-call',
  key: 'call-1',
  callId: 'c1',
  name: 'Bash',
  argsJson: '{"command":"pnpm test"}',
}
const result: TranscriptBlock = {
  kind: 'tool-result',
  key: 'result-1',
  callId: 'c1',
  resultJson: '{"stdout":"checks passed","exitCode":0}',
  isError: false,
}

describe('response presentation data', () => {
  it('offers exactly the persisted choices, with the existing UI first', () => {
    expect(responseStyles.map((item) => item.id)).toEqual(responseStyleSchema.options)
    expect(responseStyles[0].label).toContain('Default')
    for (const value of [undefined, null, 'trace', 'focus', 'unknown'])
      expect(resolveResponseStyle(value)).toBe('default')
    for (const value of responseStyleSchema.options) expect(resolveResponseStyle(value)).toBe(value)
  })

  it('distinguishes a missing result, an empty response, and a failed call', () => {
    expect(responseToolState(undefined, true)).toBe('running')
    expect(responseToolState(undefined, false)).toBe('unanswered')
    expect(responseToolState({ ...result, resultJson: '' }, false)).toBe('returned')
    expect(responseToolState({ ...result, isError: true }, true)).toBe('failed')
  })

  it('caches finished payload presentation but invalidates on changed args or results', () => {
    const pending = responseToolInfo(call, undefined)
    expect(pending.title).toBe('Run pnpm test')
    expect(pending.preview).toBeNull()
    expect(responseToolInfo(call, undefined)).toBe(pending)
    const completed = responseToolInfo(call, result)
    expect(completed.preview).toBe('checks passed')
    expect(responseToolInfo(call, result)).toBe(completed)
    expect(completed).not.toBe(pending)
    expect(responseToolInfo({ ...call, argsJson: '{"command":"git status"}' }, result).title).toBe(
      'Run git status',
    )
  })

  it('does not hide an earlier concurrent call behind the newest returned one', () => {
    const second = { ...call, key: 'call-2', callId: 'c2' }
    const row: ToolGroupRow = {
      kind: 'tool-group',
      key: 'group',
      blocks: [call, second],
      calls: [call, second],
      resultsByCallId: new Map([['c2', { ...result, callId: 'c2' }]]),
    }
    expect(foregroundResponseCall(row, true)).toBe(call)
    expect(foregroundResponseCall(row, false)).toBe(second)
    expect(foregroundResponseCall({ ...row, calls: [] }, false)).toBeUndefined()
  })

  it('uses the actual name for an unknown provider tool', () => {
    const info = responseToolInfo(
      { ...call, name: 'mcp__files__custom_action', argsJson: '{not-json' },
      undefined,
    )
    expect(info.title.length).toBeGreaterThan(0)
    expect(info.preview).toBeNull()
  })
})

describe('bounded response excerpts', () => {
  it.each([
    ['plain\ntext', 'plain\ntext'],
    ['"a JSON string"', 'a JSON string'],
    ['{"output":"stdout text"}', 'stdout text'],
    [
      '{"content":[{"type":"text","text":"MCP text"},{"type":"image","data":"private-image-bytes","mimeType":"image/png"}]}',
      'MCP text',
    ],
    ['[{"type":"text","text":"first"},{"type":"text","text":"second"}]', 'first\nsecond'],
  ])('extracts only readable output from %s', (raw, expected) => {
    expect(responseResultPreview(raw)).toBe(expected)
  })

  it('does not put binary payloads or opaque objects into a live card', () => {
    expect(
      responseResultPreview('{"content":[{"type":"image","data":"secret-base64"}]}'),
    ).toBeNull()
    expect(responseResultPreview('{"count":3,"internal":"value"}')).toBeNull()
    expect(responseResultPreview('')).toBeNull()
    expect(responseResultPreview(undefined)).toBeNull()
    expect(responseResultPreview('x'.repeat(100_000))).toBeNull()
  })

  it('bounds both line count and length and strips terminal escapes', () => {
    expect(responseResultPreview('one\ntwo\nthree\nfour\nfive\nsix')).toBe('one\ntwo\nthree\nfour…')
    expect(responseResultPreview('a'.repeat(1200))?.length).toBeLessThanOrEqual(481)
    expect(
      responseResultPreview(`${String.fromCharCode(27)}[32mready${String.fromCharCode(27)}[0m`),
    ).toBe('ready')
  })
})
