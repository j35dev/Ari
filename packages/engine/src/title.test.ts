import { describe, expect, it } from 'vitest'
import {
  MAX_TITLE_LENGTH,
  deriveSliceTitle,
  deterministicTitleStrategy,
  firstReply,
  generateAutoTitle,
  generateQualityTitle,
  isAutoTitle,
  replyText,
} from './title'
import type { TitleStrategy } from './title'
import type { Message } from '@ari/contracts/message'

describe('deriveSliceTitle', () => {
  it('keeps short single-line prompts verbatim', () => {
    expect(deriveSliceTitle('  fix the login bug  ')).toBe('fix the login bug')
  })

  it('slices the first line only and caps at 48 chars with an ellipsis', () => {
    const long = 'a'.repeat(80)
    expect(deriveSliceTitle(`${long}\nsecond line`)).toBe(`${'a'.repeat(47)}…`)
    expect(deriveSliceTitle(long).length).toBe(MAX_TITLE_LENGTH)
  })
})

describe('isAutoTitle', () => {
  it('matches the pristine default, empty, and the exact slice of the prompt', () => {
    const prompt = 'explain the event loop'
    expect(isAutoTitle('New session', prompt)).toBe(true)
    expect(isAutoTitle('', prompt)).toBe(true)
    expect(isAutoTitle('explain the event loop', prompt)).toBe(true)
  })

  it('never matches a manual rename or a slice of a different prompt', () => {
    expect(isAutoTitle('My own name', 'explain the event loop')).toBe(false)
    expect(isAutoTitle('explain the event loop', 'different prompt')).toBe(false)
  })
})

describe('generateQualityTitle', () => {
  it('returns null for empty, whitespace, and markdown-only prompts', () => {
    expect(generateQualityTitle('')).toBeNull()
    expect(generateQualityTitle('   \n\t  ')).toBeNull()
    expect(generateQualityTitle('```\nconst x = 1\n```')).toBeNull()
  })

  it('strips markdown decoration from the title', () => {
    expect(generateQualityTitle('# Fix **the** login bug in `src/auth.ts`')).toBe(
      'Fix the login bug in src/auth.ts',
    )
    expect(generateQualityTitle('- [docs](https://example.com) explain streaming')).toBe(
      'Docs explain streaming',
    )
  })

  it('takes the first sentence and drops leading filler words', () => {
    expect(generateQualityTitle('Hey, can you fix the login redirect loop? Also add tests.')).toBe(
      'Fix the login redirect loop',
    )
    expect(generateQualityTitle('Please help me refactor the parser module')).toBe(
      'Refactor the parser module',
    )
  })

  it('keeps the full prompt when it is one short plain sentence', () => {
    expect(generateQualityTitle('Add retry logic to the fetch client')).toBe(
      'Add retry logic to the fetch client',
    )
  })

  it('caps huge prompts at 48 characters with an ellipsis', () => {
    const title = generateQualityTitle(`implement ${'x'.repeat(500)}`)
    expect(title).not.toBeNull()
    expect(title?.length).toBe(MAX_TITLE_LENGTH)
    expect(title?.endsWith('…')).toBe(true)
  })

  it('falls back to the sentence when every word is filler', () => {
    expect(generateQualityTitle('Hi!')).toBe('Hi')
  })
})

describe('deterministicTitleStrategy', () => {
  it('exposes the quality title through the TitleStrategy extension point', async () => {
    await expect(
      deterministicTitleStrategy.generate({ prompt: '# ship\n\ncan you deploy staging now?', currentTitle: 'ship' }),
    ).resolves.toBe('Ship can you deploy staging now')
  })

  it('lets a custom strategy win and null keeps the current title', async () => {
    const llm: TitleStrategy = {
      generate: (request) =>
        Promise.resolve(request.prompt.includes('auth') ? 'Auth deep dive' : null),
    }
    await expect(llm.generate({ prompt: 'explain auth flow', currentTitle: 't' })).resolves.toBe(
      'Auth deep dive',
    )
    await expect(llm.generate({ prompt: 'unrelated', currentTitle: 'kept' })).resolves.toBeNull()
  })
})

