/**
 * Reads an agent's stderr for model-call errors that retrying cannot fix: the
 * account is out of usage, quota or credits, or its key is rejected.
 *
 * OpenCode is why this exists. When a model's usage runs out it logs
 * `Free usage limit reached …` within seconds, then keeps retrying with
 * backoff and says nothing over ACP, so the turn only ended at the 20-minute
 * stall watchdog. Its logs reach stderr when it runs with
 * `--print-logs --log-level ERROR`.
 *
 * Only lines shaped like a failed model call count (OpenCode's `stream error`
 * log, or the AI SDK's call/retry errors): an unrelated error elsewhere in the
 * log, such as an MCP server's "Unauthorized", must not end a healthy turn.
 * A plain rate limit is not fatal either: those clear, and the agent's own
 * retries recover from them.
 */
const MODEL_CALL = /message="stream error"|\bproviderID=|AI_APICallError|AI_RetryError/
const FATAL =
  /usage limit|quota|insufficient[ _](?:credits?|balance|funds|quota)|credit balance|out of credits|billing|payment required|subscription (?:required|expired|inactive)|invalid[ _]api[ _]key|api key (?:is )?(?:invalid|missing|expired)|unauthori[sz]ed|authentication (?:failed|error)/i
/** The longest message kept: enough for a provider's sentence and its link. */
const MAX = 400

export function fatalAgentError(line: string): string | null {
  if (!MODEL_CALL.test(line) || !FATAL.test(line)) return null
  // OpenCode logs `error.error="…"` (or `error.message="…"`) with the
  // provider's own words inside; anything else is reported as written.
  const quoted = /\berror(?:\.error|\.message)?="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
  const message = (quoted ?? line)
    .replace(/\\"/g, '"')
    .replace(/^AI_RetryError: Failed after \d+ attempts\. Last error: /, '')
    .replace(/^AI_\w+Error: /, '')
    .replace(/^Error: /, '')
    .trim()
  return message.length > 0 ? message.slice(0, MAX) : null
}
