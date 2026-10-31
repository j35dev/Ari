import { useEffect, useState } from 'react'
import type { Bot } from '@ari/contracts/bot'
import { rpc } from '../../lib/rpc'
import { useBotsVersion } from './bots-version'

/**
 * Reads one bot off disk by id. A bot session is writable from the roster and
 * the Mind drawer (edit persona, look, memory), so bot views read `bots.list`
 * rather than receiving a copy from a possibly stale holder — they show what
 * is on disk, and a bot that has been deleted reads as nothing instead of a
 * ghost. Writers bump {@link useBotsVersion} to wake active readers.
 */
export function useBotOf(botId: string | undefined): Bot | undefined {
  const version = useBotsVersion()
  const [bot, setBot] = useState<Bot | undefined>(undefined)
  useEffect(() => {
    if (botId === undefined) {
      setBot(undefined)
      return
    }
    let cancelled = false
    void rpc
      .invoke('bots.list')
      .then((bots) => {
        if (cancelled) return
        setBot(bots.find((b) => b.id === botId))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [botId, version])
  return bot
}
