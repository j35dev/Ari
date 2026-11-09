import { describe, expect, it } from 'vitest'
import { splitVisualizations } from './markdown'

const body = '{"type":"metrics","title":"Count","items":[{"label":"Count","value":2}]}'
const fence = `\`\`\`ari-viz\n${body}\n\`\`\``
describe('visual reply extraction', () => {
  it('keeps the prose and multiple visuals in order', () => {
    const result = splitVisualizations(`Before\n\n${fence}\n\nBetween\n\n${fence}\n\nAfter`)
    expect(result.map((p) => p.kind)).toEqual([
      'markdown',
      'visualization',
      'markdown',
      'visualization',
      'markdown',
    ])
    expect(result[1]).toEqual({ kind: 'visualization', source: body, complete: true })
    expect(result.at(-1)).toEqual({ kind: 'markdown', text: '\n\nAfter' })
  })
  it.each([
    `\`\`\`\`markdown\n${fence}\n\`\`\`\``,
    fence
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    `- Example\n\n${fence
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}`,
    `\`\`\`json\n${body}\n\`\`\``,
    'Explain ari-viz in prose.',
  ])('leaves ordinary fences and quoted examples unchanged', (text) => {
    expect(splitVisualizations(text)).toEqual([{ kind: 'markdown', text }])
  })
  it('does not mistake JSON completion for a closed Markdown fence', () => {
    expect(splitVisualizations(`\`\`\`ari-viz\n${body}`)).toEqual([
      { kind: 'visualization', source: body, complete: false },
    ])
    expect(splitVisualizations(`\`\`\`\`ari-viz\n${body}\n\`\`\``)[0]).toMatchObject({
      complete: false,
    })
  })
  it('accepts longer closing fences, tilde fences, indentation, and CRLF', () => {
    expect(splitVisualizations(`   ~~~ari-viz\r\n${body}\r\n   ~~~~  `)[0]).toMatchObject({
      kind: 'visualization',
      complete: true,
    })
  })
  it('keeps reference definitions available on either side of a visual', () => {
    const result = splitVisualizations(`[ref]\n\n${fence}\n\n[ref]: https://example.com`)
    const first = result[0]
    if (first?.kind !== 'markdown') throw new Error('Expected prose before the visual')
    expect(first.text).toContain('[ref]: https://example.com')
  })
})
