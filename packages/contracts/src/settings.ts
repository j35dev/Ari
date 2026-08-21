import { z } from 'zod'
import { driverKindSchema, permissionModeSchema } from './common'

/** Persisted application settings. Versioned for forward migration. */
export const settingsSchema = z.object({
  version: z.literal(1),
  appearance: z
    .object({
      themeId: z.string().default('obsidian'),
      reducedMotion: z.boolean().default(false),
    })
    .default({ themeId: 'obsidian', reducedMotion: false }),
  sessions: z
    .object({
      defaultDriverKind: driverKindSchema.nullable().default(null),
      defaultPermissionMode: permissionModeSchema.default('ask'),
    })
    .default({ defaultDriverKind: null, defaultPermissionMode: 'ask' }),
  permissions: z
    .object({
      /** Tools pre-approved across all sessions, e.g. ['Bash(git status*)']. */
      allowlist: z.array(z.string()).default([]),
    })
    .default({ allowlist: [] }),
})
export type Settings = z.infer<typeof settingsSchema>

export const defaultSettings: Settings = {
  version: 1,
  appearance: { themeId: 'obsidian', reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
}
