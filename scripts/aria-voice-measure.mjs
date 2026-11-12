// Native regression guard: fail the measurement if sherpa drops any prepared word.
import { spawn } from 'node:child_process'
import { setPriority, constants } from 'node:os'
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const child = spawn(
  process.execPath,
  ['--experimental-transform-types', 'scripts/aria-voice-bench.mjs', ...process.argv.slice(2)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
)
let diagnostics = ''
child.stdout.on('data', (data) => process.stdout.write(data))
child.stderr.on('data', (data) => {
  diagnostics += data.toString()
  process.stderr.write(data)
})
child.once('exit', (code) => {
  if (
    /skip(?:ped|ping)?[^\n]*word|word[^\n]*(?:not found|missing)|(?:not found|missing)[^\n]*lexicon/i.test(
      diagnostics,
    )
  ) {
    process.stderr.write('FAIL: native Kokoro silently omitted a word.\n')
    process.exitCode = 1
  } else process.exitCode = code ?? 1
})
