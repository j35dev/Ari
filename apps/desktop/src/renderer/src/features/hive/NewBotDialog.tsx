import { useState } from 'react'
import type { Bot, BotCreateParams } from '@ari/contracts/bot'
import type { DriverKind } from '@ari/contracts/common'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Field } from '@ari/ui/field'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import { ModelSelector } from '../composer/ModelSelector'
import { BotIdentityFields } from './BotIdentityFields'
import { BotLookEditor } from './BotLookEditor'
import {
  blankDraft,
  createFieldsOf,
  draftFromIntent,
  draftFromStarter,
  intentStarterId,
  type BotDraft,
} from './bot-draft'
import { STARTER_CAST } from './starter-cast'

/**
 * The schema still asks every bot for an emoji: the fallback face where a
 * character cannot be drawn. The dialog no longer asks for one.
 */
export const DEFAULT_BOT_EMOJI = '🤖'

const BLANK = 'blank'

export interface NewBotDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Registered projects a bot can live in; a bot always needs a workspace. */
  projects: readonly { id: string; name: string }[]
  driverKind: DriverKind
  modelId: string | null
  onCreate: (input: BotCreateParams) => Promise<Bot>
  /** Fired with the new bot so the shell can open its main session. */
  onCreated: (bot: Bot) => void
}

const START_CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/**
 * Creates a bot: who it is (a starter or a blank, its look, name, title,
 * tagline and persona), where it works (project), and what runs it (provider
 * and model). The main session is a side effect of `bots.create`.
 */
export function NewBotDialog({
  open,
  onOpenChange,
  projects,
  driverKind,
  modelId,
  onCreate,
  onCreated,
}: NewBotDialogProps) {
  const [draft, setDraft] = useState<BotDraft>(() => blankDraft())
  const [startedFrom, setStartedFrom] = useState(BLANK)
  /** The one-line job, as typed; drafting consumes it and keeps it for edits. */
  const [job, setJob] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [pick, setPick] = useState<{ driverKind: DriverKind; modelId: string | null }>({
    driverKind,
    modelId,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The dialog mounts with the roster, often before the projects arrive, so
  // an unpicked project falls back to the first one rather than to nothing.
  const chosenProject = projects.find((project) => project.id === projectId) ?? projects[0]
  const trimmedName = draft.name.trim()

  const startFrom = (id: string): void => {
    const starter = STARTER_CAST.find((candidate) => candidate.id === id)
    setStartedFrom(id)
    setDraft(starter === undefined ? blankDraft() : draftFromStarter(starter))
  }

  const draftFromJob = (): void => {
    if (job.trim().length === 0) return
    setDraft(draftFromIntent(job))
    // A job that names no archetype drafts the generalist, which has no chip;
    // the closest cast member's chip lights when it does fit.
    setStartedFrom(intentStarterId(job) ?? BLANK)
  }

  const submit = async (): Promise<void> => {
    if (trimmedName.length === 0 || chosenProject === undefined || busy) return
    setBusy(true)
    setError(null)
    try {
      const bot = await onCreate({
        ...createFieldsOf(draft),
        emoji: DEFAULT_BOT_EMOJI,
        driverKind: pick.driverKind,
        modelId: pick.modelId,
        projectId: chosenProject.id,
      })
      onOpenChange(false)
      setDraft(blankDraft())
      setJob('')
      setStartedFrom(BLANK)
      onCreated(bot)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        aria-label="New bot"
        className="ari-scroll max-h-[90vh] w-[min(36rem,92vw)] overflow-y-auto"
      >
        <Dialog.Title>New bot</Dialog.Title>
        <Dialog.Description>
          A bot is a persona with its own workspace and session. You can change any of this later.
        </Dialog.Description>

        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field
            label="The job, in one line"
            hint="Describe the work and press Draft: it fills a name, role, line and persona you can tune below."
          >
            {(control) => (
              <div className="flex gap-1.5">
                <Input
                  {...control}
                  value={job}
                  placeholder="Watch our release CI and summarize failures each morning"
                  onChange={(event) => setJob(event.target.value)}
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || job.trim().length === 0}
                  onClick={draftFromJob}
                >
                  Draft
                </Button>
              </div>
            )}
          </Field>

          <div role="group" aria-label="Start from" className="flex flex-col gap-1.5">
            <p aria-hidden="true" className="text-sm font-medium text-fg">
              Start from
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STARTER_CAST.map((starter) => {
                const pressed = startedFrom === starter.id
                return (
                  <button
                    key={starter.id}
                    type="button"
                    aria-pressed={pressed}
                    title={`${starter.title}: ${starter.tagline}`}
                    onClick={() => startFrom(starter.id)}
                    className={`${START_CHIP} ${
                      pressed
                        ? 'border-accent bg-accent-subtle text-fg'
                        : 'border-border bg-surface-1 text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }`}
                  >
                    <BotAvatar character={starter.character} size={20} />
                    {starter.name}
                  </button>
                )
              })}
              <button
                type="button"
                aria-pressed={startedFrom === BLANK}
                onClick={() => startFrom(BLANK)}
                className={`${START_CHIP} ${
                  startedFrom === BLANK
                    ? 'border-accent bg-accent-subtle text-fg'
                    : 'border-border bg-surface-1 text-fg-muted hover:bg-surface-3 hover:text-fg'
                }`}
              >
                Blank
              </button>
            </div>
          </div>

          <BotLookEditor
            value={draft.character}
            previewLabel={trimmedName.length > 0 ? trimmedName : undefined}
            onChange={(character) => setDraft((prev) => ({ ...prev, character }))}
          />

          <BotIdentityFields
            draft={draft}
            autoFocusName
            onChange={(change) => setDraft((prev) => ({ ...prev, ...change }))}
          />

          <Field
            label="Project"
            hint="Every bot works inside a project folder."
            error={projects.length === 0 ? 'Open a project first.' : undefined}
          >
            {(control) => (
              <Select
                {...control}
                aria-label="Project"
                value={chosenProject?.id ?? ''}
                options={projects.map((project) => ({ value: project.id, label: project.name }))}
                placeholder="Choose a project"
                onValueChange={setProjectId}
              />
            )}
          </Field>

          <Field label="Runs on">
            {() => (
              <ModelSelector
                driverKind={pick.driverKind}
                modelId={pick.modelId}
                onChange={setPick}
              />
            )}
          </Field>

          {error !== null ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={busy || trimmedName.length === 0 || projects.length === 0}
            >
              Create bot
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog>
  )
}
