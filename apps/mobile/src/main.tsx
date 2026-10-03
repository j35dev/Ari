import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import { applyCachedTheme, ThemeProvider } from '@ari/ui/theme-provider'
import { App } from './App'
import { AppProvider } from './lib/app-state'
import { defaultDeviceStore } from './lib/device-key'
import { trackViewport } from './lib/viewport'
import './styles/index.css'

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root element')

// Paints the cached theme immediately before hydration to prevent flashes
applyCachedTheme()
trackViewport()

/**
 * The device store is resolved before the first render rather than inside the
 * app: a phone either keeps its key in IndexedDB or falls back to memory, and
 * deciding that halfway through a render would show the user a pairing screen
 * for an instant before their paired session appears.
 */
const store = await defaultDeviceStore()

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider store={store}>
        <App />
      </AppProvider>
    </ThemeProvider>
  </StrictMode>,
)
