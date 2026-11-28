import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useToast } from '@ari/ui/toast'

const RecoveryContext = createContext<(text: string) => void>(() => undefined)

export function useKeepDictation() {
  return useContext(RecoveryContext)
}

/** Keeps the result accessible even when the composer is hidden or unmounted. */
export function DictationRecoveryProvider({ children }: { children: ReactNode }) {
  const { toast, update, dismiss } = useToast()
  const keep = useCallback(
    (text: string) => {
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(text)
          dismiss(id)
        } catch {
          update(id, { description: 'Couldn’t copy the text. Try copying again.' })
        }
      }
      const id = toast({
        title: 'Dictation kept for review',
        description: 'Couldn’t insert into the original field. Copy the text to paste it yourself.',
        durationMs: 0,
        dismissOnAction: false,
        action: {
          label: 'Copy text',
          onClick: () => void copy(),
        },
      })
    },
    [toast, dismiss, update],
  )
  return <RecoveryContext.Provider value={keep}>{children}</RecoveryContext.Provider>
}
