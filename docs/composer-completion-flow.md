# Composer completion flow

The main composer uses commands, skills, file references and argument completions from its owning OMP session. App actions retain their separate explicit execution path. A suggestion must not silently dispatch a prompt, change the owning session, or invent native capabilities.

## Acceptance

1. Show native command/skill results and complete them with Tab without dispatch. Enter/click selects the current eligible result; app actions execute only through their explicit action handler. Pointer selection preserves input focus.
2. Arrow Up/Down and macOS Control P/N wrap eligible items while focus stays in the editor. Escape dismisses the popup without clearing text. Composition events and modified submission shortcuts retain their existing guards.
3. Insert file mentions with the original host, absolute path and authored text position. Persist that structured source through the existing host draft contract.
4. Loading and empty menus own unmodified Enter. A native completion error or diagnostic remains visible even when no rows exist. Keep Retry on operational errors and preserve query text.
5. Disconnection makes cached native rows unavailable. Reconnection may refresh the same owner. A retained selection callback must check its captured host/session/draft scope and current text before changing input.
6. Use the pinned caret popup geometry for the main rich composer: width at most 360 CSS pixels, 12-pixel viewport inset, 8-pixel caret gap, default above placement with the existing CSS placement override. Keep the popup aligned when its text, editor layout, scrolling or viewport changes. Use Electron's 4-pixel menu gutter and 30-pixel rows, with the shared corner scale. The editor exposes its real ProseMirror coordinates; do not position against the whole form.
7. Preserve native argument callback failures, exact-once explicit command dispatch, and source ownership through actual desktop transport, authenticated host and disposable OMP worker. Do not require a provider/model account for completion verification.

## Verification and limits

Run `bun scripts/acceptance/composer-flow-fixture/run.ts .data/composer-flow-check` from the repository root. The output directory must be new. This opens an isolated Electron App and disposable authenticated host/OMP worker, exercises real keyboard and pointer input, saves screenshots and source hashes, and closes its owned processes. It registers a local extension and project skill; it does not send provider prompts. The fixture uses a named IPC adapter for the exposed desktop methods, rather than the production main-process initialization. Its delayed completion and reconnect controls are explicit fixture boundaries.

The fixture verifies native command discovery and argument completion, skill insertion by keyboard and pointer, structured file persistence, visible diagnostics, held-query/empty-query Enter behavior, disconnect/reconnect, measured caret placement and a single explicit native command receipt. It records each failure rather than treating partial passes as a full run. Existing focused unit tests cover token parsing and catalogue ownership.

The pinned 7982 source provides geometry, keyboard and menu rules. The source trace is not a same-state pixel comparison with a live reference. Exact glyph variants, all home/expanded tray placements, hosted integrations, streamed/cancellable file-search transport, native OS IME and physical multi-machine parity remain separate work. Native OMP labels and available operations deliberately come from the owning host. The current transport ignores stale completion publications but does not cancel already-dispatched native work.
