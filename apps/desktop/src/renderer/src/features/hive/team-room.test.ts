import { describe, expect, it } from 'vitest'
import {
  applyRoomFrame,
  insertMention,
  isPass,
  isRoomFrame,
  mentionOf,
  needsYouMember,
  pendingLabel,
  replyingMember,
} from './team-room'
import { roomFixture as room } from './room-fixture'

describe('isRoomFrame', () => {
  it('accepts updates and removals, and nothing else', () => {
    expect(isRoomFrame({ roomId: 'room_1', room: room() })).toBe(true)
    expect(isRoomFrame({ roomId: 'room_1', room: null })).toBe(true)
    expect(isRoomFrame({ roomId: 'room_1' })).toBe(false)
    expect(isRoomFrame({ room: null })).toBe(false)
    expect(isRoomFrame(null)).toBe(false)
  })
})

describe('applyRoomFrame', () => {
  const first = room()
  const second = room({ id: 'room_2', title: 'Docs' })

  it('replaces a known room where it sits', () => {
    const renamed = room({ title: 'Launch v2' })
    expect(applyRoomFrame([first, second], { roomId: 'room_1', room: renamed })).toEqual([
      renamed,
      second,
    ])
  })

  it('drops a removed room', () => {
    expect(applyRoomFrame([first, second], { roomId: 'room_1', room: null })).toEqual([second])
  })

  it('puts a room it has not seen first', () => {
    expect(applyRoomFrame([first], { roomId: 'room_2', room: second })).toEqual([second, first])
  })
})

describe('replyingMember', () => {
  it('names the first bot the round still waits on', () => {
    const running = room({
      round: { rounds: 1, messages: 1, followUps: 0, awaiting: ['bot_b', 'bot_a'], passed: [] },
    })
    expect(replyingMember(running)?.name).toBe('Rover')
    expect(replyingMember(room())).toBeUndefined()
  })
})

describe('needsYouMember', () => {
  it('names the newest bot that asked for the person', () => {
    const asked = room({
      needsUser: true,
      log: [
        { id: 'e1', botId: 'bot_a', text: '@user which colour?', at: 1 },
        { id: 'e2', botId: 'bot_b', text: 'Blue is fine by me.', at: 2 },
      ],
    })
    expect(needsYouMember(asked)?.name).toBe('Pixel')
  })

  it('falls back to the newest bot line, and to nobody when no one asked', () => {
    const asked = room({
      needsUser: true,
      log: [
        { id: 'e1', botId: 'bot_a', text: 'Done.', at: 1 },
        { id: 'e2', botId: 'bot_b', text: 'Over to you.', at: 2 },
        { id: 'e3', botId: null, text: 'Thanks', at: 3 },
      ],
    })
    expect(needsYouMember(asked)?.name).toBe('Rover')
    expect(needsYouMember({ ...asked, needsUser: false })).toBeUndefined()
  })
})

describe('labels', () => {
  it('counts held-back messages', () => {
    expect(pendingLabel(1)).toBe('1 message waiting for the room to settle')
    expect(pendingLabel(3)).toBe('3 messages waiting for the room to settle')
  })

  it('mentions a bot by its full name', () => {
    expect(mentionOf(' Pixel copy ')).toBe('@Pixel copy ')
  })

  it('reads a bare (pass) as a pass', () => {
    expect(isPass(' (pass)\n')).toBe(true)
    expect(isPass('I pass (pass)')).toBe(false)
  })
})

describe('insertMention', () => {
  it('inserts at the caret, spaced off the word before it', () => {
    expect(insertMention('ask', { start: 3, end: 3 }, 'Pixel')).toEqual({
      text: 'ask @Pixel ',
      caret: 11,
    })
    expect(insertMention('', { start: 0, end: 0 }, 'Pixel')).toEqual({
      text: '@Pixel ',
      caret: 7,
    })
  })

  it('replaces the selection and keeps what follows', () => {
    expect(insertMention('hi there, ok', { start: 3, end: 8 }, 'Rover')).toEqual({
      text: 'hi @Rover , ok',
      caret: 10,
    })
  })
})
