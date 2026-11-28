export interface DictationTarget {
  insert(text: string, current?: () => boolean): Promise<void>
  cancel(): void
}

export interface DictationBridge {
  acquire(token?: string): Promise<string>
  release(token: string): Promise<void>
}
