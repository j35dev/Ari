import { describe, expect, it } from 'vitest'
import {
  MAX_TITLE_LENGTH,
  deriveSliceTitle,
  deterministicTitleStrategy,
  generateQualityTitle,
  isAutoTitle,
} from './title'
import type { TitleStrategy } from './title'

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
