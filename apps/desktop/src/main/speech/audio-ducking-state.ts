export interface OutputSession {
  id: string
  pid?: number
  excluded?: boolean
  read(): Promise<number[]>
  write(volume: number[]): Promise<void>
  release(): void
}

export interface OutputBackend {
  list(): Promise<{ sessions: OutputSession[]; complete: boolean }>
  dispose(): void
}

export interface DuckedVolume {
  id: string
  original: number[]
  applied: number[]
  userChanged?: boolean
}

export interface VolumeJournal {
  read(): Promise<DuckedVolume[]>
  write(entries: DuckedVolume[]): Promise<void>
}

const equal = (left: number[], right: number[]): boolean =>
  left.length === right.length &&
  left.every(
    (value, i) => Math.abs(value - right[i]!) <= Math.max(0.0001, Math.abs(value) * 0.00001),
  )

/** One baseline per playback stream; never multiply an already ducked level. */
export class DuckingState {
  private entries = new Map<string, DuckedVolume>()
  private active = false
  private initialized = false
  private running: Promise<void> | null = null
  private requested = false
  private saved: string | null = null

  get needsReconcile(): boolean {
    return this.active || this.entries.size > 0
  }

  constructor(
    private readonly backend: OutputBackend,
    private readonly journal: VolumeJournal,
    private readonly warn: (error: unknown) => void,
    private readonly factor = 0.25,
  ) {}

  setActive(active: boolean): Promise<void> {
    this.active = active
    return this.reconcile()
  }

  reconcile(): Promise<void> {
    this.requested = true
    this.running ??= this.drain().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.requested) {
      this.requested = false
      try {
        if (!this.initialized) {
          for (const entry of await this.journal.read()) this.entries.set(entry.id, entry)
          // Recover an earlier helper's writes before applying a new recording.
          await this.update(false)
          this.initialized = true
        }
        await this.update(this.active)
      } catch (error) {
        this.warn(error)
      }
    }
  }

  private async save(): Promise<void> {
    const entries = [...this.entries.values()]
    const snapshot = JSON.stringify(entries)
    if (snapshot === this.saved) return
    await this.journal.write(entries)
    this.saved = snapshot
  }

  private async update(active: boolean): Promise<void> {
    const { sessions, complete } = await this.backend.list()
    try {
      const present = new Set(sessions.map((session) => session.id))
      if (complete)
        for (const id of this.entries.keys()) if (!present.has(id)) this.entries.delete(id)
      for (const session of sessions) {
        try {
          const volume = await session.read()
          if (!volume.length || volume.some((value) => !Number.isFinite(value) || value < 0))
            continue
          const entry = this.entries.get(session.id)
          if (entry) {
            // Treat a volume-slider change as the user's choice for this capture.
            if (!equal(volume, entry.applied)) entry.userChanged = true
            if (!active || session.excluded) {
              if (!entry.userChanged) await session.write(entry.original)
              this.entries.delete(session.id)
            }
          } else if (active && this.active && !session.excluded) {
            const applied = volume.map((value) => value * this.factor)
            if (equal(volume, applied)) continue
            this.entries.set(session.id, { id: session.id, original: volume, applied })
            // Persist before touching audio, including a write that fails partway.
            await this.save()
            if (this.active) await session.write(applied)
          }
        } catch (error) {
          this.warn(error)
          // Keep the baseline: a transient device/session error gets a retry.
        }
      }
      await this.save()
    } finally {
      for (const session of sessions) session.release()
    }
  }

  async close(): Promise<void> {
    await this.setActive(false)
    // Allow a temporarily unavailable audio service to recover on shutdown.
    for (let attempt = 0; this.entries.size && attempt < 3; attempt++) await this.reconcile()
    this.backend.dispose()
  }
}
