import type { ReactNode, Ref } from 'react'
import { Button } from '@ari/ui/button'

/**
 * The bottom of every step: an optional Back, optional quiet extras, and the
 * step's one primary action. The wizard routes Enter to `primaryRef`.
 */
export function StepFooter({
  onBack,
  backLabel = 'Back',
  extra,
  primary,
  primaryRef,
}: {
  onBack?: (() => void) | undefined
  backLabel?: string
  extra?: ReactNode
  primary: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean }
  primaryRef?: Ref<HTMLButtonElement> | undefined
}) {
  return (
    <footer className="mt-6 flex items-center gap-2 border-t border-border pt-4">
      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          {backLabel}
        </Button>
      )}
      <div className="mr-auto flex min-w-0 items-center gap-1">{extra}</div>
      <Button
        ref={primaryRef}
        variant="primary"
        data-onboarding-primary=""
        disabled={primary.disabled}
        loading={primary.loading}
        onClick={primary.onClick}
      >
        {primary.label}
      </Button>
    </footer>
  )
}
