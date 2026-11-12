import type { ReactNode } from 'react'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import { Button } from '@ari/ui/button'
import { Titlebar } from '../../shell/Titlebar'
import { DitherScene } from '../scene/DitherScene'

const STEPS = ['Your agents', 'Your projects', 'Ready to work']

/** Setup titles: the step heading in the wizard, the state heading in the gate. */
export const ONBOARDING_TITLE_CLASS =
  'text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg outline-none'

/**
 * Full-window setup: the window chrome with the scene behind one centred
 * stage. Everything to read sits on the stage, so the art never carries text.
 */
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
    <div ref={overlayRef} className="ari-wallpaper-pane flex h-full flex-col bg-surface-0">
      <Titlebar minimal />
      <main aria-label="Ari setup" className="relative min-h-0 flex-1">
        <DitherScene kind="session" />
        {/* After the scene in the DOM, so the stage paints over it without a
            z-index. The spacers sit the stage a little above the middle. */}
        <div className="ari-scroll relative flex h-full flex-col overflow-y-auto px-6">
          <div className="min-h-4 flex-[2]" aria-hidden="true" />
          <div className="ari-stage mx-auto w-full max-w-[720px] shrink-0 p-10">
            <header className="mb-8">
              <div className="flex min-h-7 items-center gap-3">
                <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg">
                  Ari<span className="text-accent">.</span>
                </span>
                <div className="ml-auto flex items-center gap-3">
                  {step !== undefined && (
                    <nav aria-label="Setup progress" className="flex items-center gap-2">
                      <ol className="flex items-center">
                        {STEPS.map((label, index) => (
                          <li key={label}>
                            <button
                              type="button"
                              disabled={busy || navigationLocked}
                              aria-current={step === index ? 'step' : undefined}
                              aria-label={label}
                              title={label}
                              onClick={() => onStep?.(index)}
                              className="flex size-5 items-center justify-center rounded-full transition-colors hover:bg-fg/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50"
                            >
                              <span
                                aria-hidden="true"
                                className={`size-1.5 rounded-full ${step === index ? 'bg-fg' : 'bg-fg/25'}`}
                              />
                            </button>
                          </li>
                        ))}
                      </ol>
                      <span className="text-xs tabular-nums text-fg-subtle">
                        {step + 1} of {STEPS.length}
                      </span>
                    </nav>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss}>
                    {dismissLabel}
                  </Button>
                </div>
              </div>
              <h1 className="mt-3 text-[13px] font-medium text-fg-muted">
                Your agents. One workspace.
              </h1>
              <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
                Bring your coding tools and projects together. No new account. No moving your files.
              </p>
            </header>
            <section className="min-w-0">{children}</section>
          </div>
          <div className="min-h-6 flex-[3]" aria-hidden="true" />
        </div>
      </main>
    </div>
  )
}
