import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyCachedTheme } from '@ari/ui/theme-provider'
import { App } from './App'
import { ErrorBoundary } from './shell/ErrorBoundary'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

// Runs before the first React paint so a pinned light theme never flashes dark.
applyCachedTheme()

// The window's first frame is the launch canvas, not the themed app
// background. App clears the flag once the launch animation hands over
// (see features/moment/awaken-splash.css).
document.documentElement.dataset['ariBooting'] = 'on'

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary label="Ari">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
