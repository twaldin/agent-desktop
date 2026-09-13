# Native terminal renderer

The normal dock path is `App` → `DockTerminal` → `NativeTerminalViewport`. Explicit add-menu selection and Terminal-local Command-T create a sibling; the application Terminal shortcut reuses the selected workspace terminal. Command-T resolves the initiating tab's current pane and refuses a different foreground workspace rather than redirecting creation. The retained `TerminalWindowOwner` still owns admission, durable checkpointing and uncertain-result recovery.

`TerminalPanel` separately negotiates `tmux-v1` before selecting `NativeTerminalPanel`. The four native request methods cross Electron as `NativeTerminalResult<T>` envelopes; `native-terminal-bridge.ts` unwraps them once and preserves error codes/status. An explicit old-host capability result (or an old preload without these methods) selects a visibly limited legacy panel. Network, authentication, broken tmux and incompatible native responses never select raw replay after native negotiation.

`NativeTerminalView` owns one viewer UUID and one native attachment at a time. Each new attachment creates a new xterm instance at the host's accepted grid. Ring loss, epoch change, attachment expiry and shared geometry changes replace only the attachment/emulator. A fresh xterm discards unfinished parser state from the old PTY; no serialized history, evicted tail, synthetic Ctrl-L, synthetic resize or replayed keystrokes are used to recover a screen. Unmount/tab changes detach views without closing the underlying pane.

All viewers retain the accepted grid. Small panels scroll that complete grid; they do not silently fit the pane to local width. **Use this panel's size** issues one explicit shared resize with the expected geometry revision. The backend invalidates affected attachments, and every view reattaches before acknowledging its new grid. Naturally exited panes remain viewable while the backend reports `attachable`; final bytes drain with input disabled. Explicitly closed/interrupted panes retain separately labelled native history.

Attachment replacement preserves focus outside the terminal. A previously focused terminal can regain focus after a replacement, including intermediate stale-attachment retries, but another viewer cannot steal it. Initial-open focus remains distinct from background recovery.

The native surface uses the pinned bar cursor, line-height 1.2 and 16px start / 8px top / 12px bottom padding. This changes display geometry, not the accepted PTY grid. Existing application font/color tokens remain authoritative; the explicit shared-size control and truthful history/offline states are intentional multi-viewer adaptations.

`NativeTerminalInputQueue` captures attachment ID, input epoch and geometry revision for each input. It admits input only after a heartbeat acknowledges parsed output and the rendered grid. Native stale/uncertain outcomes or lost transport receipts pause input and discard the queued tail. Reconnect never retries keystrokes. Explicit resume begins a new client stream after acknowledgement.

| Input source | Route |
| --- | --- |
| Keyboard special keys/modifiers/keypad | Native allowlisted key; host uses actual pane modes |
| Character/IME text | Native text, preserving xterm's platform Option/AltGraph behavior |
| Clipboard paste | Raw paste before xterm's bracketed-paste conversion |
| Mouse | Actual xterm mouse service's restricted, 1-based full-grid cells and SGR button bits |
| Binary source | Canonical base64 bytes |
| Focus/blur | Fixed attachment focus metadata; tmux aggregates client focus |
| Parser query answers | Attachment ID plus output sequence/ordinal; never user input |

The pinned xterm 6.0.0 seams are guarded at runtime and covered with the real parser/DOM. `xterm-input.ts` separates parser replies using the actual parser stack. `native-xterm-input.ts` preserves paste/mouse/focus provenance before escape encoding and delegates platform composition checks to xterm. Parser disposal rejects pending writes so an expired attachment cannot strand its controller.

Symbolic keys must exist in the bundled tmux key table: unsupported keypad-equals/comma and F13+ names cannot reach `send-keys`, which otherwise types unknown names literally. The renderer leaves those events to xterm's encoder. Unmodified Command-arrow, Command-Backspace and Command-Delete use the pinned C-a/C-e/C-u/C-k semantics without overriding composition or other modifier chords.

Native tmux clients explicitly use UTF-8 mode (`-u`), independent of the host locale. Otherwise a valid Unicode pane can produce underscore substitutions in an attachment even while native history remains correct. Shell environment and workspace ownership are unchanged; shell `cd` does not retarget the owning workspace or its recorded launch directory.

History uses a read-only text surface with native scrollback, captured current screen and saved normal screen kept explicit. Find searches those loaded sections locally as literal, case-insensitive text, reports the complete match count, wraps in both directions and never enters xterm or generates protocol replies. Its selection key includes the host, terminal, server generation, revision, capture time and query, so a different owner or capture cannot reuse a stale text offset; refresh retains the query and recomputes its selection against the new capture.

## Source acceptance checkpoint

- Use the repository `bun run test` runner for `native-terminal-state.test.ts`, `native-xterm-input.test.ts`, `xterm-input.test.ts`, terminal creation/window ownership tests, and the host terminal tests. Real native-manager integration requires `AGENT_TEST_TMUX_BUNDLE` pointing at a verified immutable bundle. Regressions cover unsupported native key names and C-locale Unicode attachment output in addition to the existing lifetime/receipt/grid invariants.
- `native-terminal-history-find.test.ts`: literal and case-insensitive matching with original UTF-16 offsets, regex metacharacters, section boundaries, whitespace queries, truthful empty results, wrapping and rejection of stale owner/generation/revision selections.
- `native-terminal-browser-acceptance.tsx`: production React/view controller/xterm in real Electron DOM with a controlled transport. It covers keyboard/Unicode/paste/mouse/focus, composition, independent attachments, gap/reconnect/resize, stale input, natural exit, tabs and read-only history. Reconnect must preserve a separate input's focus; a shared resize must restore only the previously focused terminal viewer. This is not native-host or installed-app acceptance.
- `native-terminal-native-acceptance.ts`: production renderer through `TmuxTerminalsHttp` and `TmuxTerminalManager`, actual bundled tmux 3.7c and a disposable raw TUI. Seven cases cover two real Electron views of one native PID, DOM application-cursor/paste/mouse input, actual ring eviction while another view types, exactly one underlying query answer, partial-CSI continuation, exactly one intentional SIGWINCH and final output/history after natural exit. Private evidence: `.data/native-terminal-native-acceptance/`. Fixture shutdown verified no surviving program PIDs and removed its temporary data directory.
- `scripts/acceptance/native-terminal-history-find-app/`: isolated native Find fixture for the real App and host. Retained 009 covers the wide local Find interactions, 010 separately covers the compact offline retained capture, and 011 separately covers distinct live and saved owners; no single run combines those scopes. These captures do not establish reference pixels, composing-IME behavior, `truncated: true`, recovery or return-tab persistence. Runs 001–011 also predate the guarded-Bun hash fence in the current fixture and are not retroactive proof of that revised launcher; future runs must produce new preparation and startup evidence.

These source/runtime checks do not replace packaged-release or physical multi-device acceptance. Pinned reference behavior and the app's stronger shared-host ownership contract must remain distinguished; no mock transport or still capture establishes complete runtime parity.
