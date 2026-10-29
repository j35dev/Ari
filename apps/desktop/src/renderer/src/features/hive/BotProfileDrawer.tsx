import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { TrashIcon, XIcon } from 'lucide-react'
import type { Bot } from '@ari/contracts/bot'
import type { BotRoutine } from '@ari/contracts/routine'
import { BOT_MEMORY_MAX_CHARS } from '@ari/contracts/bot'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { characterOf } from '@ari/ui/bot-character'
import { Button } from '@ari/ui/button'
import { IconButton } from '@ari/ui/icon-button'
import { Sheet } from '@ari/ui/sheet'
import { Switch } from '@ari/ui/switch'
import { Textarea } from '@ari/ui/textarea'
import { useToast } from '@ari/ui/toast'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { botsChanged } from './bots-version'

const log = createLogger('renderer:hive')

/**
 * The Mind drawer: one bot's persona, memory and routines in reach while
 * chatting with it. Edits write straight to disk; a bot's running session
 * keeps the identity it launched with, so every card also says when its
 * change actually lands.
 */
export function BotProfileDrawer({
  bot,
  open,
  onClose,
}: {
  bot: Bot
  open: boolean
  onClose: () => void
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Sheet.Content side="right">
        <BotProfileSheet bot={bot} onClose={onClose} />
      </Sheet.Content>
    </Sheet>
  )
}

/** Scrolls its cards; the sheet panel itself is a fixed-height column. */
function BotProfileSheet({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex items-center gap-2.5">
        <BotAvatar character={characterOf(bot)} size={32} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <Sheet.Title className="truncate">{bot.name}</Sheet.Title>
          <Sheet.Description className="truncate">
            {bot.tagline?.trim() || 'What this bot thinks, keeps and repeats.'}
          </Sheet.Description>
        </div>
        <IconButton
          icon={<XIcon />}
          size="sm"
          variant="ghost"
          aria-label="Close"
          onClick={onClose}
        />
      </header>
      <div className="ari-scroll flex-1 overflow-y-auto pr-1">
        <div className="flex flex-col gap-4">
          <MemoryCard bot={bot} />
          <PersonaCard bot={bot} />
          <RoutinesCard bot={bot} />
          <IdentityCard bot={bot} />
        </div>
      </div>
    </div>
  )
}

/** One bordered section with a small heading and a what-this-changes line. */
function Card({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface-2 p-3">
      <h3 className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
      <p className="mt-2 text-2xs text-fg-subtle">{hint}</p>
    </section>
  )
}

function MemoryCard({ bot }: { bot: Bot }) {
  const { toast } = useToast()
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('bots.memory.get', { botId: bot.id })
      .then((memory) => {
        if (cancelled) return
        setSaved(memory)
        setDraft(memory)
      })
      .catch(() => {
        if (cancelled) return
        setSaved('')
        setError('Memory did not load.')
      })
    return () => {
      cancelled = true
    }
  }, [bot.id])

  const changed = saved !== null && draft !== saved

  const save = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const stored = await rpc.invoke('bots.memory.replace', { botId: bot.id, content: draft })
      setSaved(stored)
      setDraft(stored)
      toast({ title: 'Memory saved', tone: 'success', durationMs: 2500 })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast({ title: 'Memory did not save', description: message, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [bot.id, busy, draft, toast])

  return (
    <Card
      title="Memory"
      hint="Every session starts from this. The chat you're in keeps the copy it froze at launch."
    >
      <Textarea
        value={draft}
        disabled={saved === null}
        maxLength={BOT_MEMORY_MAX_CHARS}
        rows={6}
        aria-label={`${bot.name}'s memory`}
        placeholder="Habits, decisions, things you told it once."
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-2xs text-fg-subtle">
          {String(draft.length)} / {String(BOT_MEMORY_MAX_CHARS)}
        </span>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={saved === null || !changed || busy}
          onClick={() => {
            void save()
          }}
        >
          Save memory
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  )
}

