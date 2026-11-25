import { createContext } from 'react'

/**
 * What the transcript's running turn is doing, for the working indicator's
 * word: "Thinking" before anything shows, "Working" through tools, "Writing"
 * while the reply streams. `null` when the live row already says it (a live
 * thought reads "Thinking" itself), so the indicator shows only the time.
 * `undefined` outside a transcript, where the indicator keeps its own words.
 */
export type WorkingPhase = 'Thinking' | 'Working' | 'Writing' | null

export const WorkingPhaseContext = createContext<WorkingPhase | undefined>(undefined)
