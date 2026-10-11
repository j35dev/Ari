import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import type { DetectEnvironment } from './types'

const log = createLogger('providers:accounts')

/**
 * What a provider's home holds, sorted by whether a second account may see it.
 * Anything not named here stays private to the account: the sign-in itself
 * and whatever else the CLI keeps (caches, locks, per-organisation policy,
 * its background daemon). Naming what is shared, rather than what is not,
 * means a file a future CLI version adds is private until someone decides
 * otherwise.
 */
interface AccountLayout {
  /** The variable that moves the CLI's home. */
  homeVar: string
  /** The home's folder name under the user's own. */
  defaultDir: string
  /** The one shared folder a session cannot be resumed without. */
  conversations: string
  /** Conversations and the user's own additions: linked, so every account sees one copy. */
  sharedDirs: readonly string[]
  /** Small files the user edits: linked where the OS allows, otherwise copied in. */
  configFiles: readonly string[]
  /** Files the CLI appends to: linked where the OS allows, otherwise left per account. */
  dataFiles: readonly string[]
}

const LAYOUTS: Partial<Record<DriverKind, AccountLayout>> = {
  claude: {
    homeVar: 'CLAUDE_CONFIG_DIR',
    defaultDir: '.claude',
    conversations: 'projects',
    sharedDirs: [
      'projects',
      'file-history',
      'session-env',
      'paste-cache',
      'tasks',
      'todos',
      'plans',
      'skills',
      'plugins',
      'agents',
      'commands',
      'output-styles',
      'rules',
    ],
    configFiles: ['settings.json', 'CLAUDE.md', 'keybindings.json'],
    dataFiles: ['history.jsonl'],
  },
  codex: {
    homeVar: 'CODEX_HOME',
    defaultDir: '.codex',
    conversations: 'sessions',
    sharedDirs: [
      'sessions',
      'archived_sessions',
      'sqlite',
      'shell_snapshots',
      'worktrees',
      'attachments',
      'skills',
      'plugins',
      'rules',
    ],
    configFiles: ['config.toml', 'AGENTS.md', 'hooks.json'],
    dataFiles: ['history.jsonl', 'session_index.jsonl'],
  },
}

/** True for providers whose sign-in lives in a home directory Ari can relocate. */
export function supportsAccounts(kind: DriverKind): boolean {
  return LAYOUTS[kind] !== undefined
}

/** The home the CLI uses when Ari does not move it: the default account's. */
export function defaultAccountHome(kind: DriverKind, env: DetectEnvironment): string | null {
  const layout = LAYOUTS[kind]
  if (layout === undefined) return null
  const inherited = env.vars?.[layout.homeVar]
  return inherited !== undefined && inherited.length > 0
    ? inherited
    : join(env.homeDir, layout.defaultDir)
}

/** The variables that make a CLI run as the account living in `home`; none for the default. */
export function accountEnvironment(kind: DriverKind, home: string | null): Record<string, string> {
  const layout = LAYOUTS[kind]
  return layout === undefined || home === null ? {} : { [layout.homeVar]: home }
}

export interface AccountHomeReport {
  linked: string[]
  copied: string[]
  /** Files that stay per account here because this system cannot link files. */
  separate: string[]
  /** Entries that should have been shared and were not, each with the reason. */
  skipped: { entry: string; reason: string }[]
}

type Existing = 'missing' | 'link' | 'file' | 'dir'

async function existing(path: string): Promise<Existing> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return 'link'
    return stats.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

async function pointsAt(link: string, target: string): Promise<boolean> {
  try {
    // Windows reports a junction's target in its `\\?\` long form.
    const actual = (await readlink(link)).replace(/^\\\\\?\\/, '')
    return resolve(actual).toLowerCase() === resolve(target).toLowerCase()
  } catch {
    return false
  }
}

/** Removes a link without ever touching what it points at. */
async function removeLink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // A Windows junction is a directory to `unlink`; `rmdir` drops the
    // reparse point and leaves the target's contents where they are.
    await rmdir(path)
  }
}

async function linkDir(
  target: string,
  link: string,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const state = await existing(link)
  if (state === 'link') {
    if (await pointsAt(link, target)) return null
    await removeLink(link)
  } else if (state === 'dir') {
    // The CLI made its own before the shared one existed. Empty costs nothing
    // to replace; anything in it is the user's and is not Ari's to merge.
    if ((await readdir(link)).length > 0) return 'the account already has its own, with content'
    await rmdir(link)
  } else if (state === 'file') {
    return 'a file is in the way'
  }
  // A junction needs no privilege on Windows, where a directory symlink does.
  await symlink(target, link, platform === 'win32' ? 'junction' : 'dir')
  return null
}

async function linkFile(target: string, link: string): Promise<'linked' | 'present' | 'refused'> {
  const state = await existing(link)
  if (state === 'link') {
    if (await pointsAt(link, target)) return 'present'
    await removeLink(link)
  } else if (state !== 'missing') {
    return 'refused'
  }
  try {
    await symlink(target, link, 'file')
    return 'linked'
  } catch {
    // Windows without Developer Mode: file symlinks are a privileged operation.
    return 'refused'
  }
}

