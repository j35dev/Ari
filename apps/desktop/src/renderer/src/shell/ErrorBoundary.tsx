import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Shown above the retry button; defaults to a generic label. */
  label?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Contains render-phase crashes so one broken pane can never unmount the
 * whole app — the shell (sidebar, navigation) always stays alive.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  // React does not declare this static on Component; no override modifier.
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari] pane crashed:', this.props.label, error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6">
          <p className="text-sm font-medium text-danger">
            {this.props.label ?? 'This view'} hit an error
          </p>
          <p className="max-w-md truncate text-xs text-fg-subtle" title={this.state.error.message}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
