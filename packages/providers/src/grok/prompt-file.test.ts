import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createGrokPromptFile, sweepGrokPromptFiles } from './prompt-file'

it('creates an owner-only prompt file and disposes it once', async () => {
  const prompt = await createGrokPromptFile('prompt 中文\nwith whitespace \n')
  try {
    expect(await readFile(prompt.path, 'utf8')).toBe('prompt 中文\nwith whitespace \n')
    if (process.platform === 'win32') {
      const command = `$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = [System.IO.File]::GetAccessControl('${prompt.path.replaceAll("'", "''")}')
@{owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current = $sid; rules = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })} | ConvertTo-Json -Compress`
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
        // Use the framework ACL API so inherited PowerShell module paths cannot
        // redirect Get-Acl to an incompatible PowerShell 7 Security module.
        { windowsHide: true },
      )
      const acl = JSON.parse(stdout) as { owner: string; current: string; rules: string[] }
      expect(acl.owner).toBe(acl.current)
      // The per-user TEMP ACL: the user, SYSTEM and Administrators only. No
      // Everyone, Users or Authenticated Users entry may grant access.
      expect(acl.rules).toContain(acl.current)
      for (const broad of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-11'])
        expect(acl.rules).not.toContain(broad)
    } else {
      expect((await stat(prompt.path)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(prompt.path))).mode & 0o777).toBe(0o700)
    }
  } finally {
    await Promise.all([prompt.dispose(), prompt.dispose()])
  }
  await expect(stat(prompt.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

describe('stale prompt sweep', () => {
  it('removes only matching directories older than a day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-grok-sweep-test-'))
    const now = Date.now()
    const old = new Date(now - 25 * 60 * 60 * 1_000)
    const stale = join(root, 'ari-grok-prompt-stale')
    const recent = join(root, 'ari-grok-prompt-recent')
    const other = join(root, 'other-stale')
    const plain = join(root, 'ari-grok-prompt-file')
    try {
      await Promise.all([mkdir(stale), mkdir(recent), mkdir(other), writeFile(plain, 'keep')])
      await Promise.all([utimes(stale, old, old), utimes(other, old, old), utimes(plain, old, old)])
      await sweepGrokPromptFiles(root, now)
      await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(recent)).isDirectory()).toBe(true)
      expect((await stat(other)).isDirectory()).toBe(true)
      expect(await readFile(plain, 'utf8')).toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow matching directory links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-grok-sweep-test-'))
    const target = join(root, 'target')
    try {
      await mkdir(target)
      await writeFile(join(target, 'keep'), 'keep')
      await utimes(target, new Date(0), new Date(0))
      await symlink(
        target,
        join(root, 'ari-grok-prompt-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await sweepGrokPromptFiles(root)
      expect(await readFile(join(target, 'keep'), 'utf8')).toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
