'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

function redact(text) {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[redacted]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+)\b/g,
      '[redacted]',
    )
    .replace(
      /(?<![\w-])((?:["']?)(?:[\w-]{0,64}(?:token|secret|password|api[_-]?key|authorization)[\w-]{0,64})(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .split(os.homedir())
    .join('<home>')
    .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s"']+/gi, '<home>')
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, '<home>')
}
function profilePath(env = process.env) {
  if (process.platform === 'win32')
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Ari')
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Ari')
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Ari')
}
async function bounded(pathname, max) {
  const file = await fs.open(pathname, 'r')
  try {
    const size = (await file.stat()).size
    const bytes = Buffer.alloc(Math.min(size, max))
    await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length))
    return bytes.toString('utf8')
  } finally {
    await file.close()
  }
}
async function run(argv, env = process.env) {
  const options = { profile: profilePath(env), agent: null, export: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--export') options.export = true
    else if (argv[i] === '--agent' && ['claude', 'codex'].includes(argv[i + 1]))
      options.agent = argv[++i]
    else if (argv[i] === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-'))
      options.profile = path.resolve(argv[++i])
    else if (argv[i] === '--help') {
      process.stdout.write(
        'ari triage --agent claude|codex [--profile <profile-directory>]\nari triage --export [--profile <profile-directory>]\n',
      )
      return
    } else
      throw new Error(
        'Use ari triage --agent claude|codex, or ari triage --export. --profile selects the affected Ari profile directory.',
      )
  }
  if (!options.export && !options.agent)
    throw new Error(
      'Choose --agent claude or --agent codex, or use --export to review diagnostics without an agent.',
    )
  let build = {}
  try {
    const saved = JSON.parse(
      await bounded(path.join(options.profile, 'triage', 'build.json'), 16_000),
    )
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) build = saved
  } catch {
    /* the affected version is unknown */
  }
  const context = {
    version: 1,
    appVersion: typeof build.appVersion === 'string' ? build.appVersion : 'unknown',
    buildCommit:
      typeof build.buildCommit === 'string' && /^[a-f0-9]{40,64}$/.test(build.buildCommit)
        ? build.buildCommit
        : null,
    profile: path.basename(options.profile),
    machine: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: typeof build.nodeVersion === 'string' ? build.nodeVersion : 'unknown',
    electronVersion: typeof build.electronVersion === 'string' ? build.electronVersion : null,
    collectedAt: Date.now(),
    providers: [],
    logs: '',
    exclusions: [
      'Credentials and environment variables',
      'Project files',
      'Prompts and conversation history',
      'Terminal transcripts',
      'Screenshots',
    ],
  }
  // Agent context excludes logs by default. Export includes only recent sanitized diagnostic messages.
  if (options.export) {
    try {
      const logs = await bounded(path.join(options.profile, 'triage', 'logs.jsonl'), 1_048_576)
      context.logs = redact(
        logs
          .split('\n')
          .filter((line) => {
            try {
              return JSON.parse(line).at >= Date.now() - 900_000
            } catch {
              return false
            }
          })
          .join('\n'),
      )
    } catch {
      /* missing logs remain explicitly empty */
    }
  }
  const directory = path.join(options.profile, 'triage', 'terminal', crypto.randomUUID())
  await fs.mkdir(directory, { recursive: true })
  const file = path.join(directory, 'context.json')
  await fs.writeFile(file, JSON.stringify(context, null, 2), 'utf8')
  const instructions = `You are an Ari support agent. Read the approved context at ${JSON.stringify(file)}. Ask what went wrong and collect reproduction steps. The affected Ari version is ${context.appVersion}, not the version of this bootstrap. Diagnose against https://github.com/j35dev/Ari at the recorded commit or affected release tag; disclose approximate matching if unavailable. Clone source only into this triage directory. Check existing Ari issues and PRs. Do not inspect raw environment values, credentials, unrelated project files, or session journals. Draft an issue before asking the user to publish it. For a requested source fix, use a separate checkout, meaningful regression tests, and pnpm verify, then present the diff and PR draft before publishing. Do not alter the installed application or restart Ari yourself.`
  await fs.writeFile(path.join(directory, 'PLAYBOOK.md'), instructions, 'utf8')
  process.stdout.write(
    `Triage context saved: ${file}\nAffected Ari version: ${context.appVersion}\n`,
  )
  if (options.export) return
  // Avoid inheriting a broken in-app control surface. The bootstrap is independent of Ari's socket.
  const agentEnv = { ...env }
  for (const key of Object.keys(agentEnv))
    if (
      key.startsWith('ARI_CONTROL_') ||
      key.startsWith('ARI_SESSION_') ||
      key === 'ARI_SESSION_ID'
    )
      delete agentEnv[key]
  const program = options.agent
  const args = program === 'codex' ? ['--cd', directory, instructions] : [instructions]
  await new Promise((resolve, reject) => {
    let child
    if (process.platform === 'win32') {
      // PowerShell handles npm .ps1/.cmd launchers. Values are passed as environment data, never interpolated shell code.
      agentEnv.ARI_TRIAGE_AGENT = program
      agentEnv.ARI_TRIAGE_ARGS = JSON.stringify(args)
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '$triageArguments = @(ConvertFrom-Json $env:ARI_TRIAGE_ARGS); & $env:ARI_TRIAGE_AGENT @triageArguments; exit $LASTEXITCODE',
        ],
        { cwd: directory, env: agentEnv, stdio: 'inherit', windowsHide: true },
      )
    } else child = spawn(program, args, { cwd: directory, env: agentEnv, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `The ${program} agent exited with code ${code}. Your triage context remains at ${file}.`,
          ),
        )
    })
  })
}
module.exports = { run, redact, profilePath }
