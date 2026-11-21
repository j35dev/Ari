import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame } from '@ari/contracts/rpc'
import { runInstall, DEFAULT_TIMEOUT_MS, type InstallHandle } from '@ari/providers/install'
import { installFailureReason, installPhase, verifyInstall } from '@ari/providers/updates'
import type { Detection } from '@ari/providers/types'
import type { InstallPlan } from '@ari/providers/package-manager'

type Operation = 'install' | 'upgrade'
type PhaseFrame = Extract<ProvidersUpdateFrame, { type: 'install.phase' }>
type SettledFrame = Extract<ProvidersUpdateFrame, { type: 'install.settled' }>

/** Background probes are readers too: Windows holds their executable open. */
export class ProviderProbes {
  readonly #active = new Map<DriverKind, number>()

  busy(kind: DriverKind): boolean {
    return (this.#active.get(kind) ?? 0) > 0
  }

  async run<T>(kind: DriverKind, probe: () => Promise<T>): Promise<T> {
    this.#active.set(kind, (this.#active.get(kind) ?? 0) + 1)
    try {
      return await probe()
    } finally {
      const remaining = (this.#active.get(kind) ?? 1) - 1
      if (remaining === 0) this.#active.delete(kind)
      else this.#active.set(kind, remaining)
    }
  }
}

export interface ProviderUpdatesDeps {
  prepare: (
    kind: DriverKind,
  ) => Promise<{ before: Detection | undefined; plan: InstallPlan | null; env: NodeJS.ProcessEnv }>
  busy: (kind: DriverKind) => Promise<boolean>
  release: (kind: DriverKind) => Promise<void>
  detect: (kind: DriverKind) => Promise<Detection | undefined>
  publish: (frame: ProvidersUpdateFrame) => void
  updated: () => void
  run?: typeof runInstall
  wait?: (ms: number) => Promise<void>
}

interface PendingUpdate {
  kind: DriverKind
  operation: Operation
  phase: PhaseFrame
  cancelled: boolean
  handle?: InstallHandle
  details: string
  before?: Detection
  lockProbes?: boolean
}

/** One queue across windows and entry points; reserve synchronously before any async work. */
export class ProviderUpdates {
  readonly #deps: ProviderUpdatesDeps
  readonly #pending = new Map<DriverKind, PendingUpdate>()
  readonly #settled = new Map<DriverKind, SettledFrame>()
  #active: DriverKind | null = null
  #draining = false

  constructor(deps: ProviderUpdatesDeps) {
    this.#deps = deps
  }

  start(kind: DriverKind, operation: Operation): { started: boolean; reason?: string } {
    if (this.#pending.has(kind))
      return { started: false, reason: 'An operation is already running for this provider.' }
    const entry: PendingUpdate = {
      kind,
      operation,
      cancelled: false,
      details: '',
      phase: {
        type: 'install.phase',
        kind,
        phase: 'queued',
        message: 'Waiting for the previous update to finish.',
      },
    }
    this.#settled.delete(kind)
    this.#pending.set(kind, entry)
    this.#deps.publish({ type: 'install.started', kind, operation })
    this.#deps.publish(entry.phase)
    void this.#drain()
    return { started: true }
  }

  /** The head of the queue pauses new turns while existing turns drain. */
  unavailable(kind: DriverKind): string | null {
    return this.#active === kind ? 'This provider is updating. Try again shortly.' : null
  }

  installing(kind: DriverKind): boolean {
    return this.#pending.get(kind)?.lockProbes === true
  }

  verifying(kind: DriverKind): boolean {
    return this.#pending.get(kind)?.phase.phase === 'verifying'
  }

  preservedDetection(kind: DriverKind): Detection | undefined {
    return this.#pending.get(kind)?.before
  }

  snapshot(): ProvidersUpdateFrame[] {
    return [
      ...this.#settled.values(),
      ...[...this.#pending.values()].flatMap((entry): ProvidersUpdateFrame[] => [
        { type: 'install.started', kind: entry.kind, operation: entry.operation },
        entry.phase,
        ...(entry.details
          ? [
              {
                type: 'install.progress' as const,
                kind: entry.kind,
                stream: 'stdout' as const,
                text: entry.details,
              },
            ]
          : []),
      ]),
    ]
  }

  async cancel(kind: DriverKind): Promise<{ cancelled: boolean }> {
    const entry = this.#pending.get(kind)
    if (!entry) return { cancelled: false }
    entry.cancelled = true
    if (entry.handle) await entry.handle.cancel()
    else if (this.#active !== kind)
      this.#finish(entry, false, 'The update was cancelled. Retry when ready.', null, false)
    return { cancelled: true }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#pending.keys()].map((kind) => this.cancel(kind)))
  }

  #phase(entry: PendingUpdate, phase: PhaseFrame['phase'], message: string): void {
    entry.phase = { type: 'install.phase', kind: entry.kind, phase, message }
    this.#deps.publish(entry.phase)
  }

  #finish(
    entry: PendingUpdate,
    ok: boolean,
    reason: string | null,
    version: string | null,
    truncated: boolean,
  ): void {
    const frame: SettledFrame = {
      type: 'install.settled',
      kind: entry.kind,
      operation: entry.operation,
      ok,
      reason,
      version,
      truncated,
      details: entry.details,
    }
    this.#pending.delete(entry.kind)
    this.#settled.set(entry.kind, frame)
    this.#deps.publish(frame)
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      for (const entry of this.#pending.values()) {
        this.#active = entry.kind
        try {
          await this.#update(entry)
        } catch (error) {
          entry.details = `${entry.details}\n${String(error)}`.slice(-10_240)
          this.#finish(
            entry,
            false,
            installFailureReason(
              entry.details,
              'The update could not be verified. Retry to check again.',
            ),
            null,
            false,
          )
        } finally {
          this.#active = null
        }
      }
    } finally {
      this.#draining = false
    }
  }

  async #update(entry: PendingUpdate): Promise<void> {
    const { kind, operation } = entry
    const wait =
      this.#deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    while (!entry.cancelled && (await this.#deps.busy(kind))) {
      if (entry.phase.phase !== 'waiting')
        this.#phase(entry, 'waiting', 'Will update when the current turns finish.')
      await wait(500)
    }
    if (entry.cancelled) {
      this.#finish(entry, false, 'The update was cancelled. Retry when ready.', null, false)
      return
    }
    this.#phase(entry, 'preparing', 'Checking the install channel and closing idle CLI processes…')
    const { before, plan, env } = await this.#deps.prepare(kind)
    entry.before = before
    if (entry.cancelled) {
      this.#finish(
        entry,
        false,
        'The update was cancelled. Retry when ready.',
        before?.version ?? null,
        false,
      )
      return
    }
    if (!plan) {
      this.#finish(
        entry,
        false,
        'Ari could not identify this install channel. Update this CLI in a terminal, or choose another install in Settings.',
        before?.version ?? null,
        false,
      )
      return
    }
    // Freeze new version checks before awaiting readers that started during preparation.
    entry.lockProbes = true
    while (!entry.cancelled && (await this.#deps.busy(kind))) {
      this.#phase(entry, 'waiting', 'Waiting for background CLI checks to finish…')
      await wait(500)
    }
    if (entry.cancelled) {
      this.#finish(
        entry,
        false,
        'The update was cancelled. Retry when ready.',
        before?.version ?? null,
        false,
      )
      return
    }
    await this.#deps.release(kind)
    if (entry.cancelled) {
      this.#finish(
        entry,
        false,
        'The update was cancelled. Retry when ready.',
        before?.version ?? null,
        false,
      )
      return
    }
    this.#phase(
      entry,
      'installing',
      `Running the ${plan.manager === 'native' ? 'vendor updater' : `${plan.manager} updater`}…`,
    )
    const argv = operation === 'install' ? plan.installCommand : plan.upgradeCommand
    entry.details = `$ ${argv.join(' ')}\n`
    let exitCode: number | null = null
    let failure: string | null = null
    let truncated = false
    entry.handle = (this.#deps.run ?? runInstall)(
      argv,
      (event) => {
        if (event.type === 'progress') {
          entry.details = `${entry.details}${event.line.text}\n`.slice(-10_240)
          const phase = installPhase(event.line.text)
          if (phase && phase !== entry.phase.phase)
            this.#phase(
              entry,
              phase,
              phase === 'downloading' ? 'Downloading the update…' : 'Installing the update…',
            )
          this.#deps.publish({
            type: 'install.progress',
            kind,
            stream: event.line.stream,
            text: event.line.text,
          })
        } else if (event.type === 'failed') failure = event.reason
        else if (event.type === 'exit') {
          exitCode = event.code
          truncated = event.truncated
          if (event.timedOut) failure = 'Timed out after 15 minutes.'
        }
      },
      { env, timeoutMs: DEFAULT_TIMEOUT_MS },
    )
    await entry.handle.done
    entry.lockProbes = false
    this.#phase(entry, 'verifying', 'Checking the installed CLI version…')
    if (entry.cancelled) failure = 'Cancelled'
    if (failure) entry.details = `${entry.details}\n${failure}`.slice(-10_240)
    const { outcome, after } = await verifyInstall(
      { operation, exitCode, failure, before },
      () => this.#deps.detect(kind),
      wait,
    )
    if (outcome.ok) this.#deps.updated()
    const reason = outcome.ok
      ? null
      : installFailureReason(entry.details, outcome.reason ?? undefined)
    this.#finish(entry, outcome.ok, reason, after?.version ?? null, truncated)
  }
}
