import { z } from 'zod'

/**
 * Contracts for user-configured model endpoints driven by the Ari Core
 * harness. The engine's endpoint store, the RPC surface, and the settings UI
 * all parse against these schemas.
 */

/** API dialect an endpoint speaks; drives auth headers and wire format. */
export const endpointFlavorSchema = z.enum(['openai-chat', 'anthropic-messages', 'ollama'])
export type EndpointFlavor = z.infer<typeof endpointFlavorSchema>

/**
 * One model served by an endpoint. `source` records how it got there so a
 * discovery refresh can replace fetched models without dropping the ones the
 * user typed in by hand.
 */
export const endpointModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive().nullable().default(null),
  source: z.enum(['discovered', 'manual']).default('manual'),
})
export type EndpointModel = z.infer<typeof endpointModelSchema>

/** A model an endpoint advertises through its own listing API. */
export const discoveredModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  owner: z.string().nullable(),
})
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>
