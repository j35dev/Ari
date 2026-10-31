/**
 * Thresholds that turn a large plain-text paste into a workspace file: a
 * 32 KiB paste is already a document rather than a message, and a draft past
 * {@link PASTE_DRAFT_MAX_CHARS} characters risks provider-side truncation.
 */
export const PASTE_FILE_MIN_BYTES = 32 * 1024
export const PASTE_DRAFT_MAX_CHARS = 120_000

/** Workspace-relative directory the paste files land in. */
export const PASTE_DIR = '.ari/pastes'

/** Workspace-relative path for one paste file. */
export function pasteFilePath(id: string): string {
  return `${PASTE_DIR}/${id}.txt`
}

/** Unique file id for one paste; UUID when available, fallback otherwise. */
export function createPasteId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef != null && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID()
  }
  return `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** UTF-8 byte length of `text` (the paste threshold is measured in bytes). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface PasteFileDecision {
  /** Pasted plain text. */
  pasted: string
  /** Draft before the paste lands. */
  draft: string
  /** Selection range the paste replaces. */
  selectionStart: number
  selectionEnd: number
  /** Ctrl+Shift / Cmd+Shift was held: the user asked for an inline paste. */
  forceInline: boolean
  /** Unique id for the paste file name. */
  id: string
}

export type PasteFileOutcome =
  | { action: 'inline' }
  | { action: 'file'; path: string; content: string }

/**
 * Decides whether a plain-text paste stays inline or becomes a workspace
 * file. Modifier bypass wins outright; otherwise the paste becomes a file
 * when it reaches {@link PASTE_FILE_MIN_BYTES} or the draft, with the
 * selection replaced by the paste, would pass {@link PASTE_DRAFT_MAX_CHARS}.
 */
export function decidePasteFile(input: PasteFileDecision): PasteFileOutcome {
  if (input.forceInline) return { action: 'inline' }
  const end = Math.max(input.selectionStart, input.selectionEnd)
  const draftAfter =
    input.draft.slice(0, input.selectionStart) + input.pasted + input.draft.slice(end)
  const becomesFile =
    utf8ByteLength(input.pasted) >= PASTE_FILE_MIN_BYTES ||
    draftAfter.length > PASTE_DRAFT_MAX_CHARS
  if (!becomesFile) return { action: 'inline' }
  return { action: 'file', path: pasteFilePath(input.id), content: input.pasted }
}
