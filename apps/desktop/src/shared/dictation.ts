export interface DictationTarget {
  insert(text: string, current?: () => boolean): Promise<void>
  cancel(): void
}

export interface DictationBridge {
  acquire(): Promise<string>
  release(token: string): Promise<void>
}
