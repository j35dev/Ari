import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Use the detector's installed CLI, following npm shims without a shell or bundled CLI. */
export function claudeSdkExecutable(binaryPath: string): string {
  if (process.platform !== 'win32' || !/\.(cmd|bat|ps1)$/i.test(binaryPath)) return binaryPath
  for (const entry of ['bin/claude.exe', 'cli.js']) {
    const candidate = join(dirname(binaryPath), 'node_modules/@anthropic-ai/claude-code', entry)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Cannot locate the installed Claude executable behind ${binaryPath}. Use ARI_CLAUDE_TRANSPORT=acp for this launcher.`,
  )
}
