import type { PermissionMode } from '@ari/contracts/common'

/** Decision vocabulary shared with `approval.respond` commands. */
export type ApprovalDecision = 'allow' | 'deny' | 'always-allow'

/**
 * The choices a mode-gated tool call offers. Ids match the decision
 * vocabulary, so answering by name needs no translation. `always-allow`
 * clears the tool for the rest of the run, not the session.
 */
export const ARI_CORE_APPROVAL_OPTIONS = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always-allow', name: 'Allow for this run', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
] as const

/** Tools whose execution a permission mode can gate (exec / mutating tools). */
export const MODE_GUARDED_TOOLS = new Set(['bash', 'write', 'edit'])

export interface PermissionDecision {
  allowed: boolean
  /** Human-readable reason when blocked; always names the active mode. */
  reason: string
}

const ALLOW: PermissionDecision = { allowed: true, reason: '' }

/**
 * Pure permission-mode gate for a tool call.
 *
 * Fail-closed: an absent mode is treated as `ask`, so bash and file writes
 * are blocked unless the caller explicitly runs permissive. Read-only and
 * planning tools stay available in every mode. This is the mode dimension
 * only — allowlist rules are enforced separately on top of it.
 *
 * `shellLike` marks external-execution tools (mounted MCP tools) that gate
 * exactly like bash regardless of their name: blocked under `ask` and
 * `allow-edits`, allowed only under `full` (or per-call approval).
 */
export function checkPermission(
  mode: PermissionMode | undefined,
  toolName: string,
  shellLike = false,
): PermissionDecision {
  if (!MODE_GUARDED_TOOLS.has(toolName) && !shellLike) return ALLOW
  const effective: PermissionMode = mode ?? 'ask'
  if (effective === 'full') return ALLOW
  if (effective === 'allow-edits' && toolName !== 'bash' && !shellLike) return ALLOW
  return {
    allowed: false,
    reason: `blocked by permission mode '${effective}': ${toolName} requires approval`,
  }
}
