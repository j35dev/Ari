import { execFile } from 'node:child_process'
import type { SourceControlEnvironment, SourceControlTool } from '@ari/contracts/rpc'
import { processEnvWithPath, resolveDetectionEnvironment } from '@ari/providers/shell-env'

/** Runs a tool and answers its combined output and exit code; null when it is not installed. */
export type ToolRunner = (
  command: string,
  args: string[],
) => Promise<{ output: string; code: number } | null>

const runTool: ToolRunner = async (command, args) => {
  const { pathEnv } = await resolveDetectionEnvironment()
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 15_000,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...processEnvWithPath(pathEnv), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(null)
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
        resolve({ output: `${stdout}\n${stderr}`, code })
      },
    )
  })
}

const MISSING = (detail: string): SourceControlTool => ({
  installed: false,
  version: null,
  account: null,
  detail,
})

/** `git version 2.47.1.windows.1` → `2.47.1`. */
export function versionOf(output: string): string | null {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(output)?.[1] ?? null
}

/** The account a `gh auth status` / `glab auth status` report says is signed in. */
export function accountOf(output: string): string | null {
  return (
    /account\s+([A-Za-z0-9][\w.-]*)/.exec(output)?.[1] ??
    /Logged in to \S+ as\s+([A-Za-z0-9][\w.-]*)/.exec(output)?.[1] ??
    null
  )
}

async function hostCli(
  run: ToolRunner,
  command: 'gh' | 'glab',
  product: string,
): Promise<SourceControlTool> {
  const version = await run(command, ['--version'])
  if (version === null)
    return MISSING(
      `Install the ${product} CLI (${command}) to open and track ${command === 'gh' ? 'pull' : 'merge'} requests.`,
    )
  const auth = await run(command, ['auth', 'status'])
  const account = auth && auth.code === 0 ? accountOf(auth.output) : null
  return {
    installed: true,
    version: versionOf(version.output),
    account,
    detail: account
      ? `Signed in as ${account}.`
      : `Not signed in. Run \`${command} auth login\` in a terminal.`,
  }
}

/** What Settings → Source control shows: Git itself and the hosting CLIs Ari drives. */
export async function sourceControlEnvironment(
  run: ToolRunner = runTool,
): Promise<SourceControlEnvironment> {
  const [git, github, gitlab] = await Promise.all([
    run('git', ['--version']).then((result): SourceControlTool => {
      if (result === null) return MISSING('Git is not installed or not on PATH.')
      return { installed: true, version: versionOf(result.output), account: null, detail: 'Ready.' }
    }),
    hostCli(run, 'gh', 'GitHub'),
    hostCli(run, 'glab', 'GitLab'),
  ])
  return { git, github, gitlab }
}
