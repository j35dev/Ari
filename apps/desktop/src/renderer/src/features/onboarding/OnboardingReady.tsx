import { Folder } from 'lucide-react'
import { Checkbox } from '@ari/ui/checkbox'
import type { OnboardingChoice } from './onboarding-completion'
import { driverLabel } from '../composer/agent-mark'
import { ProviderLogo } from '../composer/provider-logo'

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
      <dl className="divide-y divide-border rounded-xl border border-border bg-surface-1 px-4">
        <div className="flex items-center justify-between gap-3 py-4 text-sm">
          <dt className="text-fg-muted">Default agent</dt>
          <dd className="flex items-center gap-2 font-medium">
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
        <div className="py-4">
          <dt className="flex items-center justify-between text-sm text-fg-muted">
            Projects<span className="font-mono text-xs text-fg">{choice.projects.length}</span>
          </dt>
          <dd>
            {first ? (
              <ul className="ari-scroll mt-4 max-h-40 space-y-3 overflow-y-auto">
                {choice.projects.map((project) => (
                  <li key={project.path} className="flex items-center gap-3">
                    <Folder size={16} className="shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{project.name}</span>
                      <span
                        title={project.path}
                        className="mt-0.5 block truncate font-mono text-2xs text-fg-muted"
                      >
                        {project.path}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-fg-muted">
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
      <p className="text-xs leading-relaxed text-fg-muted">
        Only these folders will be added to Ari. Your agent stays idle until you send a message.
        Conversation history is not imported.
      </p>
    </div>
  )
}
