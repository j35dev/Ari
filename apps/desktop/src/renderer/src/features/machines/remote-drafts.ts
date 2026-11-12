import { z } from 'zod'
import { attachmentRefSchema, type AttachmentRef } from '@ari/contracts/attachments'
import { scopeKey } from './remote-client'
import { driverKindSchema, permissionModeSchema } from '@ari/contracts/common'

const schema = z.object({ text: z.string(), attachments: attachmentRefSchema.array().max(4) })
export interface RemoteDraft {
  text: string
  attachments: AttachmentRef[]
}
const key = (machineId: string, sessionId: string) =>
  `ari.machines.draft.v1:${scopeKey(machineId, sessionId)}`

export function readRemoteDraft(machineId: string, sessionId: string): RemoteDraft {
  try {
    const parsed = schema.safeParse(
      JSON.parse(localStorage.getItem(key(machineId, sessionId)) ?? 'null'),
    )
    return parsed.success ? parsed.data : { text: '', attachments: [] }
  } catch {
    return { text: '', attachments: [] }
  }
}
export function writeRemoteDraft(machineId: string, sessionId: string, draft: RemoteDraft): void {
  localStorage.setItem(key(machineId, sessionId), JSON.stringify(schema.parse(draft)))
}

const creationSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  selection: z
    .object({
      driverKind: driverKindSchema,
      modelId: z.string(),
      permissionMode: permissionModeSchema,
      effort: z.string().nullable(),
    })
    .nullable(),
})
export type RemoteCreationDraft = z.infer<typeof creationSchema>
const creationKey = (machineId: string) =>
  `ari.machines.creation-draft.v1:${JSON.stringify(machineId)}`
export function readCreationDraft(machineId: string): RemoteCreationDraft {
  try {
    const parsed = creationSchema.safeParse(
      JSON.parse(localStorage.getItem(creationKey(machineId)) ?? 'null'),
    )
    return parsed.success ? parsed.data : { projectId: '', title: '', selection: null }
  } catch {
    return { projectId: '', title: '', selection: null }
  }
}
export function writeCreationDraft(machineId: string, draft: RemoteCreationDraft): void {
  localStorage.setItem(creationKey(machineId), JSON.stringify(creationSchema.parse(draft)))
}
