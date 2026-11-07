import { z } from 'zod'
import type { SourceControlRepository } from '@ari/contracts/rpc'
import { sourceControlSchemas } from '@ari/contracts/rpc'
import { HostingError, type HostingApi } from './hosting-api'
import { record, requestPath } from './hosting-models'

const file = z.object({
  path: sourceControlSchemas.path,
  oldPath: sourceControlSchemas.path.nullable().optional(),
  status: z.string().optional(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
  hunksOmitted: z.boolean().optional(),
  hunks: z
    .array(
      z.object({
        oldStart: z.number().int().nonnegative(),
        oldLines: z.number().int().nonnegative(),
        newStart: z.number().int().nonnegative(),
        newLines: z.number().int().nonnegative(),
        lines: z.array(z.object({ origin: z.enum([' ', '+', '-']), content: z.string() })),
      }),
    )
    .optional(),
})
const snapshot = z.object({
  version: z.number().int().nonnegative(),
  headOid: sourceControlSchemas.oid,
  comparisonBaseOid: sourceControlSchemas.oid,
})
const page = snapshot.extend({ items: z.array(file), next: z.string().nullable() })
const details = snapshot.extend({ items: z.array(file) })

/** GitCafe's token-backed diff API pins every page to the same head, base and request version. */
export async function gitCafeDiff(
  api: HostingApi,
  host: SourceControlRepository,
  number: number,
  signal?: AbortSignal,
): Promise<string> {
  const path = requestPath(host, number)
  const request = record(await api.request(host, path, { signal }))
  const version = z.number().int().nonnegative().parse(request.version)
  const head = sourceControlSchemas.oid.parse(request.headOid)
  let base: string | undefined
  let after: string | null = null
  const cursors = new Set<string>()
  const files: z.infer<typeof file>[] = []
  let pages = 0
  do {
    if (++pages > 20)
      throw new HostingError(
        'failed',
        'This request exceeds the diff page limit. Open it on GitCafe.',
      )
    const result = page.parse(
      await api.request(
        host,
        `${path}/changes?expectedVersion=${version}&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        { signal },
      ),
    )
    if (
      result.version !== version ||
      result.headOid !== head ||
      (base && base !== result.comparisonBaseOid)
    )
      throw new HostingError(
        'failed',
        'The request changed while loading its diff. Refresh and review again.',
      )
    base = result.comparisonBaseOid
    files.push(...result.items)
    if (files.length > 1000)
      throw new HostingError(
        'failed',
        'This request exceeds the 1,000-file review limit. Open it on GitCafe.',
      )
    after = result.next
    if (after && cursors.has(after))
      throw new HostingError(
        'failed',
        'The host repeated a diff page. Refresh or open this request on GitCafe.',
      )
    if (after) cursors.add(after)
  } while (after)
  const textFiles = files.filter((file) => !file.binary && !file.tooLarge)
  const patches = new Map<string, z.infer<typeof file>>()
  for (let offset = 0; offset < textFiles.length; offset += 20) {
    const batch = textFiles.slice(offset, offset + 20)
    const result = details.parse(
      await api.request(host, `${path}/diff-files`, {
        method: 'POST',
        body: { paths: batch.map((file) => file.path), expectedVersion: version },
        signal,
      }),
    )
    if (result.version !== version || result.headOid !== head || result.comparisonBaseOid !== base)
      throw new HostingError(
        'failed',
        'The request changed while loading its diff. Refresh and review again.',
      )
    for (const file of result.items) patches.set(file.path, file)
  }
  let bytes = 0
  return files
    .map((file) => {
      const detail = patches.get(file.path)
      if (file.tooLarge || (!file.binary && (!detail || detail.tooLarge || detail.hunksOmitted)))
        throw new HostingError(
          'failed',
          'GitCafe omitted an oversized diff. Open this request on the host to review all changes.',
        )
      const old = JSON.stringify(`a/${file.oldPath ?? file.path}`),
        next = JSON.stringify(`b/${file.path}`)
      const lines = [`diff --git ${old} ${next}`]
      if (file.binary) lines.push(`Binary files ${old} and ${next} differ`)
      else {
        lines.push(
          `--- ${file.status === 'added' ? '/dev/null' : old}`,
          `+++ ${file.status === 'deleted' ? '/dev/null' : next}`,
        )
        for (const hunk of detail?.hunks ?? []) {
          lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
          lines.push(
            ...hunk.lines.map((line) => `${line.origin}${line.content.replace(/\r?\n$/, '')}`),
          )
        }
      }
      const patch = lines.join('\n') + '\n'
      bytes += Buffer.byteLength(patch)
      if (bytes > 8 * 1024 * 1024)
        throw new HostingError(
          'failed',
          'The request diff is too large to display. Open it on GitCafe.',
        )
      return patch
    })
    .join('\n')
}
