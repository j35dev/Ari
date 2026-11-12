import { z } from 'zod'
import {
  remoteCommandEnvelopeSchema,
  remoteQuerySchema,
  remoteServerMessageSchema,
  remoteErrorCodeSchema,
  machinesExtensionsSchema,
} from './remote'
import type { RemoteServerMessage, MachinesLocalSnapshot } from './remote'

/** Public host identity. No paths, inventories or authentication material. */
export const machineIdentitySchema = z.object({
  machineId: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(100).optional(),
  ariVersion: z.string().min(1).max(100).optional(),
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1).max(100)).max(200),
  machinesExtensions: machinesExtensionsSchema.optional(),
  routeIdentity: z.object({ version: z.literal(1) }).strict().optional(),
})
export type MachineIdentity = z.infer<typeof machineIdentitySchema>
export const machineRouteSchema = z
  .object({
    kind: z.enum(['tailscale', 'loopback']),
    origin: z.string().url().max(2048),
    source: z.enum(['manual', 'learned']).optional(),
    /** Independently approved origin whose device key can authenticate this route. */
    credentialOrigin: z.string().url().max(2048).optional(),
  })
  .strict()
export type MachineRoute = z.infer<typeof machineRouteSchema>
export const machineStatusSchema = z.enum([
  'unpaired',
  'pairing',
  'connected',
  'offline',
  'revoked',
  'incompatible',
])
export const machineViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  routes: z.array(machineRouteSchema),
  status: machineStatusSchema,
  identity: machineIdentitySchema.nullable(),
  lastSeenAt: z.number().nullable(),
  error: z.string().nullable(),
  /** This authenticated device's grant; public host capabilities never grant a shell. */
  allowTerminal: z.boolean().default(false),
  effectiveRoute: z.string().nullable().optional(),
  versionReady: z.boolean().optional(),
  permissionsReady: z.boolean().optional(),
  projectIds: z.array(z.string()).optional(),
  autoPreference: z.enum(['prefer', 'normal', 'less-often', 'manual-only']).optional(),
})
export type MachineView = z.infer<typeof machineViewSchema>
export const machinePairingViewSchema = z.object({
  machineId: z.string().min(1),
  status: z.enum(['unpaired', 'pairing', 'connected', 'denied', 'expired', 'error']),
  confirmationCode: z.string().nullable(),
  expiresAt: z.number().nullable(),
  error: z.string().nullable(),
})
export type MachinePairingView = z.infer<typeof machinePairingViewSchema>
export const machineDiscoverySchema = z.object({
  name: z.string(),
  routes: z.array(machineRouteSchema),
  identity: machineIdentitySchema,
})
export type MachineDiscovery = z.infer<typeof machineDiscoverySchema>
/** Named failures survive Electron IPC; unknown IPC failures remain uncertain. */
export const machineFailureSchema = z
  .object({
    code: z.union([remoteErrorCodeSchema, z.enum(['unreachable', 'pairing_denied'])]),
    message: z.string(),
  })
  .strict()
export type MachineFailure = z.infer<typeof machineFailureSchema>
export const machineOperationResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: machineFailureSchema }).strict(),
])
export type MachineOperationResult = z.infer<typeof machineOperationResultSchema>
const machineRef = z.object({ machineId: z.string().min(1).max(200) }).strict()
export const machineAutoPreferenceSchema = z.enum(['prefer', 'normal', 'less-often', 'manual-only'])
export type MachineAutoPreference = z.infer<typeof machineAutoPreferenceSchema>
export const LOCAL_MACHINE_PREFERENCE_ID = 'local'
export const machinesPreferencesSchema = z.object({
  autoEnabled: z.boolean(),
  hostTiers: z.record(z.string().min(1).max(200), machineAutoPreferenceSchema),
  projectHosts: z.record(z.string().min(1).max(1024), z.string().min(1).max(200)),
}).strict()
export type MachinesPreferences = z.infer<typeof machinesPreferencesSchema>
export const machinesRpcParams = {
  'machines.list': z.undefined(),
  'machines.localSnapshot': z.undefined(),
  'machines.discover': z.undefined(),
  'machines.add': z
    .object({
      address: z.string().min(1).max(2048),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  'machines.pair': machineRef.extend({
    displayName: z.string().trim().min(1).max(80),
    invitationId: z.string().min(1).max(200).optional(),
    code: z.string().min(1).max(100).optional(),
  }),
  'machines.pairStatus': machineRef,
  'machines.connect': machineRef,
  'machines.rename': machineRef.extend({ name: z.string().trim().min(1).max(100) }),
  'machines.remove': machineRef,
  'machines.addRoute': machineRef.extend({ address: z.string().min(1).max(2048) }),
  'machines.reorderRoutes': machineRef.extend({ origins: z.array(z.string().url().max(2048)).min(1).max(16) }),
  'machines.removeRoute': machineRef.extend({ origin: z.string().url().max(2048) }),
  'machines.precheck': z.object({ machineId: z.string().min(1).max(200).optional() }).strict(),
  'machines.preferences': z.undefined(),
  'machines.setAuto': z.object({ enabled: z.boolean() }).strict(),
  'machines.setPreference': machineRef.extend({ tier: machineAutoPreferenceSchema }),
  'machines.rememberProjectHost': z.object({ projectKey: z.string().min(1).max(1024), machineId: z.string().min(1).max(200) }).strict(),
  'machines.query': machineRef.extend({ query: remoteQuerySchema }),
  'machines.command': machineRef.extend({ command: remoteCommandEnvelopeSchema }),
} as const
export interface MachinesRpcResults {
  'machines.list': MachineView[]
  'machines.localSnapshot': MachinesLocalSnapshot
  'machines.discover': MachineDiscovery[]
  'machines.add': MachineView
  'machines.pair': MachinePairingView
  'machines.pairStatus': MachinePairingView
  'machines.connect': MachineView
  'machines.rename': MachineView
  'machines.remove': { removed: boolean }
  'machines.addRoute': MachineView
  'machines.reorderRoutes': MachineView
  'machines.removeRoute': MachineView
  'machines.precheck': MachineView[]
  'machines.preferences': MachinesPreferences
  'machines.setAuto': MachinesPreferences
  'machines.setPreference': MachinesPreferences
  'machines.rememberProjectHost': MachinesPreferences
  'machines.query': MachineOperationResult
  'machines.command': MachineOperationResult
}
export const machineEventsParamsSchema = machineRef.extend({
  sessionId: z.string().min(1).max(200),
  fromSeq: z.number().int().nonnegative().optional(),
  desktop: z.literal(true).optional(),
})
/** Standard stream.subscribe/unsubscribe; every frame carries its host scope. */
export interface MachineEventsFrame {
  machineId: string
  message: RemoteServerMessage
}
export const machineEventsFrameSchema = z
  .object({
    machineId: z.string().min(1).max(200),
    message: remoteServerMessageSchema,
  })
  .strict()
