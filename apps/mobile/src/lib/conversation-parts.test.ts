import { describe, expect, it } from 'vitest'
import type { MessagePart } from '@ari/contracts/message'
import { conversationBlocks, conversationParts } from './conversation-parts'
import { renderMarkdown } from './markdown'

const text = (value: string): MessagePart => ({ type: 'text', text: value })
const thinking = (value: string): MessagePart => ({ type: 'thinking', text: value })
const call: MessagePart = {
  type: 'tool-call',
  callId: 'call_1',
  name: 'read_file',
  argsJson: '{"path":"src/app.ts"}',
}
const result: MessagePart = {
  type: 'tool-result',
  callId: 'call_1',
  resultJson: '"File loaded"',
  isError: false,
}
const image: MessagePart = {
  type: 'image',
  attachmentId: 'image_1',
  name: 'preview.png',
  mimeType: 'image/png',
  size: 128,
}

describe('conversationParts', () => {
  it('renders word and token deltas as one flowing paragraph', () => {
    const presentation = conversationParts(['The', ' ', 'agent', ' is', ' working', '.'].map(text))
    expect(presentation.parts).toEqual([{ sourceIndex: 0, part: text('The agent is working.') }])
    expect(presentation.copyText).toBe('The agent is working.')
    expect(renderMarkdown(presentation.copyText)).toBe('<p>The agent is working.</p>')
  })

  it('reassembles Markdown code fences split across streamed chunks', () => {
    const chunks = ['`', '``', 'ts', '\n', 'const', ' value', ' =', ' 1', '\n', '`', '``']
    const presentation = conversationParts(chunks.map(text))
    expect(presentation.parts).toEqual([
      { sourceIndex: 0, part: text('```ts\nconst value = 1\n```') },
    ])
    expect(renderMarkdown(presentation.copyText)).toContain(
      '<pre><code class="language-ts">const value = 1\n</code></pre>',
    )
  })

  it('preserves recorded spacing, paragraphs, tabs, and line endings exactly', () => {
    const chunks = ['  Heading\r', '\n\r\n', '\tIndented', '  text', '\n', '\nTrailing  ']
    const presentation = conversationParts(chunks.map(text))
    expect(presentation.copyText).toBe(chunks.join(''))
    expect(presentation.parts[0]?.part).toEqual(text(chunks.join('')))
  })

  it('never invents spaces between chunks that form a single word', () => {
    expect(conversationParts(['con', 'nec', 'tion'].map(text)).copyText).toBe('connection')
  })

  it('keeps text before and after tool calls and results in separate ordered runs', () => {
    const presentation = conversationParts([
      text('Reading'),
      text(' file.\n'),
      call,
      result,
      text('\nFound'),
      text(' the bug.'),
    ])
    expect(presentation.parts).toEqual([
      { sourceIndex: 0, part: text('Reading file.\n') },
      { sourceIndex: 2, part: call },
      { sourceIndex: 3, part: result },
      { sourceIndex: 4, part: text('\nFound the bug.') },
    ])
    expect(presentation.copyText).toBe('Reading file.\n\nFound the bug.')
  })

  it('coalesces thinking separately and keeps text and reasoning boundaries', () => {
    const presentation = conversationParts([
      thinking('Check '),
      thinking('the state.'),
      text('I '),
      text('found it.'),
      thinking(' Verify.'),
      text(' Fixed.'),
    ])
    expect(presentation.parts).toEqual([
      { sourceIndex: 0, part: thinking('Check the state.') },
      { sourceIndex: 2, part: text('I found it.') },
      { sourceIndex: 4, part: thinking(' Verify.') },
      { sourceIndex: 5, part: text(' Fixed.') },
    ])
    expect(presentation.copyText).toBe('I found it. Fixed.')
  })

  it('retains each image and prevents text or reasoning from merging across it', () => {
    const presentation = conversationParts([
      text('Preview:'),
      image,
      image,
      text('Looks '),
      text('correct.'),
      thinking('One'),
      image,
      thinking('two'),
    ])
    expect(presentation.parts.map(({ part }) => part.type)).toEqual([
      'text',
      'image',
      'image',
      'text',
      'thinking',
      'image',
      'thinking',
    ])
    expect(presentation.parts[3]).toEqual({ sourceIndex: 3, part: text('Looks correct.') })
    expect(presentation.copyText).toBe('Preview:Looks correct.')
  })

  it('preserves the first source index as a run grows during streaming', () => {
    const before = conversationParts([call, text('Hel')])
    const after = conversationParts([call, text('Hel'), text('lo'), text('!')])
    expect(before.parts[1]?.sourceIndex).toBe(1)
    expect(after.parts[1]).toEqual({ sourceIndex: 1, part: text('Hello!') })
  })

  it('keeps empty chunks without inserting blank paragraphs between deltas', () => {
    expect(conversationParts([text(''), text('hello'), text('')])).toEqual({
      parts: [{ sourceIndex: 0, part: text('hello') }],
      copyText: 'hello',
    })
  })

  it('does not mutate frozen journal parts when building the presentation', () => {
    const source = Object.freeze([
      Object.freeze(text('Hel')),
      Object.freeze(text('lo')),
      Object.freeze(call),
    ])
    expect(conversationParts(source).parts[0]?.part).toEqual(text('Hello'))
    expect(source).toEqual([text('Hel'), text('lo'), call])
  })

  it('does not copy reasoning, tool payloads, or attachment names', () => {
    expect(conversationParts([thinking('Private reasoning'), call, result, image]).copyText).toBe(
      '',
    )
  })

  it('returns an empty presentation for an empty message', () => {
    expect(conversationParts([])).toEqual({ parts: [], copyText: '' })
  })
})

