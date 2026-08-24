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

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary label="Ari">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
