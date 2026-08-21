import { z } from 'zod'

/** A registered workspace folder Ari can open sessions against. */
export const projectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  path: z.string().min(1),
  /** Accent color chip index for sidebar rendering. */
  colorIndex: z.number().int().min(0).max(7).default(0),
  createdAt: z.number().int().nonnegative(),
})
export type Project = z.infer<typeof projectSchema>
