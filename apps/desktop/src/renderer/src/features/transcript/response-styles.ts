import { responseStyleSchema, type ResponseStyle } from '@ari/contracts/settings'

/** Presentation choices share one contract with persisted settings and the picker. */
export const responseStyles = [
  {
    id: 'default',
    label: 'Default (current Ari)',
    description: 'The current chat layout, streaming, and expandable tool timeline. Unchanged.',
  },
  {
    id: 'flow',
    label: 'Flow',
    description: 'Readable responses with compact work receipts and one foreground operation.',
  },
  {
    id: 'fold',
    label: 'Fold',
    description: 'Layered tool cards with file-like tabs for the work behind the response.',
  },
  {
    id: 'margin',
    label: 'Margin',
    description: 'Editorial typography, an execution receipt, and numbered tool annotations.',
  },
  {
    id: 'signal',
    label: 'Signal',
    description: 'A compact tool-event strip with an inspectable live operation and result counts.',
  },
] as const satisfies readonly { id: ResponseStyle; label: string; description: string }[]

/** Also protects callers loading a preference written by a newer application. */
export function resolveResponseStyle(value: unknown): ResponseStyle {
  const parsed = responseStyleSchema.safeParse(value)
  return parsed.success ? parsed.data : 'default'
}
