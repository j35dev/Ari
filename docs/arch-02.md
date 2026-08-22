# arch-02 — App shell

## Window chrome

Platform adapter seam in `apps/desktop/src/main/window.ts`:
- **Windows**: hidden frame + native `titleBarOverlay` (snap/max/min preserved)
- **macOS**: `hiddenInset` traffic lights
- **Linux**: hidden frame; custom controls rendered by the renderer titlebar

Window bounds persist across launches via the settings store (`window`
section), saved on resize/move/maximize events (debounced by Electron).

## Layout

Single-sidebar shell (T3-style): sessions grouped under collapsible project
sections, utility strip at the bottom switching the main pane. No icon rail —
all navigation lives inside one sidebar to avoid duplication.

## State

Navigation is state-based (`pane`) rather than URL-routed for v1; TanStack
Router is provisioned for when deep links arrive. Zustand stores bind to RPC
subscriptions via a store factory.
