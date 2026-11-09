/** Merge-time fallback: the speech worker supplies the real microphone recorder. */
export function startRecording(): Promise<{
  stop(): Promise<Float32Array>
  cancel(): void
  level(): number
}> {
  return Promise.resolve({
    stop: () => Promise.resolve(new Float32Array()),
    cancel: () => undefined,
    level: () => 0,
  })
}
