import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { HomeScreen } from '../../src/features/home/HomeScreen'
import { SessionScreen } from '../../src/features/session/SessionScreen'
import { SettingsScreen } from '../../src/features/settings/SettingsScreen'
import { PairScreen } from '../../src/features/pair/PairScreen'
import { view, app } from './app-state'
import '../../src/styles/index.css'

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'porcelain' : 'obsidian'
localStorage.setItem('ari.theme', JSON.stringify({ mode: theme, wallpaper: 'none' }))
document.documentElement.dataset.ariTheme = theme
sessionStorage.setItem(`ari.draft:${app.origin}:fixture-phone:review-session`, 'Keep the draft on Studio while I switch computers.')
const noAction = () => {}
const content = view === 'settings' ? <SettingsScreen onBack={noAction} />
  : view === 'pair' ? <PairScreen invitationId={null} onInvitation={noAction} />
  : ['session', 'approval', 'files', 'changes', 'offline'].includes(view)
    ? <SessionScreen sessionId={view === 'approval' ? 'review-approval' : 'review-session'} onBack={noAction} onForked={noAction} />
    : <HomeScreen onOpen={noAction} onNewSession={noAction} onSettings={noAction} />
createRoot(document.getElementById('root')!).render(<ThemeProvider><div className="mobile-shell">{content}</div></ThemeProvider>)