/** Whether the default home has this entry, looking through a link (dotfile managers link them). */
async function sourceIs(path: string, want: 'dir' | 'file'): Promise<boolean> {
  try {
    const stats = await stat(path)
    return want === 'dir' ? stats.isDirectory() : stats.isFile()
  } catch {
    return false
  }
}

/** Ari's note, kept in an account's home, of the config files it copied in and when. */
const COPIES_FILE = '.ari-shared.json'

type Copies = Record<string, { copy: number; source: number }>

async function readCopies(home: string): Promise<Copies> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, COPIES_FILE), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Copies) : {}
  } catch {
    return {}
  }
}

/**
 * Copies a config file in when linking is not possible, without ever
 * discarding an edit: the copy is replaced only while it is still exactly the
 * one Ari put there and the default home's file has changed since.
 */
async function syncCopy(
  source: string,
  copy: string,
  noted: { copy: number; source: number } | undefined,
): Promise<{ copy: number; source: number } | 'kept' | 'edited'> {
  const sourceTime = (await stat(source)).mtimeMs
  let copyTime: number | null
  try {
    copyTime = (await stat(copy)).mtimeMs
  } catch {
    copyTime = null
  }
  if (copyTime !== null) {
    if (noted === undefined || noted.copy !== copyTime) return 'edited'
    if (noted.source === sourceTime) return 'kept'
  }
  await copyFile(source, copy)
  return { copy: (await stat(copy)).mtimeMs, source: sourceTime }
}

/**
 * Builds, or brings up to date, the home an extra account runs in: a
 * directory of its own that holds the sign-in, with the user's conversations,
 * skills and settings linked in from the default home. A conversation started
 * as one account can then be resumed as another, which is the point of
 * switching mid-task.
 *
 * Safe to repeat. Entries the default home gains later are picked up on the
 * next call. The only things ever replaced in an account's home are an empty
 * folder, a link, and a copied config file the account has not changed since
 * Ari copied it; an entry that cannot be shared is reported, not forced, and
 * does not stop the rest.
 */
export async function prepareAccountHome(
  kind: DriverKind,
  home: string,
  env: DetectEnvironment,
): Promise<AccountHomeReport> {
  const layout = LAYOUTS[kind]
  const base = defaultAccountHome(kind, env)
  const report: AccountHomeReport = { linked: [], copied: [], separate: [], skipped: [] }
  if (layout === undefined || base === null) return report
  if (resolve(home).toLowerCase() === resolve(base).toLowerCase()) {
    throw new Error('an account cannot use the default home as its own')
  }
  await mkdir(home, { recursive: true })
  const skip = (entry: string, reason: string): void => {
    report.skipped.push({ entry, reason })
  }

  // The conversations folder must be the shared one from the first turn: a
  // CLI that finds none makes its own, and from then on the two cannot be
  // joined without merging the user's files.
  await mkdir(join(base, layout.conversations), { recursive: true }).catch((error: unknown) =>
    log.debug('could not create the shared conversations folder', { error: String(error) }),
  )

  for (const entry of layout.sharedDirs) {
    const target = join(base, entry)
    if (!(await sourceIs(target, 'dir'))) continue
    try {
      const refusal = await linkDir(target, join(home, entry), env.platform)
      if (refusal === null) report.linked.push(entry)
      else skip(entry, refusal)
    } catch (error) {
      skip(entry, String(error))
    }
  }

  const copies = await readCopies(home)
  let noted = false
  for (const entry of [...layout.configFiles, ...layout.dataFiles]) {
    const target = join(base, entry)
    if (!(await sourceIs(target, 'file'))) continue
    const link = join(home, entry)
    try {
      if ((await linkFile(target, link)) !== 'refused') {
        report.linked.push(entry)
        continue
      }
      if (!layout.configFiles.includes(entry)) {
        // A copy of a file the CLI appends to would fork it, not share it.
        report.separate.push(entry)
        continue
      }
      const outcome = await syncCopy(target, link, copies[entry])
      if (outcome === 'edited') skip(entry, 'changed in this account since it was copied')
      else if (outcome !== 'kept') {
        copies[entry] = outcome
        noted = true
        report.copied.push(entry)
      }
    } catch (error) {
      skip(entry, String(error))
    }
  }
  if (noted) await writeFile(join(home, COPIES_FILE), JSON.stringify(copies), 'utf8')
  log.debug('account home prepared', { kind, ...report })
  return report
}

/**
 * Deletes an account's home, sign-in included. Every link is removed first
 * and by itself, so the recursive delete that follows cannot reach through
 * one into the default home's conversations. `root` is the folder all account
 * homes live under; a path outside it is refused.
 */
export async function removeAccountHome(home: string, root: string): Promise<void> {
  const inside = resolve(home)
  const within = resolve(root) + sep
  if (!inside.toLowerCase().startsWith(within.toLowerCase())) {
    throw new Error(`refusing to delete ${home}: not under ${root}`)
  }
  let entries: string[]
  try {
    entries = await readdir(inside)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(inside, entry)
    if ((await existing(path)) === 'link') await removeLink(path)
  }
  for (const entry of await readdir(inside)) {
    if ((await existing(join(inside, entry))) === 'link') {
      throw new Error(`refusing to delete ${home}: ${entry} is still a link`)
    }
  }
  await rm(inside, { recursive: true, force: true })
}
