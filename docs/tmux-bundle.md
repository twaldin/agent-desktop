# Private native terminal bundle

The `tmux-v1` transport uses a private tmux 3.7c server to own each terminal's program, screen, modes and scrollback. A desktop attaches through its own real PTY. A lost output cursor causes a fresh native attachment to the same pane; the app does not synthesize a screen, replay input, send Ctrl-L or resize the program to recover it.

The release 8 raw-PTY API remains separately identifiable. An actual old host can expose that labelled transport. Errors negotiating `tmux-v1` must remain errors, never a reason to reinterpret an old output ring as a current screen.

## Build and package

Run the builder on each target architecture with Bun 1.3.14, a C/C++ toolchain, make, tar, and yacc/bison available. macOS also requires the command-line SDK, `install_name_tool` and `codesign`. No global package installation occurs. Build work and output directories must be new; the builder refuses to overwrite them.

```sh
bun scripts/build-tmux.ts /private/build/work-new /private/build/output-new /optional/source-cache
```

The source cache contains original release archives, not compiled dependencies. Every archive is SHA-256 checked before extraction. Source pins are maintained once in `apps/host/src/terminals/bundle.ts`; both the builder and runtime validator use that registry.

| Component | Pin | Role |
| --- | --- | --- |
| tmux | 3.7c | Native pane, parser, screen, processes and attached clients |
| libevent | 2.1.13-stable | Native event loop; static core library |
| ncurses | 6.6 | Static terminal database library and private compiled terminfo |
| utf8proc | 2.10.0 | Static Unicode support |
| jemalloc, macOS only | 5.3.1 | Bundled native allocator dylib |

The source/version references are the official [tmux release](https://github.com/tmux/tmux/releases/tag/3.7c), [libevent release](https://github.com/libevent/libevent/releases/tag/release-2.1.13-stable), [ncurses archive](https://invisible-island.net/archives/ncurses/), [utf8proc release](https://github.com/JuliaStrings/utf8proc/releases/tag/v2.10.0), and [jemalloc release](https://github.com/jemalloc/jemalloc/releases/tag/5.3.1).

macOS uses a deployment target of 13.0. Its allocator uses `@loader_path/../lib/libjemalloc.2.dylib`; the executable and dylib are ad-hoc signed and verified after relocation. Static jemalloc initialized incorrectly in the actual macOS probe, so the bundle uses the normal dynamic allocator linkage. It does not disable jemalloc to bypass tmux's macOS allocator requirement. Other dependencies are static; external linkage is limited to Apple system libraries.

Linux uses static libevent/ncurses/utf8proc and the system glibc. The tested Ubuntu 24.04 build records glibc 2.39; the artifact is not claimed to run on older glibc versions. Build-only tools for the Deckbox probe were extracted into a private temporary sysroot; no apt package was installed and no service was changed. End-user machines need none of these build tools.

These are repeatable source builds with recorded toolchain metadata, not a claim of byte-identical builds across compiler/SDK versions. The manifest records its compiler, runtime libraries, platform, source hashes and every shipped file hash. A release should retain its exact built artifacts and their manifests. Runtime verifies platform, source registry and files; package tooling can statically verify the other platform without executing its binary.

Each output directory contains:

```text
manifest.json
bin/tmux
lib/libjemalloc.2.dylib       # macOS only
terminfo/...                 # tmux-256color and xterm-256color
licenses/*.txt
```

The host package places these directories at `runtime/tmux/darwin-arm64` and `runtime/tmux/linux-x64`. There is no system tmux fallback. The host chooses the path; a renderer cannot provide a binary, config file, shell command or cwd.

## Ownership and interruption

The host supplies its stable UUID and private data directory. Atomic, fsynced files under `native-terminals-v1` record server generation, immutable bundle digest, terminal UUID, target/canonical cwd and native session/pane identity before and after creation. A separate deterministic 0700 socket directory under `/tmp` keeps the Unix socket within macOS's path-length limit. The socket is selected from the host/data identity and generation, never the default tmux socket. User tmux sessions and configuration are not inspected or modified.

A private retained control pane runs `/usr/bin/true` once and exits. Input controllers attach there, while commands target the selected terminal's pane. This matters because tmux considers a control client focused; attaching it to a user pane would suppress the real viewers' focus-out state. The control pane owns no continuing helper shell and belongs to the same recorded server generation. Its lifetime ends with that server.

On host-process recovery, matching socket owner, host/generation, native version, server PID and pane identities are verified before adoption. The same program continues and every input epoch/attachment changes. Prepared creation is reconciled by its durable native session identity; it is never executed again. A missing server means interrupted terminals and explicitly saved history, never a replacement shell. A recorded process that remains alive but cannot be authenticated causes recovery to fail while preserving it.

The actual direct-process SIGKILL probe preserves the native daemon and adopts its original pane. A service manager can have a broader kill policy: Linux `KillMode=control-group` may also reap that daemon. That installed-service outcome must be tested separately and reported as interruption when appropriate; the direct-process test does not prove service-manager survival or machine-reboot survival.

Graceful host shutdown and explicit terminal close terminate only owned process trees and native sessions. Natural program exit retains the native final screen until close/forget. Saved history includes older normal history, current viewport, and the saved normal viewport when an alternate screen is active. Captures are finite immutable results with a content revision and timestamp; cached results after native-server loss are labelled `live: false`. The native history row limit and encoded byte cap are independent; a cap is reported rather than hidden. Periodic snapshots preserve a recent bounded cache, not a lossless log after machine or native-server failure.

Offline installation/rollback must refuse retained server ownership, including its internal control pane or naturally exited final screens. With a live host, its verified shutdown clears this ownership first. Existing immutable binaries remain available until their native server is stopped. A new bundle digest cannot silently adopt native ownership from another bundle.

## Input and viewers

User keyboard/text/paste/mouse/binary operations enter one FIFO control stdin per terminal, with ephemeral per-client sequence hashes and bounded receipts. Literal bytes are hexadecimal command arguments on that stdin, never process argv or a shell. Named keys are allowlisted and quoted. Native pane modes select paste wrappers and mouse encoding at command execution time. A completed unique native acknowledgement marker confirms acceptance, not program command completion.

An acknowledged duplicate returns its receipt. A changed payload cannot reuse a sequence. A lost acknowledgement returns `uncertain`; queued operations never written return `not-submitted`. Neither is automatically replayed. A failed controller requires a fresh host input epoch and viewer attachment. Input is bounded by per-operation, queue-count and queue-byte limits.

Every viewer renders the same accepted grid. An intentional resize closes old attachments, changes the pane once, increments its geometry revision, and creates new native attachments at that grid. Smaller containers scroll the full grid locally. Input is rejected until a viewer acknowledges the current geometry. Parser replies and focus metadata go only to their own attachment PTY; they do not enter the shared user-input queue. History viewers never answer queries or send input.

## Verification

```sh
AGENT_TEST_TMUX_BUNDLE=/absolute/native-bundle bun test apps/host/src/terminals/native-manager.test.ts
```

These tests start real temporary native programs. They cover truncated fullscreen recovery and partial-CSI continuation without program restart/resize; ordered concurrent input and duplicate receipts; native keys including Ctrl-backslash, text, paste, mouse and invalid bytes; two independent programs; stale grids; shared history; owner SIGKILL/adoption and upgrade refusal; actual native-server death without rerun; uncertain versus never-submitted control input; real multi-viewer focus and retained final output. No model requests, accounts or user repositories are involved.
