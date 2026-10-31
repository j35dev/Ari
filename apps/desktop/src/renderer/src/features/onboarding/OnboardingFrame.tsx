import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import { Button } from '@ari/ui/button'
import { Titlebar } from '../../shell/Titlebar'

const STEPS = ['Your agents', 'Your projects', 'Ready to work']

/** Full-window setup chrome, sharing Ari's themes, wallpaper and native window controls. */
export function OnboardingFrame({
  children,
  step,
  onStep,
  busy = false,
  navigationLocked = false,
  onDismiss,
  dismissLabel,
}: {
  children: ReactNode
  step?: number
  onStep?: (step: number) => void
  busy?: boolean
  navigationLocked?: boolean
  onDismiss: () => void
  dismissLabel: string
}) {
  const overlayRef = useOverlayRef()
  return (
    <div ref={overlayRef} className="ari-wallpaper-pane flex h-full flex-col bg-bg">
      <Titlebar minimal />
      <main
        aria-label="Ari setup"
        className="ari-scroll min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10"
      >
        <div className="mx-auto grid min-h-full max-w-5xl content-center gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <div className="flex flex-col items-start lg:py-3">
            <span className="text-2xl font-semibold tracking-tight text-fg">
              Ari<span className="text-accent">.</span>
            </span>
            <h1 className="mt-6 text-3xl font-semibold leading-tight tracking-tight text-fg sm:text-4xl">
              Your agents.
              <br />
              One workspace.
            </h1>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fg-muted">
              Bring your coding tools and projects together. No new account. No moving your files.
            </p>
            {step !== undefined && (
              <nav aria-label="Setup progress" className="mt-7 w-full">
                <ol className="flex gap-2 lg:flex-col lg:gap-1">
                  {STEPS.map((label, index) => (
                    <li key={label} className="flex-1">
                      <button
                        type="button"
                        disabled={busy || navigationLocked}
                        aria-current={step === index ? 'step' : undefined}
                        onClick={() => onStep?.(index)}
                        className={`flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left text-xs transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50 ${step === index ? 'font-medium text-fg' : 'text-fg-muted'}`}
                      >
                        <span
                          aria-hidden
                          className={`flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-2xs ${step === index ? 'border-accent bg-accent text-fg-on-accent' : 'border-border-strong'}`}
                        >
                          {index < step ? <Check size={12} /> : index + 1}
                        </span>
                        {label}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="mt-4 lg:mt-8"
              disabled={busy}
              onClick={onDismiss}
            >
              {dismissLabel}
            </Button>
          </div>
          <section className="min-w-0 self-center pb-2">{children}</section>
        </div>
      </main>
    </div>
  )
}