describe('conversationBlocks', () => {
  it('groups ordered activity runs without crossing text or image boundaries', () => {
    const presentation = conversationParts([
      text('Before'),
      thinking('Look'),
      thinking(' now'),
      call,
      result,
      text('After'),
      image,
      call,
      result,
      text('End'),
    ])
    expect(conversationBlocks(presentation.parts)).toEqual([
      { kind: 'content', sourceIndex: 0, part: text('Before') },
      {
        kind: 'activity',
        sourceIndex: 1,
        parts: [
          { sourceIndex: 1, part: thinking('Look now') },
          { sourceIndex: 3, part: call },
          { sourceIndex: 4, part: result },
        ],
      },
      { kind: 'content', sourceIndex: 5, part: text('After') },
      { kind: 'content', sourceIndex: 6, part: image },
      {
        kind: 'activity',
        sourceIndex: 7,
        parts: [
          { sourceIndex: 7, part: call },
          { sourceIndex: 8, part: result },
        ],
      },
      { kind: 'content', sourceIndex: 9, part: text('End') },
    ])
    expect(presentation.copyText).toBe('BeforeAfterEnd')
  })

  it('retains the first activity source index when trailing stream activity grows', () => {
    const before = conversationBlocks(
      conversationParts([text('Checking'), text(' files.'), thinking('Look'), call]).parts,
    )
    const after = conversationBlocks(
      conversationParts([
        text('Checking'),
        text(' files.'),
        thinking('Look'),
        call,
        result,
        thinking('Verify '),
        thinking('results.'),
      ]).parts,
    )
    expect(before[1]).toMatchObject({ kind: 'activity', sourceIndex: 2 })
    expect(after[1]).toMatchObject({ kind: 'activity', sourceIndex: 2 })
    const activity = after[1]
    expect(
      activity?.kind === 'activity' ? activity.parts.map(({ part }) => part.type) : [],
    ).toEqual(['thinking', 'tool-call', 'tool-result', 'thinking'])
    expect(activity?.kind === 'activity' ? activity.parts.at(-1) : null).toEqual({
      sourceIndex: 5,
      part: thinking('Verify results.'),
    })
  })

  it('keeps images visible between separate activity groups', () => {
    const blocks = conversationBlocks(
      conversationParts([thinking('Review'), image, call, image, result]).parts,
    )
    expect(blocks.map(({ kind }) => kind)).toEqual([
      'activity',
      'content',
      'activity',
      'content',
      'activity',
    ])
    expect(blocks[1]).toEqual({ kind: 'content', part: image, sourceIndex: 1 })
    expect(blocks[3]).toEqual({ kind: 'content', part: image, sourceIndex: 3 })
  })

  it('honors empty text parts as explicit boundaries', () => {
    expect(
      conversationBlocks(conversationParts([call, text(''), result]).parts).map(({ kind }) => kind),
    ).toEqual(['activity', 'content', 'activity'])
  })

  it('does not mutate or append to frozen presentation parts', () => {
    const presentation = conversationParts([thinking('Check'), call, result, text('Done.')])
    const frozen = Object.freeze(
      presentation.parts.map((entry) =>
        Object.freeze({ ...entry, part: Object.freeze({ ...entry.part }) }),
      ),
    )
    const before = structuredClone(frozen)
    const first = conversationBlocks(frozen)
    const second = conversationBlocks(frozen)
    expect(frozen).toEqual(before)
    expect(first).toEqual(second)
    expect(first[0]).not.toBe(second[0])
    const firstActivity = first[0]
    const secondActivity = second[0]
    expect(firstActivity?.kind === 'activity' ? firstActivity.parts : null).not.toBe(
      secondActivity?.kind === 'activity' ? secondActivity.parts : null,
    )
  })

  it('can return a single activity block while an agent has not produced text yet', () => {
    const presentation = conversationParts([thinking('Inspecting'), call, result])
    expect(conversationBlocks(presentation.parts)).toEqual([
      { kind: 'activity', sourceIndex: 0, parts: presentation.parts },
    ])
    expect(presentation.copyText).toBe('')
  })

  it('does not introduce an activity block into an empty message', () => {
    expect(conversationBlocks([])).toEqual([])
  })
})
