import { useCallback, useEffect, useRef, useState } from 'react'
import type { Bot, BotCreateParams, BotUpdatePatch } from '@ari/contracts/bot'
import { createLogger } from '@ari/shared/logger'
import { characterOf } from '@ari/ui/bot-character'
import { rpc } from '../../lib/rpc'

const log = createLogger('renderer:hive')

/** Marks a duplicate's name so two copies of one bot stay tellable apart. */
export const DUPLICATE_SUFFIX = ' copy'

export interface BotsStore {
  bots: Bot[]
  /** True until the first `bots.list` settles, so the roster can hold its shape. */
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (input: BotCreateParams) => Promise<Bot>
  duplicate: (bot: Bot, projectId: string) => Promise<Bot>
  /** Changes a bot's look or identity; the driver, model and project stay. */
  update: (botId: string, patch: BotUpdatePatch) => Promise<Bot>
  setHidden: (botId: string, hidden: boolean) => Promise<void>
}

/**
 * The bot roster's data: every bot on disk plus the writes the roster offers.
 * Writes are optimistic-free — each one re-reads the list, so what the user
 * sees is what the store holds, not what a request hoped it would.
 */
export function useBots(): BotsStore {
  const [bots, setBots] = useState<Bot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.invoke('bots.list')
      if (!mounted.current) return
      // A bridge that answers with nothing is not a roster; refuse to render a
      // team out of a transport the shell never wired up.
      setBots(Array.isArray(next) ? next : [])
      setError(null)
    } catch (cause) {
      if (!mounted.current) return
      log.warn('bots.list failed', cause)
      setError('Could not load your bot team.')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (input: BotCreateParams) => {
      const bot = await rpc.invoke('bots.create', input)
      await refresh()
      return bot
    },
    [refresh],
  )

  const duplicate = useCallback(
    async (bot: Bot, projectId: string) => {
      return await create({
        name: `${bot.name}${DUPLICATE_SUFFIX}`,
        emoji: bot.emoji,
        // The copy gets a new id, so a derived look would change; it keeps the original's.
        character: characterOf(bot),
        ...(bot.title !== undefined && bot.title.length > 0 ? { title: bot.title } : {}),
        ...(bot.tagline !== undefined && bot.tagline.length > 0 ? { tagline: bot.tagline } : {}),
        personaMd: bot.personaMd,
        driverKind: bot.driverKind,
        modelId: bot.modelId,
        projectId: bot.projectId ?? projectId,
      })
    },
    [create],
  )

  const update = useCallback(
    async (botId: string, patch: BotUpdatePatch) => {
      const bot = await rpc.invoke('bots.update', { botId, patch })
      await refresh()
      return bot
    },
    [refresh],
  )

  const setHidden = useCallback(
    async (botId: string, hidden: boolean) => {
      await rpc.invoke('bots.setHidden', { botId, hidden })
      await refresh()
    },
    [refresh],
  )

  return { bots, loading, error, refresh, create, duplicate, update, setHidden }
}
