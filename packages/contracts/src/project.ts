import { z } from 'zod'

/**
 * Whether the project's folder still resolves on disk. Derived at read time
 * (never persisted) so a moved or unmounted folder degrades instead of
 * disappearing.
 */
export const projectStatusSchema = z.enum(['ok', 'missing'])
export type ProjectStatus = z.infer<typeof projectStatusSchema>

/** A registered workspace folder Ari can open sessions against. */
export const projectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** Canonicalized (realpath'd where resolvable) absolute folder path. */
  path: z.string().min(1),
  /** Accent color chip index for sidebar rendering. */
  colorIndex: z.number().int().min(0).max(7).default(0),
  createdAt: z.number().int().nonnegative(),
  /** Last time the project was opened in the sidebar; 0 when never opened. */
  lastOpenedAt: z.number().int().nonnegative().default(0),
  /** True while the project occupies a sidebar group; false = known but closed. */
  open: z.boolean().default(false),
})
export type StoredProject = z.infer<typeof projectSchema>

/** A project as handed to the renderer: stored fields plus live disk status. */
export const projectViewSchema = projectSchema.extend({
  status: projectStatusSchema,
})
export type Project = z.infer<typeof projectViewSchema>
