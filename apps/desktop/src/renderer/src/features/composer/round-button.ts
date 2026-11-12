/**
 * The composer's one round control: send, stop, and "finish dictation" are
 * the same 32px circle in different states.
 *
 * - `ink`: the action is ready (something to send, a turn to stop, a
 *   recording to finish). Ink on paper, like every primary action.
 * - `wash`: available, but not the primary action of the moment.
 * - `idle`: nothing to do yet.
 */
export type RoundButtonTone = 'ink' | 'wash' | 'idle'

const BASE =
  'relative inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none'

const TONES: Record<RoundButtonTone, string> = {
  ink: 'bg-fg text-bg hover:bg-fg/90',
  wash: 'bg-fg/10 text-fg hover:bg-fg/15',
  idle: 'bg-fg/10 text-fg-subtle',
}

export function roundButton(tone: RoundButtonTone): string {
  return `${BASE} ${TONES[tone]}`
}
