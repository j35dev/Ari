# SnapShots

SnapShots captures the window you're working in and attaches the screenshot to your current
draft. It stays off until you enable it in **Settings → SnapShots**. Window capture currently
supports Windows.

Choose **Global shortcut**, press a key chord, and select **Save**. The default on Windows is
**Ctrl+Alt+P**. Ari refuses its own keybindings, dictation shortcuts, common app commands, and
shortcuts the operating system cannot register. Turning SnapShots off releases the shortcut.

Press the shortcut in any app. The captured image appears over that window and settles into
a small confirmation on the same screen. Ari stays in the background and your keyboard focus
stays in the app you're using. If Ari's composer is already visible, the image can land directly
in its attachment strip. Pressing the shortcut with Ari in front captures Ari itself.

The image attaches to the current chat or project draft. When there is no open chat, Ari uses
the most recent session, or creates a draft in an available project. Capturing does not change
which chat or settings page is open. The draft remains unsent until you send it.

Drafts hold up to four images. Further captures wait on disk for an attachment slot to open.
Pending captures survive a restart and keep the draft they were assigned to. Saved image bytes
also restore after restarting Ari, including in project drafts and drafts for remote sessions.
Captures for a remote session stay on this PC until you send them.

**Animate captures** controls desktop feedback. Reduced motion replaces the flying preview with
a brief stationary confirmation. **Capture sound** controls the quiet camera click independently.

Windows verification evidence is in `docs/screenshots/snapshots`. `desktop-flight.png` contains
the transparent overlay layer; `source-window.png` shows its source. `composer-attachment.png`
shows the screenshot restored in the composer after restarting Ari. `result.json` records the
foreground, caret, draft persistence and overlay cleanup checks.
