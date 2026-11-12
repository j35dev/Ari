// Final mobile validation. Always invoked through the coordinator's run-heavy.mjs.
import { spawn } from 'node:child_process'
import process from 'node:process'
const pnpm = 'C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs'
async function check(args) {
  process.stdout.write(`Final check ${args.join(' ')}\n`)
  const child = spawn('node', [pnpm, ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: 'inherit',
  })
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  if (result.code !== 0) throw new Error(`Final check stopped: ${JSON.stringify(result)}`)
}
await check([
  '--filter',
  '@ari/mobile',
  'exec',
  'vitest',
  'run',
  'src/lib/command-receipt.test.ts',
  'src/lib/computers.test.ts',
  'src/lib/device-key.test.ts',
  'src/lib/lifecycle-device-store.test.ts',
  'src/lib/app-provider.pairing.test.tsx',
  'src/lib/app-provider.test.tsx',
  'src/lib/draft.test.ts',
  'src/lib/terminal-writer.test.ts',
  'src/features/new/NewChatScreen.test.tsx',
  'src/features/pair/PairScreen.test.tsx',
  'src/features/session/mobile-commands.test.tsx',
  'src/features/session/ForkSheet.test.tsx',
  'src/features/session/Terminal.test.tsx',
  'src/features/session/Composer.test.tsx',
  'src/features/session/SessionScreen.test.tsx',
  'src/features/session/SessionScreen.reconnect.test.tsx',
  'src/features/computers/ComputerSwitcher.test.tsx',
  'src/App.test.tsx',
  'src/shell/AppShell.test.tsx',
  '--maxWorkers=1',
  '--no-file-parallelism',
])
await check(['--filter', '@ari/mobile', 'typecheck'])
await check(['exec', 'eslint', 'apps/mobile'])
await check(['--filter', '@ari/mobile', 'build'])
