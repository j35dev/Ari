import { existsSync } from 'node:fs'

export interface WorktreeRootsDeps {
  /** Names of the session directories on disk; a change means create/destroy. */
  sessionDirs: () => Promise<string[]>
  /** Declared managed-worktree paths of every session — the expensive walk. */
  collect: () => Promise<string[]>
}

/**
 * Memo of the managed-worktree roots the fs jail admits. Collecting them reads
 * every session's sidecar and folds each worktree session, which jailed RPCs
 * used to pay per call. The walk is reused until the set of session
 * directories changes or {@link WorktreeRoots.invalidate} runs (a session was
 * created); existence is still checked on every read, as before.
 */
export class WorktreeRoots {
  readonly #deps: WorktreeRootsDeps
  #cached: { key: string; roots: Promise<string[]> } | null = null

  constructor(deps: WorktreeRootsDeps) {
    this.#deps = deps
  }

  invalidate(): void {
    this.#cached = null
  }

  async get(): Promise<string[]> {
    const key = [...(await this.#deps.sessionDirs())].sort().join('\n')
    let cached = this.#cached
    if (cached?.key !== key) {
      const roots = this.#deps.collect()
      cached = { key, roots }
      this.#cached = cached
      const entry = cached
      void roots.catch(() => {
        if (this.#cached === entry) this.#cached = null
      })
    }
    return (await cached.roots).filter((root) => existsSync(root))
  }
}
