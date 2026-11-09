import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:grok-prompt')
const execFileAsync = promisify(execFile)
const PREFIX = 'ari-grok-prompt-'
const DAY_MS = 24 * 60 * 60 * 1_000

/** Crashed hosts cannot dispose their files; fresh turns remove yesterday's remnants. */
export async function sweepGrokPromptFiles(root = tmpdir(), now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
        .map(async (entry) => {
          const path = join(root, entry.name)
          try {
            if (now - (await stat(path)).mtimeMs > DAY_MS)
              await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
          } catch (error) {
            log.debug('stale prompt cleanup failed', { error: String(error) })
          }
        }),
    )
  } catch (error) {
    log.debug('prompt directory scan failed', { error: String(error) })
  }
}

async function restrictDirectory(path: string): Promise<void> {
  if (process.platform !== 'win32') return
  // POSIX modes do not restrict NTFS access. Protect the directory before
  // writing text, so the file inherits only the current owner's access rule.
  const command = `$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath '${path.replaceAll("'", "''")}' -AclObject $acl`
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  )
}

export interface GrokPromptFile {
  path: string
  dispose(): Promise<void>
}

export async function createGrokPromptFile(prompt: string): Promise<GrokPromptFile> {
  await sweepGrokPromptFiles()
  const dir = await mkdtemp(join(tmpdir(), PREFIX))
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (cleanup ??= rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const path = join(dir, 'prompt.txt')
  try {
    await restrictDirectory(dir)
    await writeFile(path, prompt, { encoding: 'utf8', mode: 0o600 })
    return { path, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
