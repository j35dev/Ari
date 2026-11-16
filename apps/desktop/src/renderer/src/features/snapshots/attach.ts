import type { PendingSnapshot } from '../../../../shared/snapshots'
import { parseSessionViewKey } from '../session/session-scope'
import { readSessionDraftIntent, updateSessionDraftIntent } from '../composer/draft-recovery-store'
import { appendImageFiles, MAX_IMAGE_BYTES, snapshotFile } from '../composer/useImageAttachments'
import { markSnapshotArrival, tagSnapshotFile } from './arrival'

export function attachSnapshot(
  item: PendingSnapshot & { dataBase64: string },
  target: string,
  preferences: { animation: boolean; sound: boolean },
): void {
  const previous = readSessionDraftIntent(target)
  if (previous.images.some((image) => image.snapshot?.id === item.id)) {
    if (previous.storageIssue) updateSessionDraftIntent(target, (current) => ({ ...current }))
    if (readSessionDraftIntent(target).storageIssue)
      throw new Error(
        'Save the draft before attaching this capture. Free browser storage and try again.',
      )
    return
  }
  const file = snapshotFile(
    item.dataBase64,
    item.attachment.name,
    item.attachment.mimeType,
    item.capturedAt,
  )
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error('The captured image is too large to attach.')
  const next = appendImageFiles(previous.images, [file])
  const added = next.find((image) => image.file === file)
  if (!added)
    throw new Error(
      'Remove an attached image to make room. Your SnapShot is saved and will attach when a slot opens.',
    )
  // Remote sessions stage on their own host when Send is pressed. Their local
  // receipt only restores the File and never becomes a remote attachment id.
  const remote = parseSessionViewKey(target)?.kind === 'remote'
  added.ref = remote || target.startsWith('project-draft:') ? undefined : item.attachment
  added.snapshot = { id: item.id, localRef: item.attachment, capturedAt: item.capturedAt }
  tagSnapshotFile(file, item.id)
  if (!item.desktopFeedback)
    markSnapshotArrival(file, { ...preferences, capturedAt: item.capturedAt })
  updateSessionDraftIntent(target, (current) => ({ ...current, images: next }))
  if (readSessionDraftIntent(target).storageIssue)
    throw new Error(
      'The capture is saved, but the draft could not be persisted. Free browser storage and try again.',
    )
}
