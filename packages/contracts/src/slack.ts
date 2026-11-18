import { z } from 'zod'
import { permissionModeSchema, type DriverKind } from './common'
import type { ProjectAgent } from './project'

export const slackChannelIdSchema = z
  .string()
  .trim()
  .regex(/^[CG][A-Z0-9]{2,99}$/, 'Use the Slack channel ID, starting with C or G.')
export const slackUserIdSchema = z
  .string()
  .trim()
  .regex(/^[UW][A-Z0-9]{2,99}$/, 'Use your Slack member ID, starting with U or W.')
export const slackRouteSchema = z
  .object({
    channelId: slackChannelIdSchema,
    projectId: z
      .string()
      .min(1)
      .max(200)
      .refine((id) => id !== 'helm', 'Choose an ordinary project.'),
  })
  .strict()
export const slackConfigureSchema = z
  .object({
    botToken: z
      .string()
      .trim()
      .regex(/^xoxb-[A-Za-z0-9-]+$/, 'Use a bot token starting with xoxb-.')
      .max(2048)
      .optional(),
    appToken: z
      .string()
      .trim()
      .regex(/^xapp-[A-Za-z0-9-]+$/, 'Use an app token starting with xapp-.')
      .max(2048)
      .optional(),
    ownerUserId: slackUserIdSchema,
    permissionMode: permissionModeSchema,
    routes: z.array(slackRouteSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.routes.map((route) => route.channelId)).size !== value.routes.length)
      ctx.addIssue({ code: 'custom', path: ['routes'], message: 'Map each Slack channel once.' })
  })
export type SlackConfigure = z.infer<typeof slackConfigureSchema>
export type SlackRoute = z.infer<typeof slackRouteSchema>

export interface SlackSnapshot {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  message: string | null
  enabled: boolean
  hasCredentials: boolean
  secureStorageAvailable: boolean
  workspace: { id: string; name: string; botUserId: string } | null
  ownerUserId: string
  permissionMode: z.infer<typeof permissionModeSchema>
  routes: SlackRoute[]
  projects: {
    id: string
    name: string
    ready: boolean
    reason: string | null
    defaultAgent: ProjectAgent | null
  }[]
  providers: {
    driverKind: DriverKind
    available: boolean
    models: { id: string; efforts: string[] }[]
  }[]
  taskCount: number
  uncertainRequests: number
  uncertainDeliveries: number
}

export type SlackMutationResult =
  { ok: true; snapshot: SlackSnapshot } | { ok: false; error: { code: string; message: string } }

export const slackAppManifest = {
  display_information: {
    name: 'Aria',
    description: 'Run project tasks on your connected Ari desktop.',
  },
  features: { bot_user: { display_name: 'Aria', always_online: false } },
  oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write'] } },
  settings: {
    event_subscriptions: { bot_events: ['app_mention'] },
    interactivity: { is_enabled: true },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
} as const
