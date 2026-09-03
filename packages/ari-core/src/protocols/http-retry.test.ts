import { describe, expect, it } from 'vitest'
import {
  backoffDelayMs,
  describeFailure,
  guardStream,
  isRetryableStatus,
  parseRetryAfter,
  sleep,
  summarizeErrorBody,
  withRetry,
  type RetryPolicy,
  type StreamFetch,
  type StreamResponse,
} from './http-retry'

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000 }

/** Records every delay asked for instead of waiting it out. */
function fakeSleep(): { napped: number[]; sleep: (ms: number) => Promise<void> } {
  const napped: number[] = []
  return {
    napped,
    sleep: (ms) => {
      napped.push(ms)
      return Promise.resolve()
    },
  }
}

function ok(): StreamResponse {
  return { body: (async function* () { yield 'data: {}' })(), status: 200, statusText: 'OK' }
}

function fail(status: number, extra: Partial<StreamResponse> = {}): StreamResponse {
  return { body: null, status, statusText: 'Internal Server Error', ...extra }
}

/** Answers with each scripted response in turn, repeating the last one. */
function scripted(responses: StreamResponse[]): { fetch: StreamFetch; calls: number } {
  const state = { calls: 0 }
  const fetch: StreamFetch = () => {
    const response = responses[Math.min(state.calls, responses.length - 1)]
    state.calls++
    return Promise.resolve(response as StreamResponse)
  }
  return {
    fetch,
    get calls() {
      return state.calls
    },
  }
}

describe('retryable statuses', () => {
  it('retries congestion and upstream faults', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableStatus(status)).toBe(true)
    }
  })

  it('never retries a request the endpoint rejected on its merits', () => {
    for (const status of [200, 400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false)
    }
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('3')).toBe(3000)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-09-04T00:00:00Z')
    expect(parseRetryAfter('Fri, 04 Sep 2026 00:00:05 GMT', now)).toBe(5000)
  })

  it('never returns a negative wait for a date already past', () => {
    const now = Date.parse('2026-09-04T00:00:10Z')
    expect(parseRetryAfter('Fri, 04 Sep 2026 00:00:05 GMT', now)).toBe(0)
  })

  it('ignores an absent or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('  ')).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('doubles per attempt and keeps half the delay fixed', () => {
    // random() === 0 is the floor: exponential / 2, never zero.
    expect(backoffDelayMs(1, policy, null, () => 0)).toBe(50)
    expect(backoffDelayMs(2, policy, null, () => 0)).toBe(100)
    expect(backoffDelayMs(3, policy, null, () => 0)).toBe(200)
  })

  it('spends the full exponential when the jitter rolls high', () => {
    expect(backoffDelayMs(1, policy, null, () => 1)).toBe(100)
  })

  it('caps the exponential', () => {
    expect(backoffDelayMs(9, policy, null, () => 1)).toBe(1000)
  })

  it('prefers the endpoint Retry-After, still capped', () => {
    expect(backoffDelayMs(1, policy, 400, () => 1)).toBe(400)
    expect(backoffDelayMs(1, policy, 60_000, () => 1)).toBe(1000)
  })
})

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    const source = scripted([ok()])
    const nap = fakeSleep()
    const response = await withRetry(source.fetch, policy, { sleep: nap.sleep })('u', {})
    expect(source.calls).toBe(1)
    expect(response.attempts).toBe(1)
    expect(nap.napped).toEqual([])
  })

  it('retries a 500 with growing backoff and reports the winning attempt', async () => {
    const source = scripted([fail(500), fail(500), ok()])
    const nap = fakeSleep()
    const response = await withRetry(source.fetch, policy, {
      sleep: nap.sleep,
      random: () => 0,
    })('u', {})
    expect(source.calls).toBe(3)
    expect(response.status).toBe(200)
    expect(response.attempts).toBe(3)
    expect(nap.napped).toEqual([50, 100])
  })

  it('gives up after maxAttempts and hands back the last failure', async () => {
    const source = scripted([fail(503)])
    const nap = fakeSleep()
    const response = await withRetry(source.fetch, policy, {
      sleep: nap.sleep,
      random: () => 0,
    })('u', {})
    expect(source.calls).toBe(policy.maxAttempts)
    expect(response.status).toBe(503)
    expect(response.attempts).toBe(policy.maxAttempts)
    expect(nap.napped).toEqual([50, 100, 200])
  })

  it('does not retry a status the endpoint meant', async () => {
    const source = scripted([fail(401)])
    const nap = fakeSleep()
    const response = await withRetry(source.fetch, policy, { sleep: nap.sleep })('u', {})
    expect(source.calls).toBe(1)
    expect(response.status).toBe(401)
    expect(nap.napped).toEqual([])
  })

  it('honours the endpoint Retry-After over its own backoff', async () => {
    const source = scripted([fail(429, { retryAfter: '2' }), ok()])
    const nap = fakeSleep()
    await withRetry(source.fetch, policy, { sleep: nap.sleep })('u', {})
    expect(nap.napped).toEqual([1000])
  })

  it('retries a thrown network error, then rethrows it', async () => {
    let calls = 0
    const flaky: StreamFetch = () => {
      calls++
      return Promise.reject(new Error('ECONNRESET'))
    }
    const nap = fakeSleep()
    await expect(withRetry(flaky, policy, { sleep: nap.sleep })('u', {})).rejects.toThrow(
      'ECONNRESET',
    )
    expect(calls).toBe(policy.maxAttempts)
  })

  it('recovers from a thrown error when a later attempt connects', async () => {
    let calls = 0
    const flaky: StreamFetch = () => {
      calls++
      return calls === 1 ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve(ok())
    }
    const nap = fakeSleep()
    const response = await withRetry(flaky, policy, { sleep: nap.sleep })('u', {})
    expect(response.status).toBe(200)
    expect(response.attempts).toBe(2)
  })

  it('stops retrying once the turn is aborted', async () => {
    const controller = new AbortController()
    const source = scripted([fail(500)])
    const nap = fakeSleep()
    const retrying = withRetry(source.fetch, policy, {
      sleep: (ms) => {
        controller.abort()
        return nap.sleep(ms)
      },
    })
    const response = await retrying('u', { signal: controller.signal })
    expect(source.calls).toBe(1)
    expect(response.status).toBe(500)
  })
})

