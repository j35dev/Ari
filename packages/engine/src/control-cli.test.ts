import { describe, expect, it } from 'vitest'
import { controlCliApproval, isSafeControlCommand } from './control-cli'

const orchestrationCommands = [
  'ari session integrate sess_1 --snapshot abc --key i --json',
  'ari session destroy sess_1 --key d --json',
  'ari session delete sess_1 --key d --json',
  'ari session answer sess_1 --input input_1 "Use the shared parser" --key a --json',
  'ari routine add --in 10 --prompt "Check the worker" --key r --json',
  'ari routine list --json',
  'ari routine ls --json',
  'ari routine rm routine_1 --json',
  'ari routine remove routine_1 --json',
  'ari project default proj_1 --agent claude --model opus',
  'ari task integrate --params \'{"taskId":"task_1","resultId":"result_1","snapshotCommit":"abc"}\' --key i',
  'ari orchestration integrate --params \'{"taskId":"task_1","resultId":"result_1","snapshotCommit":"abc"}\' --key i',
  'ari task routine.add --params \'{"prompt":"Check the worker","at":1234}\' --key r',
  'ari orchestration routine.remove --params \'{"routineId":"routine_1"}\' --key r',
]

describe('isSafeControlCommand', () => {
  it.each([
    ...orchestrationCommands,
    'ari env --json',
    'ari agents --json',
    'ari --skill',
    '"$ARI_CLI" --skill',
    'ari.cmd session status --json',
    'ari session spawn --agent claude --model claude-haiku-5-5 --role research --json --key essay-1 --title "Essay on tides" --prompt "Write a 3000 word essay. Use no tools; say \\"done\\"."',
    "ari session prompt sess_1 'Run `pnpm test` and report $? to me' --key p-1 --json",
    'ari session prompt sess_1 "Read the notes about &&, ||, and |" --key p-2 --json',
    'ari session wait --children sess_a,sess_b --any --timeout 600 --json',
    'ari parent message "Which API should I target?" --key q-1 --json',
    // Real assignments run to several lines; inside quotes that is only text.
    'ari session spawn --title "Parser" --agent codex --key p-1 --json --prompt "Fix the parser.\n\nScope: src/parse.\n- add tests\n- report changed files"',
  ])('allows %s', (command) => {
    expect(isSafeControlCommand(command)).toBe(true)
  })

  it.each([
    // Not Ari, or Ari doing something that still deserves a prompt.
    'git status',
    'ari skill install claude',
    'ari',
    'ari session',
    'ari routine unknown',
    'ari project unknown',
    'ari task unknown',
    // A second command, however it is attached.
    'ari env; rm -rf .',
    'ari env && rm -rf .',
    'ari env && ari agents --json',
    'ari session spawn --title A --agent codex --key a --json || ari session spawn --help',
    'ari env | sh',
    'ari session diff sess_1 --stat --json | tail -n 20',
    '"$ARI_CLI" --skill 2>&1 | head -100',
    'ari env 2>&1',
    'ari env & calc',
    'ari env\nrm -rf .',
    'ari session prompt sess_1 "first line\nsecond" --key k\nrm -rf .',
    'ari env > ~/.bashrc',
    'ari session read sess_1 --json < /etc/passwd',
    // Expansion and substitution, including inside double quotes.
    'ari session prompt sess_1 "$(cat ~/.ssh/id_rsa)" --key k',
    'ari session prompt sess_1 "`whoami`" --key k',
    'ari session prompt sess_1 $HOME --key k',
    'ari session read ../*',
    // Quoting tricks that end the string earlier than it looks.
    'ari session prompt sess_1 "a\\\\" ; rm -rf x ; echo "b" --key k',
    'ari session prompt sess_1 "unterminated',
    // Something else answering to the name.
    './ari env',
    'ARI_CLI=evil "$ARI_CLI" env',
  ])('leaves %s to the user', (command) => {
    expect(isSafeControlCommand(command)).toBe(false)
  })
})

describe('controlCliApproval', () => {
  const options = [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
  ]
  const request = (fields: Record<string, unknown> = {}) => ({
    toolName: 'Bash',
    summaryJson: JSON.stringify({ command: 'ari session status --json', description: 'Check' }),
    options,
    ...fields,
  })

  it('answers a safe Bash request with the allow-once option', () => {
    expect(controlCliApproval(request())).toBe('once')
  })

  it.each(orchestrationCommands)('auto-approves the orchestration command %s', (command) => {
    expect(controlCliApproval(request({ summaryJson: JSON.stringify({ command }) }))).toBe('once')
  })

  it('leaves skill installation to the user', () => {
    expect(
      controlCliApproval(
        request({ summaryJson: JSON.stringify({ command: 'ari skill install claude' }) }),
      ),
    ).toBeNull()
  })

  it('declines other tools, other commands, malformed requests and requests without a one-time grant', () => {
    expect(controlCliApproval(request({ toolName: 'PowerShell' }))).toBeNull()
    expect(controlCliApproval(request({ toolName: 'Ari delegation' }))).toBeNull()
    expect(
      controlCliApproval(request({ summaryJson: JSON.stringify({ command: 'rm -rf .' }) })),
    ).toBeNull()
    expect(controlCliApproval(request({ summaryJson: 'not json' }))).toBeNull()
    expect(controlCliApproval(request({ summaryJson: JSON.stringify({ command: 7 }) }))).toBeNull()
    expect(
      controlCliApproval(
        request({ options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }] }),
      ),
    ).toBeNull()
  })
})

describe('Aria commands', () => {
  it('runs project and session lookups without a prompt', () => {
    expect(isSafeControlCommand('ari project ask proj_1 "Fix login" --key login')).toBe(true)
    expect(isSafeControlCommand('ari project default proj_1 --agent claude --model opus')).toBe(
      true,
    )
    expect(isSafeControlCommand('ari projects --json')).toBe(true)
    expect(isSafeControlCommand('ari sessions --query "login bug" --active --json')).toBe(true)
    expect(
      isSafeControlCommand(
        'ari session spawn --project proj_1 --title "Fix login" --agent claude --prompt "Fix it" --json',
      ),
    ).toBe(true)
  })
})
