// Final focused validation after the shared lifecycle/context picks. Run under run-heavy.mjs.
import { spawn } from 'node:child_process'
import process from 'node:process'
const pnpm = 'C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs'
async function check(args) {
  process.stdout.write(`Final check ${args.join(' ')}\n`)
  const child = spawn('node', [pnpm, ...args], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit' })
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })) })
  if (result.code !== 0) throw new Error(`Final check stopped: ${JSON.stringify(result)}`)
}
await check(['exec', 'eslint', 'apps/mobile/src/lib/lifecycle-device-store.ts', 'apps/mobile/src/lib/lifecycle-device-store.test.ts', 'apps/mobile/src/features/session/SessionScreen.test.tsx', 'apps/mobile/scripts/final-check.mjs'])
await check(['--filter', '@ari/mobile', 'exec', 'vitest', 'run', 'src/lib/session.test.ts', '-t', 'mobile pairing', '--maxWorkers=1', '--no-file-parallelism'])
await check(['exec', 'vitest', 'run', 'packages/remote-client/src/session.test.ts', '--maxWorkers=1', '--no-file-parallelism'])
await check(['--filter', '@ari/mobile', 'typecheck'])
await check(['--filter', '@ari/mobile', 'build'])
