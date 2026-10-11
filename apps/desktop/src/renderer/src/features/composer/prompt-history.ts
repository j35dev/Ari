/** Prompts worth recalling, oldest first: blanks dropped, back-to-back repeats collapsed. */
export function promptHistory(prompts: readonly string[]): string[] {
  const history: string[] = []
  for (const prompt of prompts) {
    const text = prompt.trim()
    if (text.length > 0 && history[history.length - 1] !== text) history.push(text)
  }
  return history
}

/**
 * One step through the history, shell style. `index` is the entry on screen,
 * or null while the field holds the user's own (empty) draft. Older from the
 * draft lands on the newest prompt; newer past the newest returns to the
 * draft. Returns null when there is nowhere to go, so the key keeps its
 * ordinary meaning.
 */
export function stepPromptHistory(
  history: readonly string[],
  index: number | null,
  direction: 'older' | 'newer',
): { index: number | null; text: string } | null {
  if (direction === 'older') {
    const next = index === null ? history.length - 1 : index - 1
    const text = history[next]
    return text === undefined ? null : { index: next, text }
  }
  if (index === null) return null
  const text = history[index + 1]
  return text === undefined ? { index: null, text: '' } : { index: index + 1, text }
}
