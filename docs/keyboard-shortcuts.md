# App shortcut ownership

The helper is integrated into the source 12 App; it is not installed-app acceptance. `apps/desktop/src/renderer/app-shortcuts.ts` owns only the four existing app actions. It does not add composer history, send/steer/stop, attachment, model, terminal or editor commands.

| Binding | Existing action |
| --- | --- |
| Command+N on macOS; Control+N elsewhere | New chat |
| Command+K; Control+K | Show sidebar search and focus its input |
| Command+Backslash; Control+Backslash | Toggle sidebar |
| Command+Comma; Control+Comma | Open settings |

The previous `App.tsx` listener matched either modifier on every platform, ignored `defaultPrevented`, and intercepted input regardless of its owner. The helper registers a bubble-phase listener, respects handled events and IME (including key code 229 and an active composition), ignores repeats and extra modifiers, and consumes an event only when it invokes an app action. Unmodified keys, Escape, Enter and editor save remain untouched. Matching uses the produced `KeyboardEvent.key`; it does not assign physical key positions for alternate layouts.

The composer explicitly opts into app commands. Ordinary inputs, textareas, selects, rich editors and shadow editors retain their input. Focus within current file editor, xterm/native terminal, and pending-interaction surfaces also defers commands. `data-app-shortcuts="off"` gives future focused surfaces the same boundary. Visible native/ARIA dialogs and current menus block app actions even if focus has not moved yet; `blocked()` covers React-owned transient state before it reaches the DOM. Hidden/closed popups do not block. Commands still work on ordinary app buttons and transcript surfaces.

## App integration

The App integration uses this import:

```tsx
import { installAppShortcuts } from "./app-shortcuts";
```

It replaces the previous `onKey` effect following `newConversation` with:

```tsx
useEffect(() => installAppShortcuts(window, {
  composer: () => textarea.current,
  blocked: () => Boolean(dialog || menuOpen || appMenuOpen),
  actions: {
    "new-chat": () => newConversation(),
    search: () => {
      setSidebarOpen(true);
      setSearchOpen(true);
      requestAnimationFrame(() => searchInput.current?.focus());
    },
    sidebar: () => setSidebarOpen(value => !value),
    settings: () => {
      setSettingsOpen(true);
      setAppMenuOpen(false);
    },
  },
}), [newConversation, dialog, menuOpen, appMenuOpen]);
```

Do not keep the old listener alongside this one. The unrelated Escape/menu listener, scoped input handlers and Electron menu remain separately owned. Additional transient permission dialogs should be included in `blocked()` if they are not represented by a visible native/ARIA dialog.

## Evidence

- `bun test apps/desktop/src/renderer/app-shortcuts.test.ts`: four tests, 38 assertions covering platform modifier collisions, IME, handled events, repeats and unsupported bindings.
- `bun scripts/acceptance/app-shortcuts.ts .data/app-shortcuts-acceptance-source11`: eight controlled DOM acceptance groups in Electron 44.2.0, using the production helper, production `ModelPicker`, real xterm 6.0.0 and production `wireNativeXtermInput`. It verifies propagation, composer opt-in, native/rich/shadow editor boundaries, open/closed popup ownership, model arrow/Enter/cancel/focus behavior, native Control key mapping, and listener cleanup/remount.
- The same hidden Electron process delivered `sendInputEvent` Command+N. The received DOM event was `isTrusted: true`, targeted the focused composer, was prevented by the helper, and invoked exactly one new-chat callback. The controlled prompt text remained unchanged. This is actual Electron input dispatch, not an OS keyboard event from a user.
- Private result: `.data/app-shortcuts-acceptance-source11/result.json`. Browser viewport 1000×768 CSS pixels, DPR 2. Dedicated temporary profile and a hidden window; no app host, provider, real terminal shell, existing profile or installed app was touched.

Remaining acceptance: rebuild and exercise shortcuts with actual installed composer/editor/terminal/menu focus and a real IME. Synthetic `cancel` exercises the production picker cancel handler separately because synthetic Escape does not execute browser default actions. This fixture does not establish OS menu accelerator arbitration, real text-editing default behavior on every platform, alternate keyboard layout coverage, menu arrow navigation, or the other composer-parity keyboard gaps. No full keyboard parity claim follows from these tests.
