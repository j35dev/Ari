import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@ari/ui/button'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import { Textarea } from '@ari/ui/textarea'
import { Field } from '@ari/ui/field'
import { Select } from '@ari/ui/select'
import { Switch } from '@ari/ui/switch'
import { Checkbox } from '@ari/ui/checkbox'
import { Badge } from '@ari/ui/badge'
import { Kbd } from '@ari/ui/kbd'
import { Tabs } from '@ari/ui/tabs'
import { SegmentedControl } from '@ari/ui/segmented-control'
import { ScrollArea } from '@ari/ui/scroll-area'
import { Skeleton } from '@ari/ui/skeleton'
import { Spinner } from '@ari/ui/spinner'
import { Popover } from '@ari/ui/popover'
import { Tooltip } from '@ari/ui/tooltip'
import { Dialog } from '@ari/ui/dialog'
import { Sheet } from '@ari/ui/sheet'
import { ToastProvider, useToast } from '@ari/ui/toast'
import type { ToastTone } from '@ari/ui/toast'

const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const

const BADGE_TONES = ['neutral', 'accent', 'success', 'warning', 'danger'] as const

const TOAST_TONES = ['neutral', 'success', 'warning', 'danger', 'info'] as const

/** Stand-in for the secondary Button look on compound-primitive triggers (no asChild support). */
const TRIGGER_BUTTON_CLASSES =
  'inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-3.5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-2xs mb-3 uppercase tracking-widest text-fg-subtle">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <circle cx="8" cy="8" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path
        d="M2.5 4h11M5.5 4V2.5h5V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ToastsDemo() {
  const { toast } = useToast()

  const fire = (tone: ToastTone) => {
    const label = tone.charAt(0).toUpperCase() + tone.slice(1)
    toast({
      title: `${label} toast`,
      description: 'Queued bottom-right; hover pauses the auto-dismiss timer.',
      tone,
      ...(tone === 'info'
        ? { action: { label: 'Undo', onClick: () => toast({ title: 'Undone', tone: 'neutral' }) } }
        : {}),
    })
  }

  return (
    <Row>
      {TOAST_TONES.map((tone) => (
        <Button key={tone} variant="secondary" size="sm" onClick={() => fire(tone)}>
          {tone}
        </Button>
      ))}
    </Row>
  )
}

/**
 * Temporary showcase surface rendering every merged @ari/ui primitive.
 * Replaced by the real router-mounted gallery in M2.
 */
