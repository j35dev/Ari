// Sequential focused checks, always invoked through the shared heavy lock runner.
import { spawn } from 'node:child_process'
import process from 'node:process'
const stage = process.argv[2]
if (!['before', 'after'].includes(stage)) throw new Error('Expected before or after')
const pnpm = 'C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs'
const files = stage === 'before'
  ? ['src/lib/app-provider.test.tsx', 'src/lib/draft.test.ts', 'src/features/home/HomeScreen.test.tsx', 'src/features/session/SessionScreen.test.tsx', 'src/features/session/Composer.test.tsx']
  : ['src/lib/computers.test.ts', 'src/lib/app-provider.test.tsx', 'src/lib/draft.test.ts', 'src/lib/device-key.test.ts', 'src/features/home/HomeScreen.test.tsx', 'src/features/session/SessionScreen.test.tsx', 'src/features/session/SessionScreen.reconnect.test.tsx', 'src/features/session/Composer.test.tsx', 'src/features/session/AttentionDock.test.tsx', 'src/features/session/mobile-commands.test.tsx', 'src/features/session/ForkSheet.test.tsx', 'src/features/computers/ComputerSwitcher.test.tsx', 'src/App.test.tsx', 'src/shell/AppShell.test.tsx', 'src/features/new/NewChatScreen.test.tsx']
async function run(args) {
  process.stdout.write(`Checking ${args.join(' ')}\n`)
  const child = spawn('node', args, { cwd: process.cwd(), windowsHide: true, stdio: 'inherit' })
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })) })
  if (result.code !== 0) throw new Error(`Check stopped: ${JSON.stringify(result)}`)
}
if (!process.argv.includes('--skip-tests')) await run([pnpm, '--filter', '@ari/mobile', 'exec', 'vitest', 'run', ...files, '--maxWorkers=1', '--no-file-parallelism'])
await run([pnpm, '--filter', '@ari/mobile', 'typecheck'])
if (stage === 'after') await run([pnpm, 'exec', 'eslint', 'apps/mobile/src/lib/app-state.tsx', 'apps/mobile/src/lib/computers.ts', 'apps/mobile/src/lib/computers.test.ts', 'apps/mobile/src/lib/app-provider.test.tsx', 'apps/mobile/src/lib/app-provider.pairing.test.tsx', 'apps/mobile/src/features/computers', 'apps/mobile/src/features/home/HomeScreen.tsx', 'apps/mobile/src/features/settings/SettingsScreen.tsx', 'apps/mobile/src/features/pair/PairScreen.tsx', 'apps/mobile/src/features/session/SessionScreen.tsx', 'apps/mobile/src/features/session/SessionScreen.test.tsx', 'apps/mobile/src/features/session/SessionScreen.reconnect.test.tsx', 'apps/mobile/src/features/session/AttentionDock.tsx', 'apps/mobile/src/features/new/NewChatScreen.tsx', 'apps/mobile/src/App.tsx', 'apps/mobile/src/App.test.tsx', 'apps/mobile/src/shell/AppShell.tsx', 'apps/mobile/src/shell/AppShell.test.tsx', 'apps/mobile/scripts/capture-layout.mjs', 'apps/mobile/scripts/validate-mobile.mjs', 'apps/mobile/scripts/fixtures'])
await run([pnpm, '--filter', '@ari/mobile', 'build'])
await run(['apps/mobile/scripts/capture-layout.mjs', stage])
