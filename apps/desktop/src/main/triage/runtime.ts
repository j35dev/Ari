import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { observeLogs } from '@ari/shared/logger'
import { processEnvWithPath, resolveDetectionEnvironment } from '@ari/providers/shell-env'
import { runInstall, type InstallHandle } from '@ari/providers/install'
import { TriageLog } from './diagnostics'

let log: TriageLog | null = null
export function triageLog(): TriageLog {
  return (log ??= new TriageLog(join(app.getPath('userData'), 'triage', 'logs.jsonl')))
}
export function startTriageLogging(): () => Promise<void> {
  const sink = triageLog()
  const off = observeLogs((level, scope, message) => {
    if (level === 'warn' || level === 'error') sink.record(scope, message)
  })
  return async () => {
    off()
    await sink.flush()
  }
}
const checks = new Set<InstallHandle>()
export async function runTriageChecks(path: string): Promise<{ passed: boolean; output: string }> {
  const { pathEnv } = await resolveDetectionEnvironment()
  let output = '',
    passed = false
  const handle = runInstall(
    ['pnpm', 'verify'],
    (event) => {
      if (event.type === 'progress') output = (output + event.line.text + '\n').slice(-32_768)
      if (event.type === 'failed') output = (output + event.reason + '\n').slice(-32_768)
      if (event.type === 'exit') passed = event.code === 0 && !event.timedOut
    },
    {
      cwd: path,
      env: processEnvWithPath(pathEnv),
      timeoutMs: 15 * 60_000,
      outputTailBytes: 32_768,
    },
  )
  checks.add(handle)
  try {
    await handle.done
    return { passed, output }
  } finally {
    checks.delete(handle)
  }
}
export async function stopTriageChecks(): Promise<void> {
  await Promise.all([...checks].map((handle) => handle.cancel()))
}

export async function saveTriageBuild(buildCommit: string | null): Promise<void> {
  const root = join(app.getPath('userData'), 'triage')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'build.json'),
    JSON.stringify({
      appVersion: app.getVersion(),
      buildCommit,
      electronVersion: process.versions.electron ?? null,
      nodeVersion: process.versions.node,
    }),
    'utf8',
  )
}