export function GalleryView() {
  const [provider, setProvider] = useState('claude')

  return (
    <ToastProvider>
      <div className="ari-scroll h-full overflow-auto bg-bg p-8 text-fg">
        <div className="mx-auto flex max-w-3xl flex-col gap-10">
          <header className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">Component gallery</h1>
            <p className="text-sm text-fg-muted">
              Every merged primitive, themed live via design tokens.
            </p>
          </header>

          <Section title="Buttons">
            <Row>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant}>
                  {variant}
                </Button>
              ))}
            </Row>
            <Row>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size="sm">
                  {variant}
                </Button>
              ))}
            </Row>
            <Row>
              <Button variant="primary" loading>
                Saving
              </Button>
              <Button variant="secondary" shortcut="⌘K">
                Command palette
              </Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
            </Row>
          </Section>

          <Section title="Icon buttons">
            <Row>
              <IconButton icon={<PlusIcon />} aria-label="New session" />
              <IconButton icon={<GearIcon />} aria-label="Settings" variant="secondary" />
              <IconButton icon={<TrashIcon />} aria-label="Delete" variant="danger" />
              <IconButton icon={<PlusIcon />} aria-label="Add" size="sm" variant="ghost" />
            </Row>
          </Section>

          <Section title="Inputs">
            <div className="flex max-w-sm flex-col gap-4">
              <Field label="Project name" hint="Shown across sessions and journals.">
                {(controlProps) => <Input {...controlProps} placeholder="ari-core" />}
              </Field>
              <Field label="API key" error="Key rejected by the provider.">
                {(controlProps) => (
                  <Input {...controlProps} invalid type="password" placeholder="sk-…" />
                )}
              </Field>
              <Field label="System prompt" hint="Injected before every turn.">
                {(controlProps) => (
                  <Textarea
                    {...controlProps}
                    autoGrow
                    placeholder="You are a precise coding agent…"
                  />
                )}
              </Field>
            </div>
          </Section>

          <Section title="Select">
            <div className="max-w-xs">
              <Select
                value={provider}
                onValueChange={setProvider}
                placeholder="Choose provider…"
                options={[
                  { value: 'claude', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' },
                  { value: 'opencode', label: 'OpenCode' },
                  { value: 'grok', label: 'Grok CLI' },
                ]}
              />
            </div>
          </Section>

          <Section title="Switch · Checkbox · Badge · Kbd">
            <Row>
              <Switch defaultChecked aria-label="Auto-approve edits" />
              <Switch aria-label="Telemetry" />
              <Switch defaultChecked disabled aria-label="Locked switch" />
            </Row>
            <Row>
              <Checkbox defaultChecked>Notifications</Checkbox>
              <Checkbox>Pre-release channel</Checkbox>
              <Checkbox indeterminate>Select all</Checkbox>
            </Row>
            <Row>
              {BADGE_TONES.map((tone) => (
                <Badge key={tone} tone={tone}>
                  {tone}
                </Badge>
              ))}
            </Row>
            <Row>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
              <Kbd>Shift</Kbd>
              <Kbd>↵</Kbd>
              <span className="text-sm text-fg-muted">
                Send message <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
              </span>
            </Row>
          </Section>

          <Section title="Tabs · Segmented control">
            <Tabs defaultValue="transcript">
              <Tabs.List aria-label="Inspector">
                <Tabs.Tab value="transcript">Transcript</Tabs.Tab>
                <Tabs.Tab value="changes">Changes</Tabs.Tab>
                <Tabs.Tab value="terminal">Terminal</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="transcript">
                <p className="text-sm text-fg-muted">Streaming markdown blocks.</p>
              </Tabs.Panel>
              <Tabs.Panel value="changes">
                <p className="text-sm text-fg-muted">Per-turn diff hunks.</p>
              </Tabs.Panel>
              <Tabs.Panel value="terminal">
                <p className="text-sm text-fg-muted">xterm tabs live here.</p>
              </Tabs.Panel>
            </Tabs>
            <SegmentedControl
              defaultValue="ask"
              options={[
                { value: 'ask', label: 'Ask' },
                { value: 'edits', label: 'Allow edits' },
                { value: 'full', label: 'Full access' },
              ]}
            />
          </Section>

          <Section title="Popover · Tooltip">
            <Row>
              <Popover>
                <Popover.Trigger className={TRIGGER_BUTTON_CLASSES}>Open popover</Popover.Trigger>
                <Popover.Content side="bottom" align="start" className="w-64">
                  <p className="text-sm text-fg-muted">
                    Origin-aware menu-in motion — the panel grows from its anchor corner.
                  </p>
                </Popover.Content>
              </Popover>
              <Tooltip content="Create a new session" side="top">
                <Button variant="secondary">Hover me</Button>
              </Tooltip>
              <Tooltip content="Settings" side="right" delayMs={0}>
                <IconButton icon={<GearIcon />} aria-label="Settings" variant="ghost" />
              </Tooltip>
            </Row>
          </Section>

          <Section title="Dialog · Sheet">
            <Row>
              <Dialog>
                <Dialog.Trigger className={TRIGGER_BUTTON_CLASSES}>Open dialog</Dialog.Trigger>
                <Dialog.Content>
                  <Dialog.Title>Delete session?</Dialog.Title>
                  <Dialog.Description>
                    The journal is removed from disk. This cannot be undone.
                  </Dialog.Description>
                  <div className="mt-4 flex justify-end gap-2">
                    <Dialog.Close className={TRIGGER_BUTTON_CLASSES}>Cancel</Dialog.Close>
                    <Dialog.Close
                      className="inline-flex h-9 items-center justify-center rounded-md bg-danger px-3.5 text-sm font-medium text-fg-on-accent transition-colors duration-150 hover:bg-danger-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      Delete
                    </Dialog.Close>
                  </div>
                </Dialog.Content>
              </Dialog>
              <Sheet>
                <Sheet.Trigger className={TRIGGER_BUTTON_CLASSES}>Open sheet</Sheet.Trigger>
                <Sheet.Content side="right">
                  <Sheet.Title>Session details</Sheet.Title>
                  <Sheet.Description>
                    Edge-anchored panel with focus trap and slide motion.
                  </Sheet.Description>
                  <div className="mt-4 flex justify-end">
                    <Sheet.Close className={TRIGGER_BUTTON_CLASSES}>Close</Sheet.Close>
                  </div>
                </Sheet.Content>
              </Sheet>
            </Row>
          </Section>

          <Section title="Scroll area">
            <ScrollArea className="h-40 rounded-md border border-border bg-surface-1 p-3">
              <div className="flex flex-col gap-2">
                {Array.from({ length: 16 }, (_, i) => (
                  <p key={i} className="text-sm text-fg-muted">
                    Journal line {String(i + 1).padStart(2, '0')} — append-only, fsync-batched.
                  </p>
                ))}
              </div>
            </ScrollArea>
          </Section>

          <Section title="Skeletons">
            <div className="flex items-center gap-3">
              <Skeleton w={40} h={40} className="rounded-full" />
              <div className="flex flex-col gap-2">
                <Skeleton w={180} h={12} />
                <Skeleton w={120} h={12} />
              </div>
            </div>
            <Skeleton w="100%" h={64} />
          </Section>

          <Section title="Spinners">
            <Row>
              <Spinner size="sm" />
              <Spinner size="md" className="text-accent" />
              <Spinner size="lg" className="text-fg-muted" />
            </Row>
          </Section>

          <Section title="Toasts">
            <ToastsDemo />
          </Section>
        </div>
      </div>
    </ToastProvider>
  )
}
