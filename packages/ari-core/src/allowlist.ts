/**
 * Permission allowlist for Ari Core built-in tools. Rules pair a tool name
 * with a glob-style pattern evaluated against a tool-specific candidate
 * string (the bash command, the file path, or the tool name itself).
 */

export interface AllowRule {
  tool: string
  pattern: string
}

/** Tools whose candidate is a workspace-relative path argument. */
const PATH_TOOLS = new Set(['read', 'write', 'edit'])

/**
 * Derives the string a rule pattern is matched against for a tool call.
 * bash → the command; file tools → the path; everything else → the tool name.
 */
function candidateFor(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash') {
    return typeof args['command'] === 'string' ? args['command'] : ''
  }
  if (PATH_TOOLS.has(toolName)) {
    return typeof args['path'] === 'string' ? args['path'] : ''
  }
  return toolName
}

/**
 * Tiny dependency-free glob matcher supporting `*` (any run of characters
 * except path separators) and `**` (any run of characters, including path
 * separators). Backslashes are normalized to `/` on both sides so patterns
 * are portable across platforms. All other characters match literally.
 */
export function compileGlob(pattern: string, candidate: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/')
  const pat = normalize(pattern)
  const cand = normalize(candidate)
  let source = ''
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === undefined) break
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        while (pat[i + 1] === '*') i++
        source += '.*'
      } else {
        source += '[^/]*'
      }
      continue
    }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(cand)
}

/**
 * True when at least one rule for `toolName` matches the call. Malformed
 * `argsJson` is treated as empty arguments (safe: file/bash candidates
 * degrade to '' and only match patterns that accept empty strings).
 */
export function matchesAllowlist(
  toolName: string,
  argsJson: string,
  rules: AllowRule[],
): boolean {
  const scoped = rules.filter((r) => r.tool === toolName)
  if (scoped.length === 0) return false
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    args = {}
  }
  const candidate = candidateFor(toolName, args)
  return scoped.some((r) => compileGlob(r.pattern, candidate))
}
