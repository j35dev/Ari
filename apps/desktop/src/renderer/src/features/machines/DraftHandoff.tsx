import { useEffect, useRef } from 'react'
import { useDrafts } from '../composer/use-drafts'
import { updateSessionDraftIntent } from '../composer/draft-recovery-store'
import type { ComposerSeed } from '../composer/Composer'
/** Apply retained first-send content through the normal composer stores before opening it. */
export function DraftHandoff({ viewKey, seed, onApplied }: { viewKey: string; seed: ComposerSeed; onApplied: () => void }) {
  const { setDraft } = useDrafts(viewKey)
  const applied = useRef(false)
  useEffect(() => {
    if (applied.current) return
    applied.current = true
    setDraft(seed.text)
    if (seed.images) updateSessionDraftIntent(viewKey, (current) => ({ ...current, images: seed.images! }))
    onApplied()
  }, [viewKey, seed, setDraft, onApplied])
  return null
}
