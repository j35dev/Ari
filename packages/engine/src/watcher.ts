import { watch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { resolve } from 'node:path'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:watcher')

/** How long fs events are batched before onChange fires. */
export const WATCHER_DEBOUNCE_MS = 300

/**
 * Deepest folder level watched below a root: five nested folders, so files
 * with up to six path segments, the reach of the @-mention file index (its
 * only consumer). A huge repository must not stall the main process.
 */
export const WATCHER_MAX_DEPTH = 5

/**
 * Directory names ignored at any depth. Dot-entries (`.env`, `.vscode/`) are
 * additionally ignored at depth 1, and dot-directories at any depth (caches
 * such as `.cache/` or `.pnpm-store/`); nested dotfiles stay watchable.
 */
export const DEFAULT_IGNORED_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  // Toolchain output and dependency trees: Rust/Maven, Python, Go/PHP, Next, Turbo.
  'target',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  '.next',
  '.turbo',
  // .NET, Unity, CocoaPods, Gradle and Dart/Flutter output and caches.
  'bin',
  'obj',
  'Library',
  'Pods',
  '.gradle',
  '.dart_tool',
]

/**
 * The ignore rule shared by the watcher and the file index, for a path's
 * segments below its root. `isDirectory` is unknown when the caller has no
 * stats; everything inside an ignored folder is ignored either way.
 */
export function isIgnoredSegments(
  segments: readonly string[],
  ignoredNames: ReadonlySet<string>,
  isDirectory?: boolean,
): boolean {
  const name = segments[segments.length - 1] ?? ''
  if (segments.some((segment) => ignoredNames.has(segment))) return true
  if (name.startsWith('.') && (segments.length === 1 || isDirectory === true)) return true
  return segments.slice(0, -1).some((segment) => segment.startsWith('.'))
}

export interface WorkspaceWatcherEvents {
  /**
   * Debounced batch of changed paths (added / modified / removed), deduplicated
   * and sorted. Fires at most once per {@link WATCHER_DEBOUNCE_MS} of quiet.
   */
  onChange: (paths: string[]) => void
}

export interface WorkspaceWatcherOptions {
  events: WorkspaceWatcherEvents
  /** Override the batching window; defaults to {@link WATCHER_DEBOUNCE_MS}. */
  debounceMs?: number
}

export interface WatchRootOptions {
  /** Extra entry names ignored at any depth, merged with the defaults. */
  ignored?: string[]
}

/**
 * Watches one or more workspace roots with chokidar and delivers fs changes as
 * debounced batches, so bursts (branch switches, builds) cost one callback.
 * Re-adding an existing root is a no-op; {@link close} discards pending events
 * and is idempotent.
 */
export class WorkspaceWatcher {
  readonly #events: WorkspaceWatcherEvents
  readonly #debounceMs: number
  /** Normalized root keys (lower-cased on win32, matching ProjectStore). */
  readonly #roots = new Set<string>()
  readonly #rootDirs = new Map<string, string>()
  readonly #ignoredNames = new Set<string>(DEFAULT_IGNORED_NAMES)
  #fsWatcher: FSWatcher | null = null
  readonly #pending = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #closed = false

  constructor(options: WorkspaceWatcherOptions) {
    this.#events = options.events
    this.#debounceMs = options.debounceMs ?? WATCHER_DEBOUNCE_MS
  }

  /** Number of distinct roots currently being watched. */
  get rootCount(): number {
    return this.#roots.size
  }

  watch(rootPath: string, options: WatchRootOptions = {}): void {
    if (this.#closed) throw new Error('WorkspaceWatcher is closed')
    const root = resolve(rootPath)
    const key = this.#keyFor(root)
    if (this.#roots.has(key)) return
    for (const name of options.ignored ?? []) this.#ignoredNames.add(name)
    this.#roots.add(key)
    this.#rootDirs.set(key, root)
    if (this.#fsWatcher) {
      this.#fsWatcher.add(root)
    } else {
      this.#fsWatcher = watch(root, {
        ignoreInitial: true,
        persistent: true,
        depth: WATCHER_MAX_DEPTH,
        ignored: (candidate, stats) => this.#isIgnored(candidate, stats?.isDirectory()),
      })
      for (const event of ['add', 'change', 'unlink'] as const) {
        this.#fsWatcher.on(event, (path) => this.#schedule(path))
      }
    }
    log.info('watching workspace root', { root })
  }

  /**
   * Stops watching and discards any pending (not yet delivered) batch.
   * Safe to call more than once.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#pending.clear()
    const fsWatcher = this.#fsWatcher
    this.#fsWatcher = null
    this.#roots.clear()
    this.#rootDirs.clear()
    await fsWatcher?.close()
    log.debug('workspace watcher closed')
  }

  #keyFor(absolute: string): string {
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }

  /**
   * Ignore predicate shared with chokidar. Paths are matched against every
   * watched root; the roots themselves are never ignored. Chokidar hands the
   * predicate forward-slashed paths regardless of platform, so both sides are
   * normalized before comparing.
   */
  #isIgnored(candidate: string, isDirectory?: boolean): boolean {
    const normalized = candidate.replaceAll('\\', '/')
    for (const root of this.#rootDirs.values()) {
      const rootFwd = root.replaceAll('\\', '/')
      if (normalized === rootFwd) return false
      if (!normalized.startsWith(rootFwd + '/')) continue
      const segments = normalized.slice(rootFwd.length + 1).split('/')
      if (isIgnoredSegments(segments, this.#ignoredNames, isDirectory)) return true
    }
    return false
  }

  #schedule(path: string): void {
    if (this.#closed) return
    this.#pending.add(path)
    if (this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      const batch = [...this.#pending].sort()
      this.#pending.clear()
      try {
        this.#events.onChange(batch)
      } catch (error) {
        log.error('onChange callback failed', error)
      }
    }, this.#debounceMs)
  }
}
