/**
 * Exit-code decoding for npm-launched processes (comet #95): npm encodes
 * fatal fs errors as `256 − errno` exit codes and frequently prints nothing,
 * so a missing adapter surfaces as a bare `exit 254`. Decoding turns those
 * into legible guidance. Source: npm/cli#4838.
 */
const NPM_FS_ERRORS: Record<number, string> = {
  1: 'permission denied while executing (EPERM)',
  2: 'the package entry point or binary was not found on disk (ENOENT)',
  13: 'permission denied reading files or directories (EACCES)',
  17: 'the target already exists where npm expected to create it (EEXIST)',
  20: 'a path segment expected to be a directory was not (ENOTDIR)',
  21: 'expected a directory but found a file (EISDIR)',
  28: 'no space left on device (ENOSPC)',
  36: 'the resolved path exceeds the filesystem name limit (ENAMETOOLONG)',
}

/** Human phrase for an npm-style fatal exit, or null when not npm-decodable. */
export function describeNpmExit(code: number): string | null {
  if (code < 200 || code > 255) return null
  const errno = 256 - code
  const phrase = NPM_FS_ERRORS[errno]
  return phrase ?? `an npm filesystem error (errno ${errno})`
}

/**
 * Full explanation appended to CLI failure messages. Empty for clean/unknown
 * exits; decodes npm-style codes only when the process was npx-launched so
 * ordinary CLIs exiting with high codes are not misattributed.
 */
export function explainExitCode(code: number | null, viaNpx: boolean): string {
  if (code === null || code === 0) return ''
  if (viaNpx) {
    const phrase = describeNpmExit(code)
    if (phrase !== null) {
      return (
        ` (exit ${code} — npx failed before the agent started: ${phrase}. ` +
        'Check that Node/npm work in a terminal and retry.)'
      )
    }
  }
  return ` (exit ${code})`
}
