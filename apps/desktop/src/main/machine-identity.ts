import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const storedIdentitySchema = z
  .object({
    machineId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(100),
  })
  .strict()
export type HostIdentity = z.infer<typeof storedIdentitySchema> & { ariVersion: string }
type StoredIdentity = z.infer<typeof storedIdentitySchema>

function readIdentity(path: string): StoredIdentity | 'empty' | null {
  let file: number
  try {
    file = openSync(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const info = fstatSync(file)
    if (!info.isFile() || info.size > 4096)
      throw new Error('The saved machine identity is invalid or too large.')
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return 'empty'
    return storedIdentitySchema.parse(JSON.parse(raw))
  } finally {
    closeSync(file)
  }
}

function syncDirectory(dir: string): void {
  // Windows does not expose directory fsync through Node; the file itself is flushed.
  if (process.platform === 'win32') return
  const file = openSync(dir, 'r')
  try {
    fsyncSync(file)
  } finally {
    closeSync(file)
  }
}

/** Complete, flushed, no-replace publication. Every competing initializer reads the winner. */
function publishIdentity(
  path: string,
  dir: string,
  record: StoredIdentity,
  recoverEmpty = false,
): StoredIdentity {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(file, JSON.stringify(record))
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    if (recoverEmpty) {
      const current = readIdentity(path)
      if (current === 'empty') renameSync(temporary, path)
      else if (current === null) linkSync(temporary, path)
      else assertSameIdentity(current, record)
    } else {
      try {
        linkSync(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    syncDirectory(dir)
    const winner = readIdentity(path)
    if (!winner || winner === 'empty')
      throw new Error('The saved machine identity has no valid recovery winner.')
    return winner
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function assertSameIdentity(left: StoredIdentity, right: StoredIdentity): void {
  if (left.machineId !== right.machineId || left.name !== right.name)
    throw new Error('The saved machine identity disagrees with its recovery record.')
}

/** A public host identifier, independent of gateway ports and process lifetimes. */
export function loadMachineIdentity(dir: string, ariVersion: string): HostIdentity {
  const path = join(dir, 'identity.json')
  const recoveryPath = `${path}.recovery`
  const primary = readIdentity(path)
  // Corrupt nonempty records throw above. Empty records can only recover from an
  // already durable anchor; a missing anchor never authorizes minting a new ID.
  if (primary === 'empty') {
    const recovery = readIdentity(recoveryPath)
    if (!recovery || recovery === 'empty')
      throw new Error('The empty machine identity needs manual recovery.')
    const evidence = `${path}.empty`
    try {
      copyFileSync(path, evidence, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readIdentity(evidence) !== 'empty')
        throw error
    }
    const restored = publishIdentity(path, dir, recovery, true)
    assertSameIdentity(restored, recovery)
    return { ...restored, ariVersion }
  }
  mkdirSync(dir, { recursive: true })
  const storedRecovery = readIdentity(recoveryPath)
  if (storedRecovery === 'empty')
    throw new Error('The saved machine identity recovery record is empty.')
  const recovery =
    storedRecovery ??
    publishIdentity(
      recoveryPath,
      dir,
      primary ?? {
        machineId: `machine_${randomUUID()}`,
        name: hostname().slice(0, 100) || 'Ari computer',
      },
    )
  if (primary) {
    assertSameIdentity(primary, recovery)
    return { ...primary, ariVersion }
  }
  // Publish a separate inode: truncating the primary must not damage its anchor.
  const winner = publishIdentity(path, dir, recovery)
  assertSameIdentity(winner, recovery)
  return { ...winner, ariVersion }
}
