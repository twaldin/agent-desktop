# Native terminal renderer

`TerminalPanel` negotiates `tmux-v1` before selecting `NativeTerminalPanel`. The four native request methods cross Electron as `NativeTerminalResult<T>` envelopes; `native-terminal-bridge.ts` unwraps them once and preserves error codes/status. An explicit old-host capability result (or an old preload without these methods) selects a visibly limited legacy panel. Network, authentication, broken tmux and incompatible native responses never select raw replay after native negotiation.

`NativeTerminalView` owns one viewer UUID and one native attachment at a time. Each new attachment creates a new xterm instance at the host's accepted grid. Ring loss, epoch change, attachment expiry and shared geometry changes replace only the attachment/emulator. A fresh xterm discards unfinished parser state from the old PTY; no serialized history, evicted tail, synthetic Ctrl-L, synthetic resize or replayed keystrokes are used to recover a screen. Unmount/tab changes detach views without closing the underlying pane.

All viewers retain the accepted grid. Small panels scroll that complete grid; they do not silently fit the pane to local width. **Use this panel's size** issues one explicit shared resize with the expected geometry revision. The backend invalidates affected attachments, and every view reattaches before acknowledging its new grid. Naturally exited panes remain viewable while the backend reports `attachable`; final bytes drain with input disabled. Explicitly closed/interrupted panes retain separately labelled native history.

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

History uses a read-only text surface with native scrollback, captured current screen and saved normal screen kept explicit. Those fields never enter xterm or generate protocol replies.

## Source acceptance checkpoint

- `bun test apps/desktop/src/renderer/native-terminal-state.test.ts apps/desktop/src/renderer/native-xterm-input.test.ts apps/desktop/src/renderer/xterm-input.test.ts`: 11 tests, 66 assertions. This includes actual xterm parsing, paste/mouse bytes, disposed parser batches, stale generations and lost receipts.
- `native-terminal-browser-acceptance.tsx`: production React/view controller/xterm in hidden Electron with a controlled transport. Nine cases cover actual DOM keyboard/Unicode/paste/mouse/focus, composition, independent attachments, gap/reconnect/resize, stale input, natural exit, tabs and read-only history. Private evidence and wide/narrow captures: `.data/native-terminal-renderer-acceptance/`. Capture checks require visible screenshot text in the title, tab and terminal regions, not only DOM presence.
- `native-terminal-native-acceptance.ts`: production renderer through `TmuxTerminalsHttp` and `TmuxTerminalManager`, actual bundled tmux 3.7c and a disposable raw TUI. Seven cases cover two real Electron views of one native PID, DOM application-cursor/paste/mouse input, actual ring eviction while another view types, exactly one underlying query answer, partial-CSI continuation, exactly one intentional SIGWINCH and final output/history after natural exit. Private evidence: `.data/native-terminal-native-acceptance/`. Fixture shutdown verified no surviving program PIDs and removed its temporary data directory.

These are source/runtime checks, not installed release9 or physical two-device acceptance. The installed release8 applications, host processes, account/provider configuration and user sessions were not changed by these fixtures. Cross-platform packaging, installed multi-device terminal behavior and broader terminal parity remain part of the active goal.
