import { z } from 'zod'
const entrySchema = z.object({ id: z.string().min(1), groupId: z.string().min(1),
  spaceId: z.string().min(1), paneId: z.string().min(1), initialHostId: z.string().optional(),
  lead: z.boolean().optional(),
  group: z.object({ id: z.string(), name: z.string(), label: z.string().nullable(),
    checkouts: z.array(z.object({ hostId: z.string(), hostName: z.string(), projectId: z.string(),
      name: z.string(), checkoutLabel: z.string(), local: z.boolean(), repository: z.object({
        canonicalKey: z.string(), originKey: z.string().nullable().optional(), label: z.string().nullable().optional(),
      }).nullable(), })).max(512), }),
}).strict()
export type ProjectDraftEntry = z.infer<typeof entrySchema>
const entriesSchema = z.array(entrySchema).max(100)
const key = 'ari.machines.projectDrafts.v1'
/** Client draft metadata only; this registry never creates or routes a session. */
export function readProjectDrafts(): ProjectDraftEntry[] {
  const raw = localStorage.getItem(key)
  return raw === null ? [] : entriesSchema.parse(JSON.parse(raw))
}
export function writeProjectDrafts(entries: ProjectDraftEntry[]): void {
  localStorage.setItem(key, JSON.stringify(entriesSchema.parse(entries)))
}
