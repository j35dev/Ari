import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const storedIdentitySchema = z.object({
  machineId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
}).strict()
export type HostIdentity = z.infer<typeof storedIdentitySchema> & { ariVersion: string }

/** A public host identifier, independent of gateway ports and process lifetimes. */
export function loadMachineIdentity(dir: string, ariVersion: string): HostIdentity {
  const path = join(dir, 'identity.json')
  if (existsSync(path)) {
    if (statSync(path).size > 4096) throw new Error('The saved machine identity is too large.')
    return { ...storedIdentitySchema.parse(JSON.parse(readFileSync(path, 'utf8'))), ariVersion }
  }
  const record = { machineId: `machine_${randomUUID()}`, name: hostname().slice(0, 100) || 'Ari computer' }
  mkdirSync(dir, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  return { ...record, ariVersion }
}
