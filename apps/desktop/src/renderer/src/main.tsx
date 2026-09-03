import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyCachedTheme } from '@ari/ui/theme-provider'
// Fonts arrive as a JS module, not through a CSS `@import`: Tailwind inlines
// CSS imports before Vite can rebase their `url()` references, which left the
// vendored woff2 files unbundled in production builds.
import '@ari/ui/fonts'
import { App } from './App'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { installExternalLinkInterceptor } from './lib/external-links'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

// Runs before the first React paint so a pinned light theme never flashes dark.
applyCachedTheme()

// The window's first frame is the launch canvas, not the themed app
// background. App clears the flag once the launch animation hands over
// (see features/moment/awaken-splash.css).
document.documentElement.dataset['ariBooting'] = 'on'

// Links inside the ADE (agent markdown) open in the OS browser instead of
// navigating the window away; the main process re-guards this as a safety net.
installExternalLinkInterceptor()

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary label="Ari">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
