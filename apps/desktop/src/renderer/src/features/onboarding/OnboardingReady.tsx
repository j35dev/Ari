import { Checkbox } from '@ari/ui/checkbox'
import type { OnboardingChoice } from './onboarding-completion'
import { driverLabel } from '../composer/agent-mark'
import { ProviderLogo } from '../composer/provider-logo'

/** A project's initial on a small raised tile, as in the sidebar. */
export function LetterTile({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-[11px] font-medium text-fg-muted"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}

/** Reviews the exact choices that will be saved; no workspace is opened by this screen. */
export function OnboardingReady({
  choice,
  onCreateSessionChange,
  disabled,
}: {
  choice: OnboardingChoice
  onCreateSessionChange: (create: boolean) => void
  disabled: boolean
}) {
  const first = choice.projects[0]
  return (
    <div className="space-y-5">
      <dl className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-3 py-3.5 text-sm">
          <dt className="text-fg-muted">Default agent</dt>
          <dd className="flex items-center gap-2 font-medium text-fg">
            {choice.driverKind ? (
              <>
                <ProviderLogo kind={choice.driverKind} />
                {choice.driverKind === 'claude' ? 'Claude Code' : driverLabel(choice.driverKind)}
              </>
            ) : (
              'Choose later'
            )}
          </dd>
        </div>
        <div className="py-3.5">
          <dt className="flex items-center justify-between text-sm text-fg-muted">
            Projects
            <span className="font-medium tabular-nums text-fg">{choice.projects.length}</span>
          </dt>
          <dd>
            {first ? (
              <ul className="ari-scroll mt-3 max-h-40 space-y-2.5 overflow-y-auto">
                {choice.projects.map((project) => (
                  <li key={project.path} className="flex items-center gap-3">
                    <LetterTile name={project.name} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-fg">{project.name}</span>
                      <span
                        title={project.path}
                        className="mt-0.5 block truncate font-mono text-xs text-fg-subtle"
                      >
                        {project.path}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] leading-5 text-fg-subtle">
                Add your first folder from the workspace whenever you’re ready.
              </p>
            )}
          </dd>
        </div>
      </dl>
      {first && choice.driverKind && (
        <Checkbox
          checked={choice.createSession}
          disabled={disabled}
          onChange={(e) => onCreateSessionChange(e.target.checked)}
        >
          Open an empty session in {first.name}
        </Checkbox>
      )}
      <p className="text-[13px] leading-5 text-fg-subtle">
        Only these folders will be added to Ari. Your agent stays idle until you send a message.
        Conversation history is not imported.
      </p>
    </div>
  )
}
