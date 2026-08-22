const DEFAULT_LIMIT = 8

function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * Filter workspace paths for the @file mention popup. A path matches when the
 * query (case-insensitive) is a substring of it; matches rank basename-prefix
 * first, then path-prefix, then basename-substring, then any-substring, keeping
 * registry order within a tier. Empty query returns the first `limit` paths.
 */
export function matchSuggestions(
  paths: readonly string[],
  query: string,
  limit = DEFAULT_LIMIT,
): string[] {
  if (limit <= 0) return []
  const q = query.toLowerCase()
  if (q === '') return paths.slice(0, limit)
  const ranked: Array<{ path: string; tier: number; order: number }> = []
  for (let order = 0; order < paths.length; order++) {
    const path = paths[order]!
    const lower = path.toLowerCase()
    const base = basenameOf(lower)
    let tier = -1
    if (base.startsWith(q)) tier = 0
    else if (lower.startsWith(q)) tier = 1
    else if (base.includes(q)) tier = 2
    else if (lower.includes(q)) tier = 3
    if (tier !== -1) ranked.push({ path, tier, order })
  }
  return ranked
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.path)
}
