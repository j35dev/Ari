import { Activity, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from '../src/features/composer/Composer'
import { installDictationTarget } from '../src/features/speech/target'
import { DictationRecoveryProvider } from '../src/features/speech/DictationRecovery'
import { applyCachedTheme } from '@ari/ui/theme-provider'
import { ToastProvider } from '@ari/ui/toast'
import '@ari/ui/fonts'
import '../src/styles/index.css'

applyCachedTheme()
installDictationTarget()
function Chats() {
  const [away, setAway] = useState(false)
  const onSend = () => {
    throw new Error('Dictation must not submit the composer')
  }
  return (
    <>
      <button type="button" data-switch-chat onClick={() => setAway((value) => !value)}>
        Switch chat
      </button>
      <Activity mode={away ? 'hidden' : 'visible'}>
        <Composer sessionId="dictation-native-fixture" onSend={onSend} />
      </Activity>
      <Activity mode={away ? 'visible' : 'hidden'}>
        <Composer sessionId="other-dictation-fixture" onSend={onSend} />
      </Activity>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <DictationRecoveryProvider>
      <Chats />
    </DictationRecoveryProvider>
  </ToastProvider>,
)
