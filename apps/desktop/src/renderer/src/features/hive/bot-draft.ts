import type { Bot, BotCharacter, BotUpdatePatch } from '@ari/contracts/bot'
import { characterOf, randomCharacter } from '@ari/ui/bot-character'
import { starterById, type StarterBot } from './starter-cast'

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

/**
 * The jobs a one-line description can name, as the starters whose persona
 * fits them. The most specific match wins: the array runs from narrow to
 * general, so "review the release writing" is a reviewer's job, not a
 * builder's.
 */
const INTENT_MAP: readonly (readonly [RegExp, string])[] = [
  [/design|\bui\b|interface|spacing|contrast/i, 'pixel'],
  [/\bbugs?\b|triage|issue|reproduce/i, 'sift'],
  [/\breview|\brace|pull request|\bpr\b|\bmerge/i, 'lint'],
  [/research|explain|source of|how does|what changed/i, 'scout'],
  [/alert|on[- ]call|uptime|monitor|deploys?|\bci\b|release health|page me/i, 'watch'],
  [/write|docs?|blog|post|changelog|announce|draft|article/i, 'scribe'],
  [/curat|collect|digest|round-?up|links?|news|track/i, 'gist'],
  [/build|implement|feature|code|fix/i, 'forge'],
]

/** The job-description persona for a line that names no archetype. */
const GENERALIST: StarterBot = {
  id: 'generalist',
  name: 'Drift',
  title: 'Generalist',
  tagline: 'Point me at the job; I will figure out the rest.',
  character: { shape: 'wisp', palette: 0 },
  personaMd: `You are Drift, the team's generalist. You take the job you are handed, work out the smallest real version of it, and do that instead of the grand version nobody asked for.

Before you start, say in one line what you understood the job to be, so a misread is caught while it still costs nothing. Then work in short, checkable steps, and say what you verified.

When the job is really several jobs, do the one that unblocks the person first and name the rest rather than starting all of them.`,
}

/** The starter id a job line points at, or null when nothing in the map fits. */
export function intentStarterId(line: string): string | null {
  const job = line.trim()
  if (job.length === 0) return null
  for (const [match, id] of INTENT_MAP) {
    if (match.test(job)) return id
  }
  return null
}

/**
 * A draft from the one-line job description: the persona of the archetype the
 * line names (a generalist when none does), with the job threaded in as the
 * first job the bot owes the team. Every field stays editable — this is a
 * draft, not a verdict.
 */
export function draftFromIntent(line: string): BotDraft {
  const job = line.trim()
  const starter = starterById(intentStarterId(job) ?? GENERALIST.id) ?? GENERALIST
  const draft = draftFromStarter(starter)
  draft.personaMd = `${draft.personaMd}\n\nThe job at hand: ${job}`
  return draft
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
