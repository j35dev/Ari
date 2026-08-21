import { createContext, useContext, useId, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  KeyboardEvent,
  ReactNode,
} from 'react'
import { motion } from 'motion/react'

interface TabsContextValue {
  baseId: string
  value: string
  setValue: (value: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabs(component: string): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error(`${component} must be rendered inside <Tabs>`)
  return ctx
}

export interface TabsProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  /** Controlled selected tab value; provide together with onValueChange. */
  value?: string
  /** Initially selected tab value for uncontrolled usage. */
  defaultValue?: string
  /** Called with the newly selected tab value. */
  onValueChange?: (value: string) => void
}

function TabsRoot({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
  ...rest
}: TabsProps) {
  const [internal, setInternal] = useState(defaultValue ?? '')
  const isControlled = value !== undefined
  const current = isControlled ? value : internal
  const baseId = useId().replace(/\W/g, '')

  const setValue = (next: string) => {
    if (!isControlled) setInternal(next)
    onValueChange?.(next)
  }

  return (
    <TabsContext.Provider value={{ baseId, value: current, setValue }}>
      <div className={className} {...rest}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

export interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the tablist. */
  'aria-label'?: string
}

/** Row of tabs implementing the WAI-ARIA tabs pattern with roving tabindex. */
function TabsList({ className, children, ...rest }: TabsListProps) {
  const ctx = useTabs('Tabs.List')

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
    if (!tab || !event.currentTarget.contains(tab)) return
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    )
    const index = tabs.indexOf(tab)
    if (index === -1) return
    let next: number
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const target = tabs[next]
    if (!target) return
    target.focus()
    ctx.setValue(target.dataset.value ?? '')
  }

  return (
    <div
      role="tablist"
      onKeyDown={handleKeyDown}
      className={['inline-flex items-center gap-1', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Value identifying this tab; must match a Tabs.Panel value. */
  value: string
  children?: ReactNode
}

/** Single tab button; hosts the shared-layoutId active indicator when selected. */
function TabsTab({ value, className, children, type, ...rest }: TabProps) {
  const ctx = useTabs('Tabs.Tab')
  const selected = ctx.value === value

  return (
    <button
      type={type ?? 'button'}
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      data-value={value}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => ctx.setValue(value)}
      className={[
        'relative inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        selected ? 'text-fg' : 'text-fg-muted hover:bg-surface-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
      {selected && (
        <motion.span
          layoutId={`${ctx.baseId}-tab-indicator`}
          data-indicator=""
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
          transition={{ duration: 0.2, ease: 'easeOut' }}
        />
      )}
    </button>
  )
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Value of the tab this panel displays; must match a Tabs.Tab value. */
  value: string
  children?: ReactNode
}

/** Content region for a tab; stays mounted and is hidden while inactive. */
function TabsPanel({ value, className, children, ...rest }: TabPanelProps) {
  const ctx = useTabs('Tabs.Panel')
  const selected = ctx.value === value

  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      hidden={!selected}
      tabIndex={0}
      className={[
        'pt-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * Compound tabs component following the WAI-ARIA tabs pattern:
 * `<Tabs><Tabs.List><Tabs.Tab/></Tabs.List><Tabs.Panel/></Tabs>`.
 * ArrowLeft/ArrowRight/Home/End move focus with automatic activation; the
 * active underline slides between tabs via a shared motion layoutId.
 */
export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
})