function PersonaCard({ bot }: { bot: Bot }) {
  const { toast } = useToast()
  const [saved, setSaved] = useState(bot.personaMd)
  const [draft, setDraft] = useState(bot.personaMd)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSaved(bot.personaMd)
    setDraft(bot.personaMd)
  }, [bot])

  const changed = draft !== saved

  const save = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const stored = await rpc.invoke('bots.update', { botId: bot.id, patch: { personaMd: draft } })
      botsChanged()
      setSaved(stored.personaMd)
      setDraft(stored.personaMd)
      toast({ title: 'Persona saved', tone: 'success', durationMs: 2500 })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast({ title: 'Persona did not save', description: message, tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [bot.id, busy, draft, toast])

  return (
    <Card
      title="Persona"
      hint="Who it is. Its next session picks this up; the open chat keeps who it was."
    >
      <Textarea
        value={draft}
        rows={8}
        aria-label={`${bot.name}'s persona`}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!changed || busy}
          onClick={() => {
            void save()
          }}
        >
          Save persona
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  )
}

function RoutinesCard({ bot }: { bot: Bot }) {
  const [routines, setRoutines] = useState<BotRoutine[] | null>(null)

  const reload = useCallback(async () => {
    try {
      const all = await rpc.invoke('routines.list')
      setRoutines(all.filter((routine) => routine.botId === bot.id))
    } catch (cause) {
      log.warn('routines.list failed', cause)
      setRoutines([])
    }
  }, [bot.id])

  useEffect(() => {
    void reload()
  }, [reload])

  const setEnabled = useCallback(
    async (routine: BotRoutine, enabled: boolean) => {
      try {
        await rpc.invoke('routines.setEnabled', { routineId: routine.id, enabled })
      } catch (cause) {
        log.warn('routines.setEnabled failed', cause)
      } finally {
        void reload()
      }
    },
    [reload],
  )

  const remove = useCallback(
    async (routine: BotRoutine) => {
      try {
        await rpc.invoke('routines.remove', { routineId: routine.id })
      } catch (cause) {
        log.warn('routines.remove failed', cause)
      } finally {
        void reload()
      }
    },
    [reload],
  )

  return (
    <Card
      title="Routines"
      hint="Repeating prompts a bot runs on its own schedule into its main session."
    >
      {routines === null ? (
        <p className="text-xs text-fg-subtle">Loading…</p>
      ) : routines.length === 0 ? (
        <p className="text-xs text-fg-subtle">No routines yet — this bot simply waits for you.</p>
      ) : (
        routines.map((routine) => (
          <div key={routine.id} className="flex items-start gap-2 rounded-md bg-surface-1 p-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-fg" title={routine.prompt}>
                {routine.prompt}
              </p>
              <p className="mt-0.5 text-2xs text-fg-subtle">
                every {routineCadence(routine.everyMs)}
              </p>
              {routine.disabledReason !== null ? (
                <p className="mt-0.5 text-2xs text-danger">
                  Ari paused this: {routine.disabledReason}
                </p>
              ) : null}
            </div>
            <Switch
              checked={routine.enabled}
              onCheckedChange={(checked) => {
                void setEnabled(routine, checked)
              }}
              aria-label={`Routine every ${routineCadence(routine.everyMs)}`}
            />
            <IconButton
              icon={<TrashIcon />}
              size="sm"
              variant="ghost"
              aria-label="Remove routine"
              onClick={() => {
                void remove(routine)
              }}
            />
          </div>
        ))
      )}
    </Card>
  )
}

function routineCadence(everyMs: number): string {
  return `${String(Math.round(everyMs / 60_000))} min`
}

function IdentityCard({ bot }: { bot: Bot }) {
  const [projectName, setProjectName] = useState<string | null>(null)

  useEffect(() => {
    if (bot.projectId === undefined) {
      setProjectName(null)
      return
    }
    let cancelled = false
    void rpc
      .invoke('project.list')
      .then((projects) => {
        if (cancelled) return
        setProjectName(projects.find((project) => project.id === bot.projectId)?.name ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [bot])

  return (
    <Card title="Runs on" hint="Chosen when the bot was created; copied into each session.">
      <ul className="flex flex-wrap gap-1.5">
        <Chip>{bot.driverKind}</Chip>
        <Chip>{bot.modelId ?? 'default model'}</Chip>
        <Chip>{projectName !== null ? projectName : 'no project'}</Chip>
      </ul>
    </Card>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-full bg-surface-3 px-2 py-0.5 text-2xs text-fg-muted">{children}</li>
  )
}
