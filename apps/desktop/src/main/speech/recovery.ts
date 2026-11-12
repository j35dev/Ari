import { clipboard, dialog } from 'electron'

/** A rejected target must not silently discard successful speech or paste into a different app. */
export async function recoverDictation(text: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Dictated text kept for review',
    message:
      'Your dictated text could not be inserted or sent. You can copy it into the intended field.',
    detail: text,
    buttons: ['Copy dictated text', 'Dismiss'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  // Only an explicit click replaces the clipboard. Never automatically retry an uncertain insertion.
  if (response === 0) clipboard.writeText(text)
}
