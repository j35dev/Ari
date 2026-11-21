import { useEffect, type Ref } from 'react'
import { motion } from 'motion/react'
import { useTheme } from '@ari/ui/theme-provider'
import { themes } from '@ari/ui/themes'
import { ONBOARDING_LEAD_CLASS, ONBOARDING_TITLE_CLASS } from './OnboardingFrame'
import { StepFooter } from './StepFooter'
import { listItem, staggerList, useCalm } from './onboarding-motion'

export type ThemeChoice = 'obsidian' | 'porcelain' | 'system'

const CHOICES: readonly { id: ThemeChoice; label: string; hint: string }[] = [
  { id: 'obsidian', label: 'Dark', hint: 'Obsidian' },
  { id: 'porcelain', label: 'Light', hint: 'Porcelain' },
  { id: 'system', label: 'Match system', hint: 'Follows your OS' },
]

export function themeLabel(mode: string): string {
  return (
    CHOICES.find((choice) => choice.id === mode)?.label ?? themes[mode as 'obsidian']?.label ?? mode
  )
}

/** A tiny window in the theme's own colours: the swatch is the theme, not a picture of it. */
function Preview({ id }: { id: 'obsidian' | 'porcelain' }) {
  const c = themes[id].colors
  return (
    <span
      aria-hidden="true"
      className="flex h-full w-full overflow-hidden"
      style={{ background: c['surface-0'] }}
    >
      <span className="flex w-[30%] flex-col gap-1.5 px-2 py-2.5">
        {[70, 52, 60].map((width) => (
          <span
            key={width}
            className="h-1 rounded-full"
            style={{ width: `${width}%`, background: c['fg-subtle'], opacity: 0.55 }}
          />
        ))}
      </span>
      <span
        className="my-1.5 mr-1.5 flex flex-1 flex-col justify-end gap-1.5 rounded-md p-2.5"
        style={{ background: c.bg, border: `1px solid ${c.border}` }}
      >
        <span
          className="h-1 w-3/4 rounded-full"
          style={{ background: c['fg-muted'], opacity: 0.6 }}
        />
        <span
          className="h-1 w-1/2 rounded-full"
          style={{ background: c['fg-muted'], opacity: 0.4 }}
        />
        <span
          className="mt-1 flex h-4 items-center justify-end rounded-[5px] px-1"
          style={{ background: c['surface-1'], border: `1px solid ${c.border}` }}
        >
          <span className="size-1.5 rounded-full" style={{ background: c.accent }} />
        </span>
      </span>
    </span>
  )
}

/** Optional: the look, applied the moment it is chosen. */
export function OnboardingTheme({
  onBack,
  onContinue,
  headingRef,
  primaryRef,
}: {
  onBack: () => void
  onContinue: () => void
  headingRef: Ref<HTMLHeadingElement>
  primaryRef: Ref<HTMLButtonElement>
}) {
  const calm = useCalm()
  const { mode, setMode } = useTheme()
  // The provider swaps palettes in a view transition; here it cross-fades
  // (onboarding.css) instead of revealing from the click.
  useEffect(() => {
    const root = document.documentElement
    root.dataset['ariOnboardingTheme'] = ''
    return () => {
      delete root.dataset['ariOnboardingTheme']
    }
  }, [])
  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
        Make it yours
      </h2>
      <p className={ONBOARDING_LEAD_CLASS}>Pick a look. You can change it anytime in Settings.</p>
      <motion.div
        role="radiogroup"
        aria-label="Theme"
        className="mt-5 grid grid-cols-3 gap-3"
        variants={staggerList(0.06)}
        initial={calm ? false : 'hidden'}
        animate="shown"
      >
        {CHOICES.map((choice) => {
          const selected = mode === choice.id
          return (
            <motion.button
              key={choice.id}
              variants={listItem}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${choice.label} (${choice.hint})`}
              onClick={() => setMode(choice.id)}
              className="group flex min-w-0 flex-col gap-2 rounded-xl text-left outline-none"
            >
              <span
                className={`relative block aspect-[4/3] overflow-hidden rounded-lg border transition-[border-color,box-shadow] duration-150 group-focus-visible:ring-2 group-focus-visible:ring-accent-ring ${
                  selected
                    ? 'border-fg shadow-[0_0_0_1px_var(--ari-fg)]'
                    : 'border-border-strong group-hover:border-fg/40'
                }`}
              >
                {choice.id === 'system' ? (
                  <>
                    <Preview id="obsidian" />
                    <span
                      className="absolute inset-0"
                      style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}
                    >
                      <Preview id="porcelain" />
                    </span>
                  </>
                ) : (
                  <Preview id={choice.id} />
                )}
              </span>
              <span className="flex items-center gap-2 px-0.5">
                <span
                  className="ari-onboarding-radio"
                  aria-hidden="true"
                  data-on={selected || undefined}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-fg">{choice.label}</span>
                  <span className="block truncate text-[12px] text-fg-subtle">{choice.hint}</span>
                </span>
              </span>
            </motion.button>
          )
        })}
      </motion.div>
      <StepFooter
        onBack={onBack}
        primaryRef={primaryRef}
        primary={{ label: 'Finish setup', onClick: onContinue }}
      />
    </div>
  )
}
