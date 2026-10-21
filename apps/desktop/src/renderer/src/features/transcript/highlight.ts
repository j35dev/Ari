import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'

/**
 * Shiki highlighting for transcript code blocks (PLAN §6.5: highlighter warmed
 * once). The pool is created lazily on first use and reused for every block;
 * languages are loaded on demand from the bundled grammars.
 */

const THEMES = { light: 'github-light', dark: 'github-dark' } as const

/**
 * Highlight cache bounds. A long session holds hundreds of code blocks, and
 * every one that falls out is re-tokenized when it scrolls back in, so the
 * cache is sized by what it holds rather than a small entry count.
 */
const CACHE_MAX_ENTRIES = 2_000
const CACHE_MAX_CHARS = 16_000_000

let pool: Promise<Highlighter> | null = null

/** The warmed highlighter and the languages it holds, once a first highlight resolved. */
let warm: Highlighter | null = null
const warmLanguages = new Set<string>()

function getPool(): Promise<Highlighter> {
  pool ??= createHighlighter({ themes: [...Object.values(THEMES)], langs: [] })
  return pool
}

const cache = new Map<string, string>()
let cacheChars = 0

/** A hit moves to the young end, so a block read often outlives a burst of new ones. */
function cacheGet(key: string): string | undefined {
  const html = cache.get(key)
  if (html !== undefined) {
    cache.delete(key)
    cache.set(key, html)
  }
  return html
}

function cacheSet(key: string, html: string): void {
  const before = cache.get(key)
  if (before !== undefined) {
    cache.delete(key)
    cacheChars -= key.length + before.length
  }
  cache.set(key, html)
  cacheChars += key.length + html.length
  for (const [oldKey, oldHtml] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheChars <= CACHE_MAX_CHARS) break
    if (oldKey === key) break
    cache.delete(oldKey)
    cacheChars -= oldKey.length + oldHtml.length
  }
}

/** Which bundled theme is the default color source. Ari is dark-only. */
function defaultColor(): 'light' | 'dark' {
  return 'dark'
}

/**
 * Extracts the highlighted spans from Shiki's `<pre>` wrapper for injection
 * into an existing code element, letting callers keep their own surface
 * styling instead of Shiki's theme background.
 */
export function shikiInner(html: string): string {
  return /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? html
}

/**
 * Highlights `code` tagged as `lang`, returning full Shiki `<pre>` markup.
 * Returns null when the language is unknown or highlighting fails; callers fall
 * back to plain rendering. Results are memoized per (lang, code) in an LRU
 * bounded by entry count and size.
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\u0000${code}`
  const cached = cacheGet(key)
  if (cached !== undefined) return cached

  if (!(lang in bundledLanguages)) return null
  const languageInput = bundledLanguages[lang as BundledLanguage]

  try {
    const pool = await getPool()
    await pool.loadLanguage(languageInput)
    warm = pool
    warmLanguages.add(lang)
    const html = pool.codeToHtml(code, {
      lang,
      themes: THEMES,
      defaultColor: defaultColor(),
    })
    cacheSet(key, html)
    return html
  } catch {
    return null
  }
}

/** The dual-theme options every highlight in the transcript shares. */
export const HIGHLIGHT_THEME_OPTIONS = { themes: THEMES, defaultColor: defaultColor() }

/** The warmed highlighter when it already holds `lang`; null until it does. */
export function warmHighlighter(lang: string): Highlighter | null {
  return warm !== null && warmLanguages.has(lang) ? warm : null
}

/**
 * Highlights without yielding, for code that is still being written: waiting a
 * tick would paint each flush plain before its colors arrive. Answers from the
 * cache, or — with `compute` — from the warmed highlighter when it already
 * holds `lang`. Null means the caller has to wait on {@link highlightCode}.
 *
 * Computed results are not cached: a streaming block asks once per flush with
 * text that never repeats.
 */
export function highlightCodeSync(code: string, lang: string, compute: boolean): string | null {
  const cached = cacheGet(`${lang}\u0000${code}`)
  if (cached !== undefined) return cached
  if (!compute || warm === null || !warmLanguages.has(lang)) return null
  try {
    return warm.codeToHtml(code, { lang, themes: THEMES, defaultColor: defaultColor() })
  } catch {
    return null
  }
}
