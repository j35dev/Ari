import { beforeEach, describe, expect, it, vi } from 'vitest'

const shiki = vi.hoisted(() => {
  const codeToHtml = vi.fn(
    (code: string) =>
      `<pre class="shiki shiki-themes github-light github-dark"><code><span>${code}</span></code></pre>`,
  )
  const loadLanguage = vi.fn(async () => {})
  const createHighlighter = vi.fn(async () => ({ codeToHtml, loadLanguage }))
  return { codeToHtml, loadLanguage, createHighlighter }
})

vi.mock('shiki', () => ({
  bundledLanguages: { ts: () => Promise.resolve({}) },
  createHighlighter: shiki.createHighlighter,
}))

import { highlightCode, highlightCodeSync } from './highlight'

describe('highlightCode', () => {
  beforeEach(() => {
    shiki.codeToHtml.mockClear()
    shiki.loadLanguage.mockClear()
  })

  it('returns null for an unknown language without touching the pool', async () => {
    await expect(highlightCode('x = 1', 'notalang')).resolves.toBeNull()
    expect(shiki.createHighlighter).not.toHaveBeenCalled()
    expect(shiki.codeToHtml).not.toHaveBeenCalled()
  })

  it('highlights a known language with dual GitHub themes and the code text', async () => {
    const code = 'const a = "<b>";'
    const html = await highlightCode(code, 'ts')
    expect(html).toContain('shiki')
    expect(html).toContain(code)
    expect(shiki.codeToHtml).toHaveBeenCalledWith(code, {
      lang: 'ts',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: 'dark',
    })
    expect(shiki.loadLanguage).toHaveBeenCalledWith(expect.any(Function))
  })

  it('always highlights with the dark default color', async () => {
    const html = await highlightCode('let b = 2;', 'ts')
    expect(html).toContain('let b = 2;')
    expect(shiki.codeToHtml).toHaveBeenCalledWith(expect.anything(), {
      lang: 'ts',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: 'dark',
    })
  })

  it('serves repeated (lang, code) pairs from the cache', async () => {
    const code = 'export const n = 42;'
    const first = await highlightCode(code, 'ts')
    const second = await highlightCode(code, 'ts')
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(shiki.codeToHtml).toHaveBeenCalledTimes(1)
  })

  it('returns null when highlighting fails', async () => {
    shiki.codeToHtml.mockImplementationOnce(() => {
      throw new Error('grammar exploded')
    })
    await expect(highlightCode('broken', 'ts')).resolves.toBeNull()
  })
})

describe('highlightCodeSync', () => {
  beforeEach(() => {
    shiki.codeToHtml.mockClear()
  })

  it('answers from the cache without computing', async () => {
    const html = await highlightCode('const cached = 1', 'ts')
    shiki.codeToHtml.mockClear()

    expect(highlightCodeSync('const cached = 1', 'ts', false)).toBe(html)
    expect(shiki.codeToHtml).not.toHaveBeenCalled()
  })

  it('computes for a warmed language only when asked to', async () => {
    await highlightCode('warm the pool', 'ts')
    shiki.codeToHtml.mockClear()

    expect(highlightCodeSync('still streaming', 'ts', false)).toBeNull()
    expect(highlightCodeSync('still streaming', 'ts', true)).toContain('still streaming')
    expect(highlightCodeSync('still streaming', 'py', true)).toBeNull()
  })

  it('leaves streaming prefixes out of the cache', async () => {
    await highlightCode('warm the pool', 'ts')
    highlightCodeSync('a prefix that never repeats', 'ts', true)
    shiki.codeToHtml.mockClear()

    expect(highlightCodeSync('a prefix that never repeats', 'ts', false)).toBeNull()
  })
})
