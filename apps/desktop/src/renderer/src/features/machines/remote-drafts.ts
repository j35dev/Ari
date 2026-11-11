import { z } from 'zod'
import { attachmentRefSchema, type AttachmentRef } from '@ari/contracts/attachments'
import { scopeKey } from './remote-client'

const schema = z.object({ text: z.string(), attachments: attachmentRefSchema.array().max(4) })
export interface RemoteDraft { text: string; attachments: AttachmentRef[] }
const key = (machineId: string, sessionId: string) => `ari.machines.draft.v1:${scopeKey(machineId, sessionId)}`

export function readRemoteDraft(machineId: string, sessionId: string): RemoteDraft {
  try {
    const parsed = schema.safeParse(JSON.parse(localStorage.getItem(key(machineId, sessionId)) ?? 'null'))
    return parsed.success ? parsed.data : { text: '', attachments: [] }
  } catch { return { text: '', attachments: [] } }
}
export function writeRemoteDraft(machineId: string, sessionId: string, draft: RemoteDraft): void {
  localStorage.setItem(key(machineId, sessionId), JSON.stringify(schema.parse(draft)))
}
