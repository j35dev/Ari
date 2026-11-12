import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SourceControlEnvironment, SourceControlTool } from '@ari/contracts/rpc'
import type { Settings } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { Select } from '@ari/ui/select'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { Switch } from '@ari/ui/switch'
import { rpc } from '../../lib/rpc'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SETTINGS_HINT_CLASS, SETTINGS_LABEL_CLASS, SettingsSection } from './SettingsSection'
import { rowAction } from '../../lib/recipes'
import { useEngineSettings } from './useEngineSettings'
import { SourceControlConnectionsSettings } from './SourceControlConnectionsSettings'

const log = createLogger('settings:source-control')

const FETCH_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '30', label: 'Every 30 seconds' },
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '900', label: 'Every 15 minutes' },
]

const TOOLS: { key: 'git' | 'github' | 'gitlab'; label: string }[] = [
  { key: 'git', label: 'Git' },
  { key: 'github', label: 'GitHub CLI' },
  { key: 'gitlab', label: 'GitLab CLI' },
]

function ToolRow({ label, tool }: { label: string; tool: SourceControlTool | null }) {
  // One status vocabulary: checking, not installed, ready, or needs a sign-in.
  const status =
    tool === null
      ? 'working'
      : !tool.installed
        ? 'queued'
        : tool.account || label === 'Git'
          ? 'done'
          : 'attention'
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span aria-hidden className="ari-status" data-status={status} />
      <div className="min-w-0 flex-1">
        <p className={`flex items-center gap-2 ${SETTINGS_LABEL_CLASS}`}>
          {label}
          {tool?.version ? (
            <code className="font-mono text-xs font-normal text-fg-subtle">{tool.version}</code>
          ) : null}
        </p>
        <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>{tool ? tool.detail : 'Checking…'}</p>
      </div>
    </div>
  )
}

/**
 * Settings → Source control, after T3 Code's page: how the titlebar Git
 * control and the diff panel behave, and which tools Ari found to drive them.
 */
export function SourceControlSettings() {
  const { settings, update } = useEngineSettings()
  const [environment, setEnvironment] = useState<SourceControlEnvironment | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const current = settings?.sourceControl

  const scan = useCallback(() => {
    setScanning(true)
    setScanError(null)
    void rpc
      .invoke('scm.environment')
      .then(setEnvironment)
      .catch((error: unknown) => {
        log.warn('source control scan failed', { error: String(error) })
        setScanError('Could not check hosting connections. Retry below.')
      })
      .finally(() => setScanning(false))
  }, [])
  useEffect(scan, [scan])

  const set = (patch: Partial<Settings['sourceControl']>): void => {
    void update({ sourceControl: patch }).catch((error: unknown) => {
      log.warn('failed to save source control settings', { error: String(error) })
    })
  }

  return (
    <SettingsPage
      title="Source control"
      description="Connect your repositories, choose how Git actions work, and make code review your own."
    >
      <SettingsSection title="Hosting connections">
        <SourceControlConnectionsSettings environment={environment} onChanged={scan} />
        <p className={`px-4 py-3.5 ${SETTINGS_HINT_CLASS}`}>
          Git commits, branches, fetch, push and pull work with any Git remote. Connect a host to
          create, review and manage its pull or merge requests.
        </p>
      </SettingsSection>
      <SettingsSection title="Git actions">
        <SettingsRow
          label="Confirm pushes to the default branch"
          hint="Ask before pushing straight to main, master, trunk or develop without a pull request."
        >
          <Switch
            aria-label="Confirm pushes to the default branch"
            checked={current?.confirmDefaultPush ?? true}
            onCheckedChange={(checked) => set({ confirmDefaultPush: checked })}
          />
        </SettingsRow>
        <SettingsRow
          label="Open pull requests as drafts"
          hint="New pull requests start as drafts, so reviewers are not asked until you mark them ready."
        >
          <Switch
            aria-label="Open pull requests as drafts"
            checked={current?.draftPullRequests ?? false}
            onCheckedChange={(checked) => set({ draftPullRequests: checked })}
          />
        </SettingsRow>
        <SettingsRow
          label="Fetch in the background"
          hint="Keeps the open project's ahead/behind counts current, so the Git button can offer Pull when someone else pushed."
        >
          <Select
            aria-label="Fetch in the background"
            value={String(current?.fetchIntervalSeconds ?? 60)}
            options={FETCH_OPTIONS}
            onValueChange={(value) => set({ fetchIntervalSeconds: Number(value) })}
            className="w-44"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Diffs">
        <SettingsRow
          label="Open reviews in"
          hint="Use the full workspace for room to compare code, or keep changes beside your conversation."
        >
          <SegmentedControl
            aria-label="Open reviews in"
            size="sm"
            value={current?.diffOpenMode ?? 'workspace'}
            options={[
              { value: 'workspace', label: 'Workspace' },
              { value: 'sidebar', label: 'Sidebar' },
            ]}
            onChange={(value) =>
              set({ diffOpenMode: value === 'sidebar' ? 'sidebar' : 'workspace' })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Default view"
          hint="How a diff first opens. Narrow panels and one-sided files always start in one column."
        >
          <SegmentedControl
            aria-label="Default diff view"
            size="sm"
            value={current?.diffView ?? 'split'}
            options={[
              { value: 'split', label: 'Split' },
              { value: 'unified', label: 'Unified' },
            ]}
            onChange={(value) => set({ diffView: value === 'unified' ? 'unified' : 'split' })}
          />
        </SettingsRow>
        <SettingsRow
          label="Wrap long lines"
          hint="Wrap lines inside the diff instead of scrolling sideways."
        >
          <Switch
            aria-label="Wrap long lines"
            checked={current?.wrapDiffLines ?? false}
            onCheckedChange={(checked) => set({ wrapDiffLines: checked })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Tools"
        action={
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            aria-label="Check again"
            title="Check Git and hosting tools again"
            className={`${rowAction} disabled:opacity-50`}
          >
            <RefreshCw
              size={12}
              strokeWidth={1.7}
              className={scanning ? 'animate-spin' : ''}
              aria-hidden
            />
          </button>
        }
      >
        {TOOLS.map((tool) => (
          <ToolRow key={tool.key} label={tool.label} tool={environment?.[tool.key] ?? null} />
        ))}
        {scanError ? (
          <p role="alert" className="px-4 py-3.5 text-[13px] text-danger">
            {scanError}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  )
}
