# Terminal transport and desktop emulator

`TerminalsHttp` adapts the owning host's `TerminalManager` after the server's normal local-token or authenticated Tailscale peer check. It resolves catalog project/session targets synchronously before shell creation. Requests cannot supply a cwd, executable or environment. The renderer uses the existing desktop bridge; terminal traffic never enters the durable generic command journal.

| POST route | Request | Result |
| --- | --- | --- |
| `/v1/terminals/query` | `list` with optional target, or `replay` with terminal ID/cursor | Terminal metadata or bounded output replay |
| `/v1/terminals/action` | Create, resize, close, forget, or viewer lease/progress | Terminal metadata or responder lease |
| `/v1/terminals/input` | Client UUID, input sequence, data and optional encoding/reply reference | Sequence receipt, duplicate flag, accepted flag |

Unknown fields, malformed IDs, oversized bodies and invalid cursors fail visibly. Input accepts UTF-8 text or canonical base64 encoding of at most 64 KiB of bytes. Base64 is decoded into `Uint8Array` before the native PTY write, preserving xterm's legacy binary mouse reports. Native input acceptance is not evidence that a shell command finished.

Each ephemeral `(terminal, client)` input stream starts at sequence 1 and advances serially. The host retains 128 payload hashes/receipts per stream and a high-water mark. A repeated sequence with the same payload returns its original receipt without another native write; changed, expired or reordered sequences fail. There are at most 1,024 retained streams, removed when the terminal is forgotten. No stream data survives host restart. The renderer orders user input, bounds queued input and pauses on uncertain delivery. Reconnection never replays user keystrokes. Explicit resume drops the queued tail and starts a new stream.

Output invalidations contain only the latest terminal cursor, coalesced over 40 ms. State/exit/removal invalidations are immediate. They travel on the existing authenticated event connection without durable event sequence numbers. Each renderer fetches bounded replay, advances its cursor only after parsing, discards duplicate output and polls as a recovery fallback. Connection restoration triggers list/replay resynchronization. Hiding a panel detaches its renderer; the host shell continues. The selected terminal tab is local window state, retained by host/target ID in local storage.

## One reply responder per terminal

Emulator-generated answers to terminal queries are separate from keyboard, paste, mouse and focus input. The host grants one six-second responder lease per terminal. Visible active views renew the lease; hidden/unmounted views release it. Only its holder fits the native PTY size. Other views adopt the accepted shared dimensions and can still send user input.

The first attachment treats pre-existing output as history. A terminal created with its viewer ID starts a lease at output sequence zero so shell-startup queries can be answered. Live parser answers carry the lease ID, output chunk sequence and per-chunk reply ordinal. The host drops old-lease or already-completed answers, and retains accepted reply identities until parsed progress is acknowledged. A new responder reconstructs its parser from retained output and answers only uncompleted live queries. If the prior viewer disappeared after native acceptance but before receiving its receipt, takeover cannot write that reply a second time. Old viewers cannot advance the new lease's committed cursor. Reply identity storage is bounded to 2,048 unacknowledged answers per terminal.

