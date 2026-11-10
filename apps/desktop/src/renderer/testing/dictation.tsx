import { createRoot } from 'react-dom/client'
import { Composer } from '../src/features/composer/Composer'
import { installDictationTarget } from '../src/features/speech/target'

installDictationTarget()
createRoot(document.getElementById('root')!).render(
  <Composer
    sessionId="dictation-native-fixture"
    onSend={() => {
      throw new Error('Dictation must not submit the composer')
    }}
  />,
)
