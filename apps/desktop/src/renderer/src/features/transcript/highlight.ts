import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from 'shiki'

/**
 * Shiki highlighting for transcript code blocks (PLAN §6.5: highlighter warmed
 * once). The pool is created lazily on first use and reused for every block;
 * languages are loaded on demand from the bundled grammars.
 */

const THEMES = { light: 'github-light', dark: 'github-dark' } as const

const CACHE_MAX = 200

let pool: Promise<Highlighter> | null = null

function getPool(): Promise<Highlighter> {
  pool ??= createHighlighter({ themes: [...Object.values(THEMES)], langs: [] })
  return pool
}

const cache = new Map<string, string>()

function cacheSet(key: string, html: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, html)
}

/** Which bundled theme is the default color source, per the active app theme. */
function defaultColor(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'porcelain' ? 'light' : 'dark'
}

/**
 * Highlights `code` tagged as `lang`, returning full Shiki `<pre>` markup.
 * Returns null when the language is unknown or highlighting fails; callers fall
 * back to plain rendering. Results are memoized per (lang, code), capped at 200
 * entries.
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const key = `${lang}\u0000${code}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  if (!(lang in bundledLanguages)) return null
  const languageInput = bundledLanguages[lang as BundledLanguage]

  try {
    const pool = await getPool()
    await pool.loadLanguage(languageInput)
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
