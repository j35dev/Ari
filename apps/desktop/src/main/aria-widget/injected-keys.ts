/** A failed assertion must never leave the user's desktop with keys held. */
export async function withInjectedKeys(
  hook: { keyToggle(key: number, toggle: 'down' | 'up'): void },
  keys: readonly number[],
  action: () => Promise<void>,
): Promise<void> {
  try {
    for (const key of keys) hook.keyToggle(key, 'down')
    await action()
  } finally {
    for (let index = keys.length - 1; index >= 0; index--) hook.keyToggle(keys[index]!, 'up')
  }
}
