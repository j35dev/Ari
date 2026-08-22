/**
 * Fixture recorder: runs one real prompt through an installed driver CLI and
 * captures its stdout JSONL verbatim into a providers fixture file.
 *
 * Usage:
 *   npx tsx scripts/record-fixture.ts --driver <claude|codex|opencode|grok|pi|hermes>
 *     --prompt "<text>" --out <path.jsonl> [--cwd <dir>] [--model <id>] [--force]
 *
 * Example:
 *   npx tsx scripts/record-fixture.ts --driver claude --prompt "list files" \
 *     --out packages/providers/src/claude/__fixtures__/success-session.jsonl
 *
 * tsx is intentionally not a repo dependency — run via `npx tsx`, which
 * fetches it on demand (Node >= 22). The script itself depends only on node
 * builtins and @ari/providers source modules.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { buildClaudeArgs } from '../packages/providers/src/claude/claude-driver'
import { buildCodexArgs } from '../packages/providers/src/codex/codex-driver'
import { buildGrokArgs } from '../packages/providers/src/grok/grok-driver'
import { buildHermesArgs } from '../packages/providers/src/hermes/hermes-driver'
import { buildOpencodeArgs } from '../packages/providers/src/opencode/opencode-driver'
import { buildPiArgs } from '../packages/providers/src/pi/pi-driver'
import type { AdapterSession } from '../packages/providers/src/driver'
import { findBinary } from '../packages/providers/src/detector'
import { realDetectEnvironment } from '../packages/providers/src/types'

const DRIVERS = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes'] as const
type RecorderDriver = (typeof DRIVERS)[number]

const BUILDERS: Record<RecorderDriver, (session: AdapterSession) => string[]> = {
  claude: buildClaudeArgs,
  codex: buildCodexArgs,
  opencode: buildOpencodeArgs,
  grok: buildGrokArgs,
  pi: buildPiArgs,
  hermes: buildHermesArgs,
}

const USAGE = `usage:
  npx tsx scripts/record-fixture.ts --driver <${DRIVERS.join('|')}> \\
    --prompt "<text>" --out <path.jsonl> [--cwd <dir>] [--model <id>] [--force]`

interface ParsedArgs {
  driver: RecorderDriver | null
  prompt: string | null
  out: string | null
  cwd: string | null
  model: string | null
  force: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    driver: null,
    prompt: null,
    out: null,
    cwd: null,
    model: null,
    force: false,
  }
  const valueFlags = new Set(['--driver', '--prompt', '--out', '--cwd', '--model'])
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === undefined) break
    if (!flag.startsWith('--')) fail(`unexpected argument "${flag}"\n${USAGE}`)
    if (flag === '--force') {
      parsed.force = true
      continue
    }
    if (!valueFlags.has(flag)) fail(`unknown flag "${flag}"\n${USAGE}`)
    const value = argv[i + 1]
    if (value === undefined) fail(`missing value for ${flag}\n${USAGE}`)
    i++
    if (flag === '--driver') parsed.driver = parseDriver(value)
    else if (flag === '--prompt') parsed.prompt = value
    else if (flag === '--out') parsed.out = value
    else if (flag === '--cwd') parsed.cwd = value
    else parsed.model = value
  }
  return parsed
}

function parseDriver(value: string): RecorderDriver {
  const match = DRIVERS.find((d) => d === value)
  if (!match) fail(`unknown driver "${value}" (expected one of: ${DRIVERS.join(', ')})`)
  return match
}

function fail(message: string): never {
  console.error(`record-fixture: ${message}`)
  process.exit(1)
}

/**
 * Best-effort quoting for Windows `.cmd`/`.bat` shims, which must be spawned
 * through cmd.exe. Prompts containing double quotes cannot round-trip through
 * cmd's quoting rules and are not supported.
 */
function quoteForCmdShim(arg: string): string {
  return `"${arg.replaceAll('"', '\\"')}"`
}

interface RecordResult {
  exitCode: number
  lineCount: number
  byteCount: number
  stderrBytes: number
}

async function record(
  binaryPath: string,
  args: string[],
  cwd: string,
  outPath: string,
): Promise<RecordResult> {
  await mkdir(dirname(outPath), { recursive: true })
  const file = createWriteStream(outPath, { flags: 'wx' })

  // Windows .cmd/.bat shims must run through cmd.exe; a single pre-quoted
  // command string avoids Node's args+shell concatenation (DEP0190).
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
  const child = needsShell
    ? spawn([binaryPath, ...args.map(quoteForCmdShim)].join(' '), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      })
    : spawn(binaryPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

  let lineCount = 0
  let byteCount = 0
  let endsWithNewline = true
  let stderrBytes = 0

  // Chunks stay raw Buffers so bytes are piped through verbatim.
  child.stdout.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 0x0a) lineCount++
    }
    endsWithNewline = chunk[chunk.length - 1] === 0x0a
    byteCount += chunk.length
    // Respect sink backpressure: resume on the write stream's drain event.
    if (!file.write(chunk)) child.stdout.pause()
  })
  file.on('drain', () => child.stdout.resume())

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrBytes += Buffer.byteLength(chunk)
  })

  const exitCode = await new Promise<number>((resolveCode, rejectSpawn) => {
    child.on('error', rejectSpawn)
    child.on('close', (code) => resolveCode(code ?? 1))
  })
  await new Promise<void>((resolveClose, rejectClose) => {
    file.end()
    file.on('close', resolveClose)
    file.on('error', rejectClose)
  })

  if (byteCount > 0 && !endsWithNewline) lineCount++
  return { exitCode, lineCount, byteCount, stderrBytes }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.driver || args.prompt === null || !args.out) {
    fail(`--driver, --prompt and --out are required\n${USAGE}`)
  }

  const outPath = resolve(args.out)
  if (existsSync(outPath) && !args.force) {
    fail(`refusing to overwrite existing file ${outPath} (pass --force to overwrite)`)
  }

  const env = realDetectEnvironment()
  const binaryPath = findBinary(args.driver, env)
  if (!binaryPath) {
    fail(
      `"${args.driver}" binary not found on PATH or in well-known install dirs; ` +
        'install the CLI first',
    )
  }

  const session: AdapterSession = {
    sessionId: 'fixture-record',
    workspacePath: resolve(args.cwd ?? process.cwd()),
    prompt: args.prompt,
    modelId: args.model,
    permissionMode: 'ask',
    resumeOf: null,
  }

  const driverArgs = BUILDERS[args.driver](session)
  console.log(`recording ${args.driver}: ${binaryPath} ${driverArgs.join(' ')}`)
  const result = await record(binaryPath, driverArgs, session.workspacePath, outPath)

  console.log(
    `wrote ${result.lineCount} stdout line(s), ${result.byteCount} byte(s) -> ${outPath}` +
      ` (exit code ${result.exitCode}, stderr ${result.stderrBytes} byte(s))`,
  )
  process.exitCode = result.exitCode
}

await main().catch((error: unknown) => {
  console.error('record-fixture:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
