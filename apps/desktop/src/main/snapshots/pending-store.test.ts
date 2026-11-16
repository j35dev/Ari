// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PendingSnapshots } from './pending-store'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
const item = {
  id: 'ba92a835-75c9-40d7-b266-6208b845c3ad',
  capturedAt: 100,
  windowTitle: 'Untitled - Notepad',
  attachment: { id: 'att_one', name: 'SnapShot.png', mimeType: 'image/png', size: 5 },
}
it('keeps capture and pinned destination across restart until acknowledgement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-snapshots-'))
  dirs.push(dir)
  await new PendingSnapshots(dir).save({ ...item, target: 'sess_current' })
  const restarted = new PendingSnapshots(dir)
  expect(await restarted.list()).toEqual([{ ...item, target: 'sess_current' }])
  expect(await restarted.read(item.id)).toMatchObject({ target: 'sess_current' })
  await restarted.acknowledge(item.id)
  await restarted.acknowledge(item.id)
  expect(await restarted.list()).toEqual([])
  await expect(restarted.read('../outside')).rejects.toThrow('Invalid capture id')
})
it('preserves a corrupt pending receipt and reports it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-snapshots-'))
  dirs.push(dir)
  await writeFile(join(dir, `${item.id}.json`), '{"bad":true}')
  await expect(new PendingSnapshots(dir).list()).rejects.toThrow('preserved')
})
