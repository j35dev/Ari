/**
 * Cross-surface requests to open a terminal tab (M21.3 run scripts, future
 * file-context actions). Module-level pub/sub with a one-shot queue so a
 * request fired before the TerminalView mounts still lands once it does.
 */

export interface TerminalTabRequest {
  /** Tab title, e.g. "my-app: dev". */
  title: string
  /** Working directory for the pty. */
  cwd: string
  /** Optional first command written into the shell after spawn. */
  command?: string
}

type Listener = (request: TerminalTabRequest) => void

let listener: Listener | null = null
const queued: TerminalTabRequest[] = []

/** Publishes a tab request; queued until a TerminalView is listening. */
export function requestTerminalTab(request: TerminalTabRequest): void {
  if (listener === null) {
    queued.push(request)
    return
  }
  listener(request)
}

/** TerminalView subscribes on mount; drains anything queued meanwhile. */
export function subscribeTerminalRequests(fn: Listener): () => void {
  listener = fn
  const pending = [...queued]
  queued.length = 0
  for (const request of pending) fn(request)
  return () => {
    if (listener === fn) listener = null
  }
}
