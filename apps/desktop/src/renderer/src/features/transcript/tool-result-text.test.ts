import { describe, expect, it } from 'vitest'
import { presentToolResult, textFromBytePayload } from './tool-result-text'

function bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

describe('presentToolResult', () => {
  it('keeps a JSON string as text with its line breaks', () => {
    expect(presentToolResult(JSON.stringify('alpha\nbeta'))).toEqual({
      text: 'alpha\nbeta',
      lang: 'text',
    })
  })

  it('decodes a character-code dump of command output', () => {
    const text = 'space_path="D:\\Projects"\n'
    expect(presentToolResult(JSON.stringify(bytes(text)))).toEqual({ text, lang: 'text' })
  })

  it('decodes a Node Buffer shape the same way', () => {
    const text = 'space_path="D:\\Projects"\n'
    expect(presentToolResult(JSON.stringify({ type: 'Buffer', data: bytes(text) }))).toEqual({
      text,
      lang: 'text',
    })
  })

  it('shows shell stdout instead of the wrapper object', () => {
    expect(
      presentToolResult(JSON.stringify({ output: 'space_path=ok', stderr: 'warn', exitCode: 0 })),
    ).toEqual({ text: 'space_path=ok\nwarn', lang: 'text' })
    expect(presentToolResult(JSON.stringify({ stdout: 'nope', exitCode: 2 }))).toEqual({
      text: 'exit 2\nnope',
      lang: 'text',
    })
  })

  it('leaves structured JSON and sorted number lists alone', () => {
    expect(presentToolResult('{"ok":true}').text).toContain('"ok": true')
    expect(presentToolResult(JSON.stringify({ output: 'hi', files: ['a.ts'] })).lang).toBe('json')
    const lines = Array.from({ length: 24 }, (_, index) => index + 1)
    expect(presentToolResult(JSON.stringify(lines)).lang).toBe('json')
    expect(textFromBytePayload([115, 112, 97])).toBeNull()
  })

  it('keeps non-JSON text verbatim', () => {
    expect(presentToolResult('wrote 42 bytes')).toEqual({ text: 'wrote 42 bytes', lang: 'text' })
  })
})