`TerminalPanel` uses exact `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0. Its public `onData` event combines user input and query answers. `xterm-input.ts` isolates a version-checked internal seam around `coreService.triggerDataEvent(data, wasUserInput)` and `_inputHandler.parse`. It recognizes the actual parser call stack rather than guessing from escape bytes or treating every event during an asynchronous write as a reply. Keyboard/paste between parser slices remains user input. Batched writes preserve per-chunk reply identities while letting xterm drain output in its own time slices. An xterm update must pass these integration tests before this pinned seam is accepted.

The panel observes shared terminal colors/fonts, root theme changes and the OS appearance setting. Browser-supported CSS colors are converted to RGBA for xterm. Native keyboard input, bracketed paste, selection/copy, binary input and accepted-size fitting use the actual emulator. Invalidations do not cause React renders per output byte.

The host's bounded output ring is not a complete terminal screen snapshot after eviction. This is an open parity defect: a new device must recover the actual current TUI without asking the program to redraw. The current release reports the missing prefix, but that reporting does not satisfy the goal. Terminal history/processes remain in-memory host resources, as described in [the manager contract](terminals/README.md). The design spike below addresses screen recovery while the owning host and shell remain alive; crash restoration is a separate lifecycle concern.

## Validation

Run `bun test apps/host/src/terminals-http.test.ts apps/desktop/src/renderer/xterm-input.test.ts`. These tests use actual temporary Bash shells, HTTP requests, raw byte readers and real xterm parsers. They cover catalog ownership/schema limits, duplicate and reordered native input, lost accepted user receipts, replay gaps, parser reply identity, keyboard/bracketed paste separation, lease expiry/takeover after a lost reply receipt, exact binary roundtrip, detach and explicit close. Manager tests separately verify the native PTY on macOS and Linux. Server transport tests separately cover authentication and live websocket delivery.

An isolated two-page Safari fixture also exercised the production `TerminalPanel` and actual host adapter/shells. It verified keyboard commands and output files, paste, ANSI color, live background/font changes (including `oklch`), two independent shells, hidden container sizing, selected-tab restoration, same-shell reattachment and explicit exit states. A live native query loop completed 473 queries with exactly 473 replies through responder and visibility handovers. Visual inspection found and fixed Safari percentage-height footer clipping and xterm's default black viewport strip. Both test shells, browser tabs and fixture services were closed afterward. This browser acceptance is distinct from packaged Electron or physical cross-device terminal acceptance.

## Fullscreen recovery design spike — 2026-09-05

**Recommendation:** do not implement “headless + `serialize()`” as though it were exact restoration. First prove an app-private tmux server with a normal attach PTY per viewer. That uses an existing terminal interpreter and redraw path instead of maintaining a second terminal-state codec. This is a proposed next slice, not a runtime decision or a completed parity claim; release 6 runtime, shared types, renderer, dependencies and lockfile were left unchanged during this investigation.

### Verified headless candidate

The npm registry's current stable versions are [`@xterm/headless` 6.0.0](https://registry.npmjs.org/@xterm/headless/6.0.0) and [`@xterm/addon-serialize` 0.14.0](https://registry.npmjs.org/@xterm/addon-serialize/0.14.0). Both identify source commit `f447274f430fd22513f6adbf9862d19524471c04`, matching the existing xterm 6 release. Their published tarball SHA-512 integrity values were checked; both ran together under the pinned Bun 1.3.14 in a temporary directory. No package was installed into this project.

The addon serializes normal-buffer cells, the active alternate buffer, cursor position, SGR attributes and a selected list of modes. Its API recommends restoring at the original dimensions before resizing. The [exact serializer implementation](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-serialize/src/SerializeAddon.ts) and [typed contract](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-serialize/typings/addon-serialize.d.ts) do not constitute a full interpreter-state export.

These were actual source→serialize→fresh-terminal→same-next-input probes, using 20×6 real headless emulators:

| Probe | Observed result |
| --- | --- |
| Normal cells, basic colors, wide/combining text | Tested examples restored and continued correctly |
| Alternate screen followed by returning to normal | Tested example restored and continued correctly |
| Cursor at the last column with pending wrap | Tested example continued correctly |
| Margins plus origin mode | Restored margins became full-height; next newline wrote on the wrong row |
| `ESC 7` saved cursor, then later `ESC 8` | Snapshot looked equal; continuation wrote at home instead of saved row 3/column 4 |
| Custom tab stops | Snapshot looked equal; next tab used the default column 9 instead of column 5 |
| DEC line-drawing charset | Existing lines looked correct; later `q` characters became literal letters |
| Hidden cursor; SGR mouse encoding | Cursor visibility and mouse encoding were lost despite matching public mode values |
| Snapshot after incomplete `ESC [ 31` | Next `mRED` became visible `mRED` instead of finishing the color sequence |

Additional source omissions to cover in any headless restoration implementation include extended underline attributes, OSC hyperlinks and dynamic palette/title state. Passing a screenshot comparison alone is insufficient: subsequent cursor restore, scrolling, input encoding and split control sequences must still behave identically. The [upstream mode tests](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/addons/addon-serialize/test/SerializeAddon.test.ts) test the supported subset; they do not close these continuation failures.

Headless can be the sole query responder: actual DSR, DA, DECRQM and DECRQSS probes emitted responses with no viewer. Character-size reporting works when `windowOptions.getWinSizeChars` is enabled. Color queries produced no reply, and pixel/cell-size reporting still needs host-owned metadata/handlers. This follows the split between [headless listeners](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/headless/Terminal.ts) and [the common input handler's color/window events](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/InputHandler.ts). A headless design would remove the reply lease and its takeover receipts; a size/geometry owner would remain. Renderer parser replies would be suppressed rather than forwarded to the shell.

Finite scrollback alone is not a memory budget. The implementation has a 50-million-unit write watermark and a 10-million-unit OSC/DCS payload limit, while a cell's combining string can keep growing. See [WriteBuffer](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/input/WriteBuffer.ts), [parser limits](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/parser/Constants.ts), and [BufferLine](https://github.com/xtermjs/xterm.js/blob/f447274f430fd22513f6adbf9862d19524471c04/src/common/buffer/BufferLine.ts). A host implementation needs explicit queue, retained-cell/string and snapshot-byte budgets with real backpressure. Dropping interpreter input at a watermark would silently corrupt the current screen.

If staying with headless is preferred, the real work is either a pinned complete continuation-state codec or a host-rendered frame/delta protocol. The former must include both buffers, wrap flags, attributes, saved state, margins, tabs, charset, mouse/cursor modes, links/palette, and pending CSI/OSC/DCS state. The latter keeps interpretation exclusively on the host and transmits display changes plus input modes, avoiding parser-state restoration but adding a renderer protocol. Neither is accurately described as a small serializer add-on; do not start it by repairing only the failures in this table.

### Smaller standard approach to prove

Tmux's normal attachment draws from its live pane state. Its control-mode `%output`, by contrast, carries original application output; switching to control mode plus `capture-pane` would retain much of the reconstruction problem. See the [official control-mode description](https://github.com/tmux/tmux/wiki/Control-Mode), [attach/redraw/resize commands](https://man.openbsd.org/tmux.1), and [3.7c redraw implementation](https://github.com/tmux/tmux/blob/3.7c/screen-redraw.c). Its [TTY output handling](https://github.com/tmux/tmux/blob/3.7c/tty.c) also contains bounded-output blocking and redraw logic, which must be exercised under a slow attachment.

Read-only binary checks found home `tmux 3.5a`, work `3.6a`, and no `tmux` on Deckbox. The current upstream release is [`3.7c`](https://github.com/tmux/tmux/releases/tag/3.7c), published 2026-08-17. A production choice requires an explicit pinned binary/dependency packaging decision; relying on those three different machine states would not make a self-contained app. The first investigation was read-only; the separately authorized private-server experiment below followed it.

Proposed implementation, after the release freeze:

1. **Prove the backend in an isolated fixture before switching production.** Use an app-owned private socket and empty app-owned tmux configuration, never the user's default socket or config. Give each logical app terminal one pane/session with its catalog cwd and configured shell. Capture its pane ID and actual shell PID. Disable tmux chrome/prefix interception within this private server; verify ordinary shortcuts and TUI mouse input still reach the program.
2. **Separate the logical terminal from each view's attachment.** An attachment owns a Bun PTY running a normal tmux attach client, its own epoch/output cursor and bounded ring. Creating another attachment connects to the existing pane. The terminal's shell PID and catalog identity do not change. On a missed-output gap, close only that attachment and create a fresh one; feed its complete redraw into a reset xterm. Never inject Ctrl-L, resize merely to stimulate a redraw, replay user input, or restart the shell.
3. **Keep input ephemeral and ordered.** Scope the existing input receipts to the attachment epoch. Reject late input for an old attachment. Each renderer's protocol answers return only to its own attach PTY; tmux handles the underlying pane's terminal protocol. Remove the cross-view reply lease and per-query takeover bookkeeping after these tests pass. Retain a small size-owner lease so two different window sizes cannot fight over the shared pane dimensions.
4. **Order dimensions and attachment state.** Set the logical pane/window size explicitly; initialize each new xterm and attach PTY with that accepted size before applying output. A size change invalidates/repaints affected attachments in one ordered operation. Check normal/alternate screens, cursor visibility/style, color/font updates, and returning from an alternate screen. Local scroll position and selection remain local UI state.
5. **Bound resources and preserve cleanup semantics.** Start with at most eight attachments per terminal and 64 per host, 256 KiB replay per attachment, and an explicit finite tmux history limit. Treat a lagging attachment as replaceable display transport. Test actual RSS and byte queues under sustained output rather than treating those configured numbers as proof of a full memory bound. Detach expires only the attach client; explicit close ends the owning pane; host shutdown cleans up only this app's private server and descendants. Preserve the current install refusal while shells are active.
6. **Package only after the proof.** Pin the selected tmux version plus its native libraries/terminfo for macOS arm64 and Linux x64; include them in the versioned host artifact and validate codesigning/loading. Keep the program's actual `TERM`/`TMUX` changes visible in the technical contract. Verify missing/broken binary startup reports an error rather than falling back to incomplete recovery.

### Acceptance that closes the gap

Use real PTYs and real xterm parsers, then two actual desktop clients. A deterministic fixture should enter an alternate screen, draw a static header, set margins/saved cursor/mouse/paste modes, emit enough updates in a small screen region to evict every transport ring, and then wait. Attach a completely new viewer while the program is idle. Compare all current cells/styles, dimensions and cursor state, then continue the program with scrolling, cursor restore, tabs and raw input; both viewers must stay equal. A matching first image alone does not pass.

Required cases are split CSI and OSC across attachment, normal↔alternate transitions, hidden/bar/blinking cursor, saved cursor/attributes, origin/margins, insert/wrap, DEC charset, wide/combining text, palette/hyperlink/underline behavior, application cursor/keypad, SGR and binary mouse, bracketed paste, resize during output, and queries before any viewer is attached. Record exactly one underlying answer per program query, including while all viewers disconnect. Verify a new attachment causes no synthetic user input, no shell restart and no resize signal when dimensions did not change.

Also force a slow viewer and repeated truncation while another viewer types; the active viewer must remain responsive and the lagging viewer must recover the current screen with bounded resources. Drop an accepted input receipt immediately before attachment replacement and verify the keystroke is not retried. Run the same shell/TUI fixtures on macOS and Linux, followed by real two-laptop acceptance. Failures remain goal gaps; this plan does not authorize replacing them with documented exclusions.

## Private tmux experiment — 2026-09-05

**Result:** normal tmux attachments solve the tested fullscreen recovery and continuation failures on actual macOS and Linux PTYs. They are a viable display backend to integrate next. They are not a transparent replacement for the existing raw-byte input API: that difference, lifecycle ownership, history, and packaged desktop acceptance still need implementation and verification before switching production.

The experiment used an exclusively owned temporary socket, explicit private configuration, a single 80×24 pane running a raw Bun TUI, multiple real attach PTYs, and the installed xterm 6.0.0 parser. The configuration disabled status chrome and the prefix, kept the pane alive when detached, fixed the existing window's size, and set a 1,000-line history limit. It did not use any default tmux socket, user tmux configuration, shell startup file, live project, account, or production terminal. Production source, shared protocol, renderer, package manifest and lockfile remained unchanged.

The TUI drew a static header once, entered the alternate screen and emitted 2,486,587 bytes, mostly in a changing body region. Two original attachment streams each exceeded 2.48 MB; their independent 256 KiB replay rings evicted the initial screen. New viewers received only their newly created attach stream. The fixture itself stayed idle during attachment and recorded every input byte and SIGWINCH. Later actions exercised the live pane's saved cursor, margins/origin mode, custom tabs, DEC charset, split CSI/OSC and normal/alternate transitions.

| Evidence | Home macOS 26.6 arm64 | Deckbox Ubuntu 24.04 x64 |
| --- | --- | --- |
| Private relocated binary | tmux 3.7c | tmux 3.7c |
| Original viewer A output | 2,487,937 bytes | 2,488,018 bytes |
| A retained output / evicted chunks | 261,846 bytes / 3,224 | 261,862 bytes / 1,680 |
| Fresh current screen, then stateful continuation | Passed | Passed |
| Split CSI and OSC completed after new attachment | Passed | Passed |
| Real blocked PTY reader, another viewer typing, then recovery | Passed | Passed |
| Server RSS before/after this bounded flood | 4,160 / 6,368 KiB | 2,688 / 4,608 KiB |
| Pane DSR requests / responses | 9 / 9 | 9 / 9 |
| Pane PID across all reattachments | 38178 throughout | 1259621 throughout |
| Resize signals, injected Ctrl-L, repeated accepted marker | 0 / 0 / 0 | 0 / 0 / 0 |

The query cases covered startup before the first viewer, multiple simultaneous viewers, and every viewer being detached. A separate Python-owned native PTY deliberately stopped reading, allowing its OS buffer to fill; another viewer's input still reached the program. The stopped reader then resumed with the current screen. This measured a bounded scenario, not a proof of a maximum RSS under arbitrary output.

Screen comparison included all 80×24 effective cells, basic foreground/background/attributes, wide and combining text, cursor location and visible style, public modes and mouse encoding. It normalized uninitialized blank cells and painted spaces with otherwise identical attributes. Tmux can defer a hidden cursor's style until it becomes visible; the comparison therefore checked hidden visibility first and explicitly checked the visible bar/blink state after continuation. It did not claim equality of xterm's internal parser state, complete OSC metadata, extended underline styles or hyperlink metadata. Those remain in the acceptance matrix above. No GUI or two-laptop desktop acceptance was performed by this experiment.

The existing home 3.5a binary passed the same core test first. It crashed in `clients_calculate_size` when `window-size manual` was set globally before creating the first window. Creating the 80×24 window first and then setting that existing window to manual avoided the crash and caused no resize signal. The [3.7c size implementation](https://github.com/tmux/tmux/blob/3.7c/resize.c) explicitly guards a missing window in that path. Use the tested initialization order even with the new pin.

### Input result and required design correction

Ctrl-B, application cursor input, bracketed paste and SGR mouse press/release bytes round-tripped exactly through the normal attachment on both platforms. Arbitrary invalid UTF-8 did not:

```text
submitted:                 00 03 1b 7f 80 c1 fe ff
normal attach received:    00 03 1b 7f
literal control received:  00 03 1b 7f 80 c1 fe ff
```

The literal case used `tmux -C attach-session -f no-output,ignore-size`, sent `send-keys -H` through the process's stdin, and detached that control client. User bytes were never command-line arguments or shell source. This matches the actual [`KEYC_LITERAL` injection](https://github.com/tmux/tmux/blob/3.7c/cmd-send-keys.c) and [direct 8-bit write](https://github.com/tmux/tmux/blob/3.7c/input-keys.c). It proves the byte path exists; it does not prove that independently writing keyboard data to an attach PTY and literal bytes to control stdin preserves their combined order.

Before implementation, choose and test one host-owned ordered input path. A two-channel shortcut with no processing barrier can reorder adjacent chunks even if both native writes return successfully. Sending everything as literal pane bytes also requires checking mouse/keyboard mode translation: the attach terminal's protocol can differ from the underlying pane's protocol. Keep input ephemeral, bounded and acknowledged at native acceptance, and never automatically retry after uncertainty. Large paste chunks, literal input mixed with keys, attachment replacement after a lost receipt, and high-rate legacy mouse reports need actual program readback tests. The passing eight-byte probe is not permission to skip them.

The next experiment below resolves this design question with one control connection and source-tagged input operations; it rejects an unqualified all-literal implementation.

### Smallest integration shape

1. Keep the logical terminal, pane ID, actual pane PID, catalog target and accepted dimensions on the owning host. Add a private tmux backend behind `TerminalManager`; do not expose tmux command strings, socket paths or cwd authority to the renderer.
2. Give each mounted viewer an attachment ID and generation, native attach PTY, monotonically increasing cursor and bounded output ring. A first view, renderer reset or missing prefix gets a new attachment to the same pane. Discard the old generation atomically. Resize only for an intentional size-owner change, never to recover display state.
3. Start a fresh xterm at accepted dimensions and parse the new attachment from its first byte. Deduplicate output by cursor. Never reconstruct a reset renderer from an old attach stream. This makes generated replies belong to one native attach client and removes the cross-view reply lease; reject late data for an expired generation. Only remove the private xterm input seam once the fresh-generation invariant and no-reply-replay tests pass.
4. Retain one small pane-size lease. All view PTYs and xterms adopt that accepted size. Avoid tmux's automatic smallest/latest-client sizing so mounting another laptop cannot resize the application accidentally.
5. Retain input receipts and limits with the ordered byte/key solution above. A reply from an xterm goes only to its own attach client. The pane's terminal queries are answered by tmux even without viewers. This separates display-client protocol from the running program's protocol.
6. Bound attachments and their lifetime; replace a stalled display transport while preserving the pane. Explicit close and service shutdown must reap the app-owned pane descendants and private server. Recovery after a host crash and installers checking for surviving private panes require a durable ownership/generation rule; no default-socket adoption or automatic command replay.

Fresh normal attachment recovers the current screen, not the complete old xterm scrollback. Shared bounded history should come from the owning pane's retained history, with a separate history presentation or a proved preload path. Entering tmux copy mode globally would affect other viewers and is not an acceptable substitute for each laptop's local scrolling. This remains a feature gap, alongside intentional resize during output, theme/color-query behavior, full extended terminal modes and actual two-client desktop acceptance.

### Packaging evidence and next build boundary

The exact upstream [3.7c source asset](https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz) was downloaded and matched the release API's SHA-256:

```text
7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
```

On home, Apple clang 21 built a 1,602,072-byte arm64 binary using explicit static archives for libevent 2.1.12, ncurses 6.6.20251230 and utf8proc 2.10.0. After moving it to a different private directory, `otool -L` listed only `libSystem` and `libresolv`; no Homebrew dynamic path remained. The binary targets macOS 26.0 with SDK 26.5. Private compiled `xterm-256color` and `tmux-256color` entries were provided through `TERMINFO`. The copied binary also loaded on work macOS 26.2 after restoring its executable mode: SCP had created a mode-0644 file, initially causing `permission denied`; its code signature verified before and after. This is a loader check on work, not its full TUI acceptance, reproducible source-built dependencies, or compatibility with older macOS.

The macOS experiment explicitly used `--disable-jemalloc`. Upstream 3.7c [configure guidance](https://github.com/tmux/tmux/blob/3.7c/configure.ac) recommends jemalloc on macOS and otherwise requires that opt-out. A production recipe should resolve that allocator choice and pin/build the dependency from source rather than silently retaining this experimental opt-out.

Deckbox had a compiler but no tmux, headers, pkg-config or yacc. Exact Ubuntu packages were downloaded and extracted only into the temporary directory: libevent-dev `2.1.12-stable-9ubuntu2`, libncurses-dev `6.4+20240113-1ubuntu2.2`, bison `2:3.8.2+dfsg-1build2`, and pkgconf-bin `1.8.1-2build1`. The ncurses package was fetched from the [official Ubuntu archive](https://archive.ubuntu.com/ubuntu/pool/main/n/ncurses/); the machine's stale package index still named the removed `1ubuntu2.1` file. No package database or installed package was changed.

GCC 13.3 built a 2,943,928-byte static Linux binary; `ldd` reported it was not dynamic. The relocated binary and private terminfo passed the same proof. The linker still warned that libevent's glibc name-service functions can require matching runtime glibc modules. This experiment did not exercise DNS/NSS through tmux. A production recipe must choose a pinned build image and libc strategy, verify its runtime closure, include library notices and the terminfo database, and test the resulting artifact on the actual hosts. Build-time packages, source digests, compiler/SDK, deployment target and flags must be fixed; these successful local builds are not evidence of byte-identical reproducibility.

Only this technical document was retained in the repository. All private proof servers, TUI programs, attach clients and temporary downloaded/build files were cleaned after the experiment. No live tmux sessions, global software or production host services were altered.

## Ordered input and ownership follow-up — 2026-09-05

**Recommendation:** keep one ordered tmux control connection per logical terminal. Use tmux's native named-key handling for key events, literal writes for text/raw bytes, and pane-aware paste and mouse operations. Each viewer's parser replies go only to that viewer's attach PTY. This preserves one user-input order without treating tmux's client protocol as the pane's protocol or maintaining a patched tmux fork.

This was a second isolated experiment using the same verified 3.7c source on home and Deckbox. Production runtime, shared types, renderer and dependency pins stayed frozen. The real xterm parser and its real keyboard/paste/mouse encoders fed actual PTYs. Small DOM/IME housekeeping objects enabled the keyboard encoder without a browser; this was not physical keyboard or desktop rendering acceptance.

### Why all-literal failed

Tmux initializes each attach terminal with application keys and bracketed paste, and asks it for SGR mouse reports. The pane's requested modes can differ. Actual negative probes on both operating systems showed:

| Pane/view state | All-literal result | Required result |
| --- | --- | --- |
| Pane uses normal cursor keys | ArrowUp delivered `ESC O A` | `ESC [ A` |
| Pane disables bracketed paste | Plain paste included `ESC [ 200~` / `201~` | Plain text |
| Pane requests legacy mouse | Delivered an SGR report | Legacy `ESC [ M` bytes |
| 40×12 attach viewing an 80×24 pane at offset (40,12) | Click (6,4) delivered (6,4) | Pane coordinate (46,16) |

The interpreted attachment handled these translations correctly. Its invalid-UTF-8 loss from the earlier experiment still rules out using it as an opaque byte path. The relevant native behavior is in [TTY initialization/mouse setup](https://github.com/tmux/tmux/blob/3.7c/tty.c), [key/mouse translation](https://github.com/tmux/tmux/blob/3.7c/input-keys.c), and [client offsets](https://github.com/tmux/tmux/blob/3.7c/resize.c).

### Small input contract

Keep the existing host/target authorization and ephemeral sequence receipts. Add an attachment generation, accepted geometry revision, and an explicit input source:

| Source | Host operation on the same control stdin |
| --- | --- |
| Key | Map the actual xterm key event to an allowlisted native key and invoke `send-keys`, such as `Up`, `C-a` or `BTab` |
| Text | Preserve composed text as UTF-8; distinguish it from a navigation/function/control key |
| Paste | Normalize newlines as xterm does; wrap the literal payload only when the pane's `bracket_paste_flag` is enabled |
| Mouse | Validate a structured event and accepted-grid coordinates; choose the pane's SGR, UTF-8 or legacy encoding and apply its tracking/motion rules |
| Bytes | Decode canonical base64 and write every byte literally, including NUL and invalid UTF-8 |

These are internal bridge operations, not tmux command strings supplied by the renderer. Key mapping must preserve xterm's emitted meaning and platform handling; do not infer it solely from the physical key's name. Real key, paste and mouse origins must be captured at their event sources. Never recognize a mouse report by scanning arbitrary pasted text for escape sequences. Keep the existing pinned parser-reply separation until the replacement renderer adapter proves all these origins through native DOM events, composition and menu paste.

All operations enter one host queue. Literal data is hex-encoded into `send-keys -H` arguments on the already-running control process's stdin; it is never process argv, shell code or a persisted command payload. The experiment used SHA-256 request hashes, one in-flight logical operation, 4,096-byte native chunks for long literal input, monotonic admission order and duplicate receipts. A repeated ID with different content failed before writing.

Paste and mouse mode choices ran through tmux's `if-shell -F` **format-only** command, with `send-keys -H` in its branches. This invokes no shell. The current pane flags are evaluated by the same native command queue that applies the input, rather than relying on a periodically cached mode snapshot. Mouse rules covered disabled tracking, standard tracking, button drag, unbuttoned motion, release encoding, SGR, UTF-8 and legacy coordinate bytes. Legacy coordinates follow tmux's clamping behavior. Generated commands contain only validated IDs, fixed command structure, numbers and hex data.

A nested tmux command can finish its outer control block before its inserted child commands. The prototype therefore appended a unique `display-message -p` acknowledgement marker after each logical operation and waited for the marker's completed control block. It did not treat the first `%end` as the operation's acceptance. Output lines and pending acknowledgements must be bounded; an error or lost control connection stops admission until reconciled. Accepted-but-unacknowledged operations remain uncertain and are never retried automatically. Queued operations that were never written should be reported separately as not submitted. Input epochs change on host restart.

### Verified ordering and geometry

Both home and Deckbox passed the corrected path, alongside the four intentional all-literal counterexamples:

- 62 actual xterm key-event comparisons against interpreted tmux input across normal/application cursor modes, navigation, function keys and selected modifiers.
- UTF-8 text, invalid bytes `00 03 1b 7f 80 c1 fe ff`, bracketed/unbracketed paste, and actual Ctrl-C causing a native SIGINT when terminal `ISIG` was enabled.
- SGR, legacy and UTF-8 mouse press/release; disabled tracking; drag/motion filtering; a coordinate requiring byte `84` in legacy mode and `c2 84` in UTF-8 mode.
- 64 concurrent admissions plus 10 duplicate retries, changed-payload rejection, 66 KB of UTF-8 across native chunks, and a mixed sequence of named keys, raw bytes and conditional mouse operations with exact program readback order.
- A real control-client kill after the program received input but before acknowledgement. The accepted marker appeared once, the queued tail never appeared, and a new controller rejected the old input generation.
- Pane queries answered separately from user input; parser responses were returned only through their own attachment PTYs.

The geometry rule is **one accepted native grid for the pane and every attach PTY/xterm**. The selected size owner can intentionally change it. Other laptops can have smaller visual containers, but must display or locally scroll that full grid; they must not silently create a smaller native tmux viewport. Coordinate conversion must use the full xterm grid, including local DOM scrolling. The renderer must suspend input during an unacknowledged grid transition and visibly reconcile its size. Actual clipped-container mouse/scroll rendering remains part of desktop integration acceptance.

The prototype intentionally resized the pane from 80×24 to 120×30, rejected input tagged with the old geometry without writing any bytes, then resized both real viewer PTYs and xterms to 120×30. Tmux reported zero offsets for both viewers, and each correctly delivered the non-ASCII mouse coordinate. Returning to 80×24 produced exactly one more SIGWINCH. Actual `stty size` readback in the program's signal handler recorded only `120×30` and `80×24`; attaching another viewer caused neither signal. Stale geometry is an explicit rejected receipt, not a successful no-op.

### Private server ownership and restart

The smallest continuity policy is to let the app's private tmux server intentionally survive a host-process crash and adopt it on restart. Its ownership must remain durable and discoverable; surviving programs must never become an unlisted side effect.

Persist the host ID, server generation, selected binary/version, private socket location, terminal UUID, owning catalog target, canonical cwd and native session/pane identity before and during creation. Use a generated session name tied to the terminal UUID so startup can reconcile a crash between native creation and final catalog acknowledgement. Store matching host/generation options on the private server and a terminal UUID on the pane. The production implementation should reuse the host's durable store, validate directory/socket ownership and reject symlinks or foreign metadata; the experiment used an atomic temporary manifest to prove the state transitions.

On restart, first acquire the existing host service lease. Adopt only the exact private server whose host/generation, native version, pane UUID and catalog ownership match. Open new stable `Process.fromPid` references after identity verification; never authorize cleanup by a reused PID alone. Rebuild each viewer as a fresh attachment and reset input epochs. Do not rerun the terminal's original shell command or any pending keystrokes. If the socket/server is missing or identity mismatches, mark the old terminal interrupted and surface the recovery condition. Creating a replacement terminal is a new explicit action.

An actual macOS proof killed the owner host process with SIGKILL. The private server, pane and its child continued; a counter in the pane advanced. A newly started owner adopted the same server generation and pane PID, with identical retained history and no input replay. A newly opened stable process reference then terminated the adopted private server and reaped both pane and child. Starting the owner again after native server removal reported the missing server and exited; it did not recreate the program.

Normal renderer detachment closes only its attach client. Host shutdown for an intentional close/update must explicitly terminate the owned panes/descendants and server, settle their status, and retain final history if the UI continues to show an exited terminal. Installers must check the private native server as well as the host catalog before replacing a version; a stale in-memory list must not bypass the existing active-terminal refusal. Whether an ordinary app quit stops the service is separate from this terminal contract.

### Shared scrollback

Use the owning pane's bounded retained history as the authority, not a viewer's attach-output ring. Two independent readers captured exactly the same history before and after the owner crash/recovery. After 1,200 generated lines with a 1,000-line history limit, tmux retained 977 history rows (`HISTORY_0200` through `HISTORY_1176`) plus the visible viewport. The limit is an upper bound; tmux trims in batches.

Capture history as a finite immutable snapshot with a content revision, server generation, pane identity, dimensions and capture time. Bound both rows and encoded bytes. Page locally within that snapshot; do not treat native line indexes as durable cursors while the program writes or resizes. A fresh history request can replace the snapshot. Copies/selections and local scrolling remain per viewer and must not put the shared pane into tmux copy mode.

The alternate-screen probe verified an important detail: the active grid retains the older normal history, while `capture-pane -a` returns the saved normal viewport. It does **not** return the entire normal history. Read older rows with `capture-pane -S - -E -1` when history is nonempty, and capture the saved normal viewport separately when needed. The [3.7c screen implementation](https://github.com/tmux/tmux/blob/3.7c/screen.c) and [capture implementation](https://github.com/tmux/tmux/blob/3.7c/cmd-capture-pane.c) explain that split. Style-bearing history can be rendered read-only from `capture-pane -e`; it must never answer terminal queries or send input to the pane.

History is preserved across a host-process restart while this native server remains alive. A native server crash or machine restart can lose its in-memory tail; report the terminal as interrupted and distinguish any last saved history snapshot from current live history. Do not silently start a new shell or present a partial cached history as complete. Persist a final bounded snapshot on explicit terminal close if the exited terminal remains accessible. Lossless restoration after the native server itself dies would require a separate durable output/history policy and was not established by these experiments.

The corrected input path and ownership model were carried into the separate versioned transport below. The proof's private native processes were stopped; build source caches were retained until platform packaging completed, then removed. The real renderer's source adapter and clipped-container behavior were subsequently tested with an actual Electron view and native backend.

## Future 9 native implementation

`terminals/native-manager.ts` and `terminals/native-http.ts` implement the explicit `tmux-v1` capability and `/v2/terminals` routes. The release 8 raw-PTY protocol remains separately labelled. Native output never falls back to incomplete ring replay: each viewer owns an actual attach PTY and a lost cursor requires a new attachment to the same pane.

The maintained build, ownership, input, geometry and history contracts are in [the native bundle guide](../../../docs/tmux-bundle.md). The source registry includes tmux 3.7c, libevent 2.1.13, ncurses 6.6, utf8proc 2.10.0 and the bundled macOS jemalloc 5.3.1 dylib. All source archives and shipped files are checked; Work ran the exact Home-built binary with its relocated allocator and private terminfo.

Production corrections discovered during integration:

- Named keys are quoted in native command syntax, including a real Ctrl-backslash regression.
- Native control clients attach to one private retained dead infrastructure pane. A control client on the user pane otherwise keeps that pane permanently focused. Actual viewer focus metadata now produces native focus-out only when its last focused viewer blurs.
- Native death-format output is disabled; tmux's default message scrolls the pane by one row. The app reports process exit while retaining the application's final visible rows.
- Read-only history captures plain native text cells, including the final current viewport, rather than exposing `capture-pane -e` escape sequences in a text viewer. Live attachments retain native styles and modes.
- Input accepts at most 256 pending operations / 2 MiB of source payload globally; native viewers are bounded at 16 per pane / 64 per host. The 1,024 input-stream limit remains explicit until terminal forget, preserving old accepted receipts rather than risking duplicate writes after reconnect.
- A control failure stops queued input, reports accepted-but-unacknowledged input as uncertain, and creates a fresh input epoch/attachments. Old accepted duplicate receipts stay authoritative. Geometry and attachment creation are blocked during that transition.

The same actual-native suite passed on home macOS, work macOS and Deckbox Linux: 10 tests, 81 assertions, zero failures on each host. This includes screen recovery after observed ring truncation, same process/no resize, partial-CSI continuation, ordered typed and invalid-byte input, native multi-viewer focus, intentional shared resize, owner SIGKILL/adoption, native-server death without replay, final output, viewer caps and controller-generation recovery. The separate actual Electron-to-native acceptance covered seven renderer cases; evidence is in `.data/ui-acceptance/native-terminal-renderer-release9.json`. Backend/platform evidence is in `.data/acceptance/native-terminal-backend-release9.json`. Neither fixture used real accounts or changed installed release 8 services.
