import type { Bot, BotCharacter, BotUpdatePatch } from '@ari/contracts/bot'
import { characterOf, randomCharacter } from '@ari/ui/bot-character'
import type { StarterBot } from './starter-cast'

/** Longest title and tagline `botSchema` accepts. */
export const BOT_TITLE_MAX = 40
export const BOT_TAGLINE_MAX = 100

/** What the bot dialogs edit, as typed: trimmed only on the way out. */
export interface BotDraft {
  name: string
  title: string
  tagline: string
  personaMd: string
  character: BotCharacter
}

/** A fresh bot with nothing filled in, wearing a random look so new bots differ. */
export function blankDraft(random?: () => number): BotDraft {
  return { name: '', title: '', tagline: '', personaMd: '', character: randomCharacter(random) }
}

export function draftFromStarter(starter: StarterBot): BotDraft {
  return {
    name: starter.name,
    title: starter.title,
    tagline: starter.tagline,
    personaMd: starter.personaMd,
    character: { ...starter.character },
  }
}

/** An existing bot as the edit dialog opens it; a cleared title or tagline (`''`) reads as empty. */
export function draftFromBot(bot: Bot): BotDraft {
  return {
    name: bot.name,
    title: bot.title ?? '',
    tagline: bot.tagline ?? '',
    personaMd: bot.personaMd,
    character: characterOf(bot),
  }
}

/** The identity half of `bots.create`: a trimmed name, and a title and tagline only when set. */
export function createFieldsOf(
  draft: BotDraft,
): Pick<Bot, 'name' | 'personaMd' | 'character' | 'title' | 'tagline'> {
  const title = draft.title.trim()
  const tagline = draft.tagline.trim()
  return {
    name: draft.name.trim(),
    character: draft.character,
    personaMd: draft.personaMd,
    ...(title.length > 0 ? { title } : {}),
    ...(tagline.length > 0 ? { tagline } : {}),
  }
}

/**
 * The `bots.update` patch that turns `bot` into `draft`: only what changed, so
 * an untouched bot from before characters keeps deriving its look from its id.
 * A cleared title or tagline is sent as `''`, which the store keeps as cleared.
 */
export function patchOf(bot: Bot, draft: BotDraft): BotUpdatePatch {
  const before = draftFromBot(bot)
  const patch: BotUpdatePatch = {}
  const name = draft.name.trim()
  if (name !== bot.name) patch.name = name
  const title = draft.title.trim()
  if (title !== before.title) patch.title = title
  const tagline = draft.tagline.trim()
  if (tagline !== before.tagline) patch.tagline = tagline
  if (draft.personaMd !== bot.personaMd) patch.personaMd = draft.personaMd
  if (
    draft.character.shape !== before.character.shape ||
    draft.character.palette !== before.character.palette
  ) {
    patch.character = draft.character
  }
  return patch
}
