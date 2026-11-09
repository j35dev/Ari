import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import '@ari/ui/tokens.css'
import { WidgetApp } from './App'
import './widget.css'

createRoot(document.getElementById('root')!).render(<WidgetApp />)