describe('sleep', () => {
  it('resolves immediately for a non-positive delay', async () => {
    await expect(sleep(0)).resolves.toBeUndefined()
  })

  it('resolves as soon as the signal aborts', async () => {
    const controller = new AbortController()
    const waited = sleep(10_000, controller.signal)
    controller.abort()
    await expect(waited).resolves.toBeUndefined()
  })

  it('resolves without waiting when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(10_000, controller.signal)).resolves.toBeUndefined()
  })
})

describe('failure descriptions', () => {
  it('names the status and the endpoint own message', () => {
    expect(
      describeFailure(fail(500, { errorBody: '{"error":"upstream bedrock throttled"}' })),
    ).toBe('endpoint error 500: Internal Server Error — {"error":"upstream bedrock throttled"}')
  })

  it('reports how many attempts were spent', () => {
    expect(describeFailure(fail(500, { attempts: 5 }))).toBe(
      'endpoint error 500: Internal Server Error (5 attempts)',
    )
  })

  it('flattens and caps a body that is a whole error page', () => {
    const summary = summarizeErrorBody(`<html>\n  <body>\n    ${'x'.repeat(400)}\n`, 20)
    expect(summary).toBe('<html> <body> xxxxxx…')
  })

  it('treats a blank body as nothing said', () => {
    expect(summarizeErrorBody('   \n ')).toBeNull()
    expect(summarizeErrorBody(null)).toBeNull()
  })
})

describe('guardStream', () => {
  it('relays lines and reports nothing when the stream ends cleanly', async () => {
    const seen: string[] = []
    let fault: unknown = null
    for await (const line of guardStream(
      (async function* () {
        yield 'a'
        yield 'b'
      })(),
      (error) => (fault = error),
    )) {
      seen.push(line)
    }
    expect(seen).toEqual(['a', 'b'])
    expect(fault).toBeNull()
  })

  it('keeps what arrived and reports a mid-stream fault instead of throwing', async () => {
    const seen: string[] = []
    let fault: unknown = null
    for await (const line of guardStream(
      (async function* () {
        yield 'a'
        throw new Error('socket hang up')
      })(),
      (error) => (fault = error),
    )) {
      seen.push(line)
    }
    expect(seen).toEqual(['a'])
    expect(String(fault)).toContain('socket hang up')
  })
})
