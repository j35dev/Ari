import { describe, expect, it } from 'vitest'
import { condenseReply, speechChunks, spokenLine, writtenReply } from './aria-voice'

describe('Aria spoken replies', () => {
  it('extracts only a complete authored line while keeping the written reply separate', () => {
    const line = '<!-- aria:speak {"text":"The changes are ready. Codex needs your review."} -->'
    expect(spokenLine(line.slice(0, -3))).toBeNull()
    expect(spokenLine(line)).toBe('The changes are ready. Codex needs your review.')
    expect(writtenReply(`${line}\n\nA much longer written reply.`)).toBe(
      'A much longer written reply.',
    )
    expect(spokenLine('<!-- aria:speak {broken} -->')).toBeNull()
    expect(spokenLine('<!-- aria:speak {"text":"`pnpm test`"} -->')).toBeNull()
  })
  it('condenses real progress reports without speaking lists paths or IDs', () => {
    const reply =
      'Two things finished while you were away.\n\n- **Machines swarm**: Claude Code merged `apps/mobile/Pairing.tsx`.\n- **Watchdog**: Codex needs approval on PR #515.\n\nWant me to hand the mobile polish to Pi, or keep it with Claude Code?'
    expect(condenseReply(reply)).toBe(
      'Two things finished while you were away. I put the details in the chat. Want me to hand the mobile polish to Pi, or keep it with Claude Code?',
    )
  })
  it('leaves tables charts code and links in the chat', () => {
    const reply =
      'Ari Connect is the only project that needs you.\n\n| Agent | Status |\n| --- | --- |\n| Codex | waiting |\n\n```ari-viz\n{"values":[14,3]}\n```\n```powershell\npnpm --filter @ari/desktop test\n```\nSee [the release notes](https://github.com/j35dev/Ari/releases).\nShould I continue?'
    expect(condenseReply(reply)).toBe(
      'Ari Connect is the only project that needs you. I put the details in the chat. Should I continue?',
    )
  })
  it('handles empty and structure-only replies and unfinished code fences', () => {
    expect(condenseReply('')).toBe('')
    expect(condenseReply('```ts\nsecret()')).toBe('I put the details in the chat.')
    expect(condenseReply('| x |\n|---|\n|123|')).toBe('I put the details in the chat.')
  })
  it('starts with the first clause and never loses a word when splitting', () => {
    const text =
      'The checks passed, and the changes are ready for you to review. Would you like me to continue?'
    const chunks = speechChunks(text, 60)
    expect(chunks[0]).toBe('The checks passed,')
    expect(chunks.join(' ')).toBe(text)
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true)
  })
})
