import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { setPriority, constants } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const pnpm = 'C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs'
const files = execFileSync('git', ['diff', 'feat/aria-experiment', '--name-only'], {
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter((file) => /\.(?:ts|tsx|mjs|js|json|md|yml)$/.test(file))
const steps = process.argv.includes('--format')
  ? [['format', process.execPath, ['node_modules/prettier/bin/prettier.cjs', '--write', ...files]]]
  : [
      ['typecheck', process.execPath, [pnpm, '--workspace-concurrency=1', '-r', 'typecheck']],
      [
        'lint',
        process.execPath,
        [
          'node_modules/eslint/bin/eslint.js',
          ...files.filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file)),
        ],
      ],
      [
        'contracts-tests',
        process.execPath,
        [
          pnpm,
          '--filter',
          '@ari/contracts',
          'test',
          'src/aria-voice.test.ts',
          '--maxWorkers=1',
          '--no-file-parallelism',
        ],
      ],
      [
        'engine-tests',
        process.execPath,
        [
          pnpm,
          '--filter',
          '@ari/engine',
          'test',
          'src/settings.test.ts',
          'src/control-preamble.test.ts',
          '--maxWorkers=1',
          '--no-file-parallelism',
        ],
      ],
      [
        'desktop-tests',
        process.execPath,
        [
          pnpm,
          '--filter',
          '@ari/desktop',
          'test',
          'src/main/speech',
          'src/main/aria-widget',
          'src/renderer/src/features/aria',
          'src/renderer/src/features/settings/SpeechSettings.test.tsx',
          'src/renderer/src/features/settings/SettingsWorkspace.test.tsx',
          'src/renderer/src/features/transcript/MessageFooter.test.tsx',
          'src/renderer/src/App.aria-runtime.test.tsx',
          '--maxWorkers=1',
          '--no-file-parallelism',
        ],
      ],
      ['desktop-build', process.execPath, [pnpm, '--filter', '@ari/desktop', 'build']],
    ]
await mkdir('docs/research/aria-voice-checks', { recursive: true })
let failed = false
for (const [name, executable, args] of steps) {
  let log = ''
  console.log(`Starting ${name}`)
  const code = await new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (data) => {
      log += data
      process.stdout.write(data)
    })
    child.stderr.on('data', (data) => {
      log += data
      process.stderr.write(data)
    })
    child.once('exit', resolve)
  })
  await writeFile(`docs/research/aria-voice-checks/${name}.log`, log)
  if (code !== 0) failed = true
  console.log(JSON.stringify({ name, exitCode: code }))
}
process.exitCode = failed ? 1 : 0