describe('generateAutoTitle', () => {
  it('prefers a substantive assistant response over the prompt', () => {
    expect(generateAutoTitle('fix it', 'Fixed the login redirect loop.')).toBe(
      'Fixed the login redirect loop',
    )
  })

  it('falls back to the prompt when the response is a short ack', () => {
    expect(generateAutoTitle('can you fix the login redirect loop please', 'ok')).toBe(
      'Fix the login redirect loop please',
    )
    expect(generateAutoTitle('can you fix the login redirect loop please', '')).toBe(
      'Fix the login redirect loop please',
    )
  })

  it('falls back to the prompt when no response is given', () => {
    expect(generateAutoTitle('Add retry logic to the fetch client')).toBe(
      'Add retry logic to the fetch client',
    )
  })

  it('exposes the response through the bundled strategy', async () => {
    await expect(
      deterministicTitleStrategy.generate({
        prompt: 'fix it',
        response: 'Refactored the parser module to stream results.',
        currentTitle: 'fix it',
      }),
    ).resolves.toBe('Refactored the parser module to stream results')
  })
})

describe('replyText', () => {
  it('concatenates streamed deltas verbatim', () => {
    const deltas = ['I', "'ll", ' update', ' the', ' redirect', ' guard']
    expect(replyText(deltas.map((text) => ({ type: 'text', text })))).toBe(
      "I'll update the redirect guard",
    )
  })

  it('starts a new paragraph after a non-text part', () => {
    expect(
      replyText([
        { type: 'text', text: 'Reading the guard' },
        { type: 'tool-call', callId: 'c1', name: 'read', argsJson: '{}' },
        { type: 'tool-result', callId: 'c1', resultJson: '""', isError: false },
        { type: 'text', text: 'It skips' },
        { type: 'text', text: ' signed-in users.' },
      ]),
    ).toBe('Reading the guard\n\nIt skips signed-in users.')
  })

  it('leaves out error and notice banners', () => {
    expect(
      replyText([
        { type: 'text', text: '\n\n⚠ "gpt-9" is not offered by this agent.' },
        { type: 'text', text: 'Fixed the login redirect loop.' },
        { type: 'text', text: '\n\n⚠ Could not display chart.png.' },
      ]),
    ).toBe('Fixed the login redirect loop.')
  })
})

describe('firstReply', () => {
  const message = (role: Message['role'], turnId: string, parts: Message['parts']): Message => ({
    id: `msg_${turnId}_${role}`,
    sessionId: 's1',
    turnId,
    role,
    parts,
    createdAt: 0,
  })
  const text = (value: string): Message['parts'] => [{ type: 'text', text: value }]

  it("returns the completed turn's own reply", () => {
    const messages = [
      message('user', 't1', text('fix it')),
      message('assistant', 't1', text('Fixed the login redirect loop.')),
    ]
    expect(firstReply(messages, 't1')).toBe('Fixed the login redirect loop.')
  })

  it('looks past an earlier turn that only left a banner', () => {
    const messages = [
      message('user', 't1', text('fix it')),
      message('assistant', 't1', text('\n\n⚠ Not logged in · Please run /login')),
      message('user', 't2', text('try again')),
      message('assistant', 't2', text('Fixed the login redirect loop.')),
    ]
    expect(firstReply(messages, 't2')).toBe('Fixed the login redirect loop.')
  })

  it('yields nothing once an earlier turn was answered', () => {
    const messages = [
      message('user', 't1', text('add retries')),
      message('assistant', 't1', text('Added retry logic with exponential backoff.')),
      message('user', 't2', text('raise it')),
      message('assistant', 't2', text('Bumped the retry ceiling to five attempts.')),
    ]
    expect(firstReply(messages, 't2')).toBeUndefined()
  })

  it('yields nothing when the turn produced no assistant message', () => {
    expect(firstReply([message('user', 't1', text('fix it'))], 't1')).toBeUndefined()
  })
})
