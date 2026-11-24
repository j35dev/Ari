Project drag browser regression fixture
======================================

From `apps/desktop`, run:

```powershell
pnpm exec vite build --config project-drag-fixture.config.ts
pnpm exec vite preview --config project-drag-fixture.config.ts --host 127.0.0.1 --port 4189
```

Open `http://127.0.0.1:4189/testing/project-drag.html` and click **Run checks**.
Results appear below the buttons and in `window.__ari.state()`, which Ari's
browser state tool can read. All eleven checks should pass with no errors and
zero remaining pointer/keyboard listeners. **Reset fixture** restores the
lists for manual native mouse/pointer testing.

The fixture imports the production hook and uses the sidebar's Motion row
binding, layout transition, and overflow anchoring policy. Its lists have
variable row heights and a real scroll container. Automated pointer events
run against real Chromium geometry, animation frames, and Motion playback;
manual dragging additionally exercises native mouse presses and releases.

Coverage includes full press travel, multiple moves within a frame, stable
DOM order until one drop commit, synchronous rebase before paint, continuous
scrolling in both directions, content bounds that exclude drag overflow,
target recomputation, cancellation, re-grabbing a settling row, a pre-arm
re-grab, grabbing a different row, and teardown during press/drag/settle.

Focused unit/integration checks (also from `apps/desktop`):

```powershell
pnpm exec vitest run src/renderer/src/shell/use-project-drag.test.tsx src/renderer/src/shell/use-project-drag.motion.test.tsx src/renderer/src/features/session/session-nav.test.ts
```

The lifecycle suite controls animation completion to assert interrupted
promise handling and exact listener cleanup deterministically. It does not
infer rendered motion from jsdom's geometry or wall-clock sampling.
