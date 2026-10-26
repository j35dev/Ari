import { useState } from 'react'
import type { Bot, BotCreateParams } from '@ari/contracts/bot'
import type { DriverKind } from '@ari/contracts/common'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Field } from '@ari/ui/field'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import { Textarea } from '@ari/ui/textarea'
import { ModelSelector } from '../composer/ModelSelector'

/** Every bot needs a persona file; a new one starts from this placeholder. */
export const DEFAULT_BOT_EMOJI = '🤖'

const PERSONA_PLACEHOLDER = 'You are Pixel, a careful UI engineer. You read before you write.'

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

/**
 * Creates a bot: who it is (name, emoji, persona), where it works (project),
 * and what runs it (provider and model). The main session is a side effect of
 * `bots.create` — the roster never has to mint one itself.
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
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState(DEFAULT_BOT_EMOJI)
  const [personaMd, setPersonaMd] = useState('')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [pick, setPick] = useState<{ driverKind: DriverKind; modelId: string | null }>({
    driverKind,
    modelId,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosenProject = projects.find((project) => project.id === projectId)
  const trimmedName = name.trim()

  const submit = async (): Promise<void> => {
    if (trimmedName.length === 0 || chosenProject === undefined || busy) return
    setBusy(true)
    setError(null)
    try {
      const bot = await onCreate({
        name: trimmedName,
        emoji: emoji.trim().length > 0 ? emoji.trim() : DEFAULT_BOT_EMOJI,
        personaMd,
        driverKind: pick.driverKind,
        modelId: pick.modelId,
        projectId: chosenProject.id,
      })
      onOpenChange(false)
      setName('')
      setPersonaMd('')
      onCreated(bot)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content aria-label="New bot" className="w-[min(34rem,92vw)]">
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
          <div className="flex gap-3">
            <div className="w-20 shrink-0">
              <Field label="Face" hint="An emoji.">
                {(control) => (
                  <Input
                    {...control}
                    value={emoji}
                    maxLength={4}
                    className="justify-center text-center"
                    onChange={(event) => setEmoji(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="Name">
                {(control) => (
                  <Input
                    {...control}
                    autoFocus
                    value={name}
                    placeholder="Pixel"
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>

          <Field label="Persona" hint="Markdown. What this bot is here to do.">
            {(control) => (
              <Textarea
                {...control}
                autoGrow
                value={personaMd}
                placeholder={PERSONA_PLACEHOLDER}
                onChange={(event) => setPersonaMd(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Project"
            hint="Every bot works inside a project folder."
            error={projects.length === 0 ? 'Open a project first.' : undefined}
          >
            {(control) => (
              <Select
                {...control}
                aria-label="Project"
                value={projectId}
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
