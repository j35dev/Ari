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

import { highlightCode } from './highlight'

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
