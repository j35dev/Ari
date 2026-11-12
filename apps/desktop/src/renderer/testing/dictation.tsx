import { createRoot } from 'react-dom/client'
import { Composer } from '../src/features/composer/Composer'
import { installDictationTarget } from '../src/features/speech/target'
import { applyCachedTheme } from '@ari/ui/theme-provider'
import '@ari/ui/fonts'
import '../src/styles/index.css'

applyCachedTheme()
installDictationTarget()
createRoot(document.getElementById('root')!).render(
  <Composer
    sessionId="dictation-native-fixture"
    onSend={() => {
      throw new Error('Dictation must not submit the composer')
    }}
  />,
)
