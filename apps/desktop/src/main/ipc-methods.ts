import type { WebContents } from 'electron'
import type { RpcMethod } from '@ari/contracts/rpc'

/**
 * Every RPC method the renderer can reach. The RpcRegistry validates
 * payloads, but `ipcMain.handle` is registered per-method from this list —
 * a method missing here is silently unreachable from the renderer even when
 * its registry handler exists (that is exactly how `project.move` first
 * shipped dead). The guard test pins this list to the contracts channel map.
 */
export const IPC_METHODS = [
  'ping',
  'app.info',
  'session.list',
  'session.create',
  'session.load',
  'session.workspace',
  'session.destroy',
  'sessions.importable',
  'sessions.import',
  'usage.summary',
  'focus.music.status',
  'focus.music.play',
  'focus.music.pause',
  'focus.music.next',
  'focus.music.previous',
  'focus.music.search',
  'focus.music.browse',
  'focus.music.volume',
  'focus.music.shuffle',
  'focus.music.queue',
  'focus.music.resolve',
  'focus.playlists.list',
  'focus.playlists.create',
  'focus.playlists.rename',
  'focus.playlists.remove',
  'focus.playlists.update',
  'focus.playlists.play',
  'providers.allowance',
  'usage.ccusage',
  'command.dispatch',
  'attachments.stage',
  'attachments.read',
  'providers.detect',
  'providers.models',
  'providers.plan',
  'providers.install',
  'providers.cancelInstall',
  'providers.authProbe',
  'providers.login',
  'providers.configFiles',
  'providers.readConfig',
  'providers.writeConfig',
  'window.minimize',
  'window.toggleMaximize',
  'window.close',
  'theme.apply',
  'terminal.create',
  'terminal.write',
  'terminal.resize',
  'terminal.kill',
  'project.list',
  'project.add',
  'project.open',
  'project.close',
  'project.remove',
  'project.move',
  'dialog.pickFolder',
  'shell.revealPath',
  'shell.openUrl',
  'files.index',
  'search.content',
  'endpoints.list',
  'endpoints.upsert',
  'endpoints.remove',
  'endpoints.test',
  'endpoints.discoverModels',
  'endpoints.setModels',
  'settings.get',
  'settings.update',
  'git.status',
  'git.diffWorktree',
  'git.turnDiff',
  'git.add',
  'git.commit',
  'git.push',
  'git.createPr',
  'plan.get',
  'scripts.list',
  'fs.list',
  'fs.readTextFile',
  'fs.writeTextFile',
  'stream.subscribe',
  'stream.unsubscribe',
] as const satisfies readonly RpcMethod[]

/**
 * Phase-A trust boundary: only the main window's own webContents may invoke
 * privileged RPC handlers. The preload bridge (`window.ari`) is exposed to
 * every document hosted in the window, so a cross-context caller — a popup
 * that escaped the window-open guard, a stray webContents, a second window —
 * must never reach the registry. Compares by identity against the contents
 * `registerRpc` was given; a destroyed window serves nothing.
 */
export function isTrustedIpcSender(sender: WebContents, contents: WebContents): boolean {
  return sender === contents && !contents.isDestroyed()
}
