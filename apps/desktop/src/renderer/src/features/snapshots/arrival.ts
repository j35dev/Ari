export interface SnapshotArrivalOptions {
  capturedAt: number
  animation: boolean
  sound: boolean
}
const arrivals = new WeakMap<File, SnapshotArrivalOptions>()
const snapshotIds = new WeakMap<File, string>()
export function tagSnapshotFile(file: File, id: string): void {
  snapshotIds.set(file, id)
}
export function snapshotFileId(file: File): string | undefined {
  return snapshotIds.get(file)
}
export function markSnapshotArrival(file: File, options: SnapshotArrivalOptions): void {
  arrivals.set(file, options)
}
export function takeSnapshotArrival(file: File): SnapshotArrivalOptions | undefined {
  const options = arrivals.get(file)
  arrivals.delete(file)
  return options
}

/** A quiet camera click, synthesized locally; never asks for an audio asset. */
export function playSnapshotSound(): void {
  try {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(900, context.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(340, context.currentTime + 0.06)
    gain.gain.setValueAtTime(0.025, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.085)
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.09)
    oscillator.onended = () => {
      void context.close()
    }
  } catch {
    /* Visual delivery remains available when audio is unavailable. */
  }
}
