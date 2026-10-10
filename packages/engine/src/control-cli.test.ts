import { describe, expect, it } from 'vitest'
import { controlCliApproval, isSafeControlCommand } from './control-cli'

describe('isSafeControlCommand', () => {
  it.each([
    'ari env --json',
    'ari agents --json',
    'ari --skill',
    '"$ARI_CLI" --skill 2>&1 | head -100',
    'ari.cmd session status --json',
    'ari session spawn --agent claude --model claude-haiku-5-5 --role research --json --key essay-1 --title "Essay on tides" --prompt "Write a 3000 word essay. Use no tools; say \\"done\\"."',
    "ari session prompt sess_1 'Run `pnpm test` and report $? to me' --key p-1 --json",
    'ari session wait --children sess_a,sess_b --any --timeout 600 --json',
    'ari session spawn --title A --agent codex --key a --json || ari session spawn --help',
    'ari parent message "Which API should I target?" --key q-1 --json',
    'ari session diff sess_1 --stat --json | tail -n 20',
  ])('allows %s', (command) => {
    expect(isSafeControlCommand(command)).toBe(true)
  })

  it.each([
    // Not Ari, or Ari doing something that still deserves a prompt.
    'git status',
    'ari session integrate sess_1 --snapshot abc --key i --json',
    'ari session destroy sess_1 --key d --json',
    'ari skill install claude',
    'ari',
    'ari session',
    // A second command, however it is attached.
    'ari env; rm -rf .',
    'ari env && rm -rf .',
    'ari env | sh',
    'ari env & calc',
    'ari env\nrm -rf .',
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
