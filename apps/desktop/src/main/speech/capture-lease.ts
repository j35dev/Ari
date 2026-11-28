import { randomUUID } from 'node:crypto'

/** Shared by every renderer and shortcut; held through transcription and insertion. */
export class CaptureLease {
  private token: string | null = null
  get busy(): boolean {
    return this.token !== null
  }
  acquire(token: string = randomUUID()): string {
    if (this.busy) throw new Error('Another dictation is active. Stop or cancel it first.')
    return (this.token = token)
  }
  current(token: string): boolean {
    return this.token === token
  }
  release(token: string): void {
    if (this.current(token)) this.token = null
  }
  reset(): void {
    this.token = null
  }
}
