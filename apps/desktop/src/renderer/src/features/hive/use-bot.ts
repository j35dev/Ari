import { useEffect, useState } from 'react'
import type { Bot } from '@ari/contracts/bot'
import { rpc } from '../../lib/rpc'

/**
 * Reads one bot off disk by id. A bot session is writable from the roster
 * (edit persona, look), so bot views read `bots.list` rather than receiving a
 * copy from a possibly stale holder — they show what is on disk, and a bot
 * that has been deleted reads as nothing instead of a ghost.
 */
export function useBotOf(botId: string | undefined): Bot | undefined {
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
  }, [botId])
  return bot
}
