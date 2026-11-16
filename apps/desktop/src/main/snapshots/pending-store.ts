import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pendingSnapshotSchema, type PendingSnapshot } from '../../shared/snapshots'

export class PendingSnapshots {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid capture id')
    return join(this.dir, `${id}.json`)
  }

  async list(): Promise<PendingSnapshot[]> {
    await mkdir(this.dir, { recursive: true })
    const items = await Promise.all(
      (await readdir(this.dir))
        .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
        .map(async (name) => {
          const parsed = pendingSnapshotSchema.safeParse(
            JSON.parse(await readFile(join(this.dir, name), 'utf8')),
          )
          if (!parsed.success || `${parsed.data.id}.json` !== name)
            throw new Error('A pending capture could not be read. Its file has been preserved.')
          return parsed.data
        }),
    )
    return items.sort((a, b) => a.capturedAt - b.capturedAt)
  }

  async read(id: string): Promise<PendingSnapshot> {
    return pendingSnapshotSchema.parse(JSON.parse(await readFile(this.path(id), 'utf8')))
  }

  async save(item: PendingSnapshot): Promise<void> {
    const validated = pendingSnapshotSchema.parse(item)
    await mkdir(this.dir, { recursive: true })
    const path = this.path(validated.id)
    await writeFile(`${path}.tmp`, JSON.stringify(validated), 'utf8')
    await rename(`${path}.tmp`, path)
  }

  async acknowledge(id: string): Promise<void> {
    await unlink(this.path(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
