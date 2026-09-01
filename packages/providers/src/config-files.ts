import { join } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { realDetectEnvironment } from './types'
import type { DetectEnvironment } from './types'

/**
 * Where each agent keeps the configuration a user would actually want to edit
 * — model defaults, installed extensions, the system prompt — so Ari can offer
 * it instead of sending people to a terminal and a docs page.
 *
 * Ari owns none of these files: they are the agent's own format, read and
 * written verbatim. Credential stores are deliberately absent; Ari never opens
 * a file that holds a token (see `detector.ts` authCandidates, which only ever
 * checks existence).
 *
 * Paths follow each vendor's documented layout, including the env vars that
 * relocate it. A kind with no entry answers empty rather than guessing — a
 * wrong path here would have Ari creating a file the agent never reads.
 */

export type ProviderConfigFormat = 'json' | 'toml' | 'markdown'

export interface ProviderConfigFile {
  /** Stable id the renderer round-trips instead of a path. */
  id: string
  label: string
  /** Absolute path in the agent's own config layout. */
  path: string
  format: ProviderConfigFormat
  /** One line on what the file controls, shown under the label. */
  description: string
}

/** The directory a kind's config files live under, honouring its env override. */
export function providerConfigDir(
  kind: DriverKind,
  env: DetectEnvironment = realDetectEnvironment(),
): string | null {
  const home = env.homeDir
  if (home.length === 0) return null
  switch (kind) {
    case 'pi':
      return envVar(env, 'PI_CODING_AGENT_DIR') ?? join(home, '.pi', 'agent')
    case 'claude':
      return envVar(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude')
    case 'codex':
      return envVar(env, 'CODEX_HOME') ?? join(home, '.codex')
    case 'opencode':
      return envVar(env, 'OPENCODE_CONFIG_DIR') ?? join(home, '.config', 'opencode')
    case 'grok':
      return envVar(env, 'GROK_HOME') ?? join(home, '.grok')
    default:
      // hermes has no layout Ari has confirmed; ari-core is configured in Ari.
      return null
  }
}

/** Config files Ari can show for a kind, in the order they should be listed. */
export function providerConfigFiles(
  kind: DriverKind,
  env: DetectEnvironment = realDetectEnvironment(),
): ProviderConfigFile[] {
  const dir = providerConfigDir(kind, env)
  if (dir === null) return []
  const file = (
    id: string,
    label: string,
    name: string,
    format: ProviderConfigFormat,
    description: string,
  ): ProviderConfigFile => ({ id, label, path: join(dir, name), format, description })

  switch (kind) {
    case 'pi':
      return [
        file(
          'settings',
          'settings.json',
          'settings.json',
          'json',
          'Default provider and model, thinking level, installed packages, quiet startup.',
        ),
        file(
          'system',
          'SYSTEM.md',
          'SYSTEM.md',
          'markdown',
          'Replaces the system prompt outright. Absent by default.',
        ),
        file(
          'append-system',
          'APPEND_SYSTEM.md',
          'APPEND_SYSTEM.md',
          'markdown',
          'Appended to the built-in system prompt.',
        ),
        file(
          'agents',
          'AGENTS.md',
          'AGENTS.md',
          'markdown',
          'Always-on context sent with every session.',
        ),
        file('models', 'models.json', 'models.json', 'json', 'Custom providers and models.'),
        file('keybindings', 'keybindings.json', 'keybindings.json', 'json', "pi's own key bindings."),
      ]
    case 'claude':
      return [
        file(
          'settings',
          'settings.json',
          'settings.json',
          'json',
          'Model, permission allow/deny rules, hooks, plugins, environment.',
        ),
        file('memory', 'CLAUDE.md', 'CLAUDE.md', 'markdown', 'Standing instructions for every project.'),
      ]
    case 'codex':
      return [
        file(
          'config',
          'config.toml',
          'config.toml',
          'toml',
          'Model and reasoning effort, approval policy, sandbox mode, MCP servers.',
        ),
        file('agents', 'AGENTS.md', 'AGENTS.md', 'markdown', 'Standing instructions for every project.'),
      ]
    case 'opencode':
      return [
        file(
          'config',
          'opencode.json',
          'opencode.json',
          'json',
          'Models, providers, permissions, agents, MCP servers, plugins.',
        ),
      ]
    case 'grok':
      return [
        file(
          'config',
          'config.toml',
          'config.toml',
          'toml',
          'Default model and reasoning effort, permission mode, plugins, MCP servers.',
        ),
      ]
    default:
      return []
  }
}

/** Looks one file up by the id the renderer sent, so no path crosses the wire. */
export function providerConfigFile(
  kind: DriverKind,
  id: string,
  env: DetectEnvironment = realDetectEnvironment(),
): ProviderConfigFile | null {
  return providerConfigFiles(kind, env).find((f) => f.id === id) ?? null
}

function envVar(env: DetectEnvironment, name: string): string | null {
  const raw = env.vars?.[name]
  return raw != null && raw.length > 0 ? raw : null
}
