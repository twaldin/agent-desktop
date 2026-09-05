# Owning-host interactive terminals

`TerminalManager` runs real interactive shells through the pinned Bun 1.3.14 runtime's [built-in PTY](https://bun.com/docs/runtime/child-process#terminal-pty-support). No dependency was added. The PTY accepts text and raw byte input, supports resizing, and delivers byte output through a streaming UTF-8 decoder. Invalid UTF-8 output becomes replacement characters. Bun's child-exit promise reports the subprocess exit code; terminal lifecycle status is not substituted for it.

Create one manager per owning host service. The host resolves the project/session catalog identity to its canonical directory and passes both to `create`; clients do not choose an unrestricted shell executable, environment or absolute root. Production defaults to the user's configured shell with login/interactive arguments. Tests supply a profile-free Bash configuration and disable history files only for their temporary shells. Terminal commands execute with the owning user's normal privileges; the initial directory is ownership context, not a filesystem sandbox.

## Integration API

```ts
const terminals = new TerminalManager();
const terminal = await terminals.create({ target: { sessionId }, cwd, cols: 120, rows: 40 });
terminals.list(); // optional catalog target filter
terminals.get(terminal.id);
terminals.write(terminal.id, "ls\r");
terminals.resize(terminal.id, 100, 30); // returns accepted dimensions
const replay = terminals.replay(terminal.id, lastReceivedSequence);
const detach = terminals.subscribe(event => { /* state / output / removed */ });
detach(); // shell keeps running
await terminals.close(terminal.id); // explicit process termination
terminals.forget(terminal.id); // exited history only; emits removed
await terminals.shutdown(); // reject new terminals, close every owned terminal
```

Keep terminal input outside durable generic command journals. `write` acknowledges acceptance into the native input queue, not execution of a shell command. Never automatically replay a timed-out/uncertain input request or offline keystrokes. The same rule applies to uncertain terminal creation: refresh the host terminal list before retrying. The transport must authenticate every attachment/control operation and apply normal connection backpressure.

`TerminalInfo` exposes the initial owning directory, target identity, child PID, shell name, accepted size, status and actual exit/error fields. It never exposes the shell environment. Creation returns after native spawn; it does not imply completion of shell startup files. Sessions and terminal processes are separate: closing a desktop subscription does not close the shell, and closing a terminal does not stop its OMP session.

The app accepts 20–400 columns and 5–200 rows. Requests are clamped to these bounds and the returned info states those exact values. Rapid resize requests coalesce over 16 ms; an input write flushes any pending resize first. The UI should fit its terminal emulator to the accepted dimensions. Native resize controls have no acknowledgement of a foreground application's redraw; errors are surfaced when available, and tests verify actual dimensions and SIGWINCH delivery.

## Replay and limits

Each terminal has a separate monotonically increasing output sequence. Subscribe and fetch replay, then discard duplicate sequences; this closes a subscribe/replay delivery race. The default ring retains at most 1 MiB of UTF-8 output per terminal, split into chunks of at most 16 KiB without splitting UTF-8 characters. Old chunks are evicted whole. `firstSequence`, `lastSequence` and `truncated` identify a lost prefix. A cursor ahead of current output fails rather than silently resetting.

Replay preserves ANSI control sequences. A truncated tail is not a complete terminal screen snapshot, especially for a fullscreen TUI; show the gap and reset/repaint appropriately. This module does not implement a terminal emulator. It keeps output in host memory, not a transcript file or durable event journal. Desktop disconnection retains running shells and replay while the service stays alive; service restart does not restore a terminal process or its in-memory history.

Defaults allow 32 active and 128 retained terminals. Limits fail explicitly; a user can close/forget a terminal to reclaim capacity. Each input request is at most 64 KiB, with a 64 KiB burst and approximately 128 KiB/s token budget (small requests also consume a minimum budget). This controls admission rate; the native API has no consumption acknowledgement for its input queue, so it is not an absolute bound on unread input accumulated by a blocked program. Resize requests coalesce. Subscriber exceptions are reported and detach only the failed subscriber.

## Cleanup boundary and evidence

The manager captures a native stable `Process` reference when the shell is spawned. Close uses that reference's descendant-aware termination, then waits for the PTY run to complete; it does not reopen an old PID and signal whichever process now owns it. The [pinned process implementation](https://github.com/can1357/oh-my-pi/blob/f241301c83726afe75a847e919b89977a54dafbe/crates/pi-shell/src/process.rs) checks process identity and traverses descendants. Normal PTY completion reaps its direct child. Startup without a stable process handle uses the captured Bun subprocess reference and closes its terminal. Shutdown is idempotent and reports cleanup failures instead of claiming every process exited.

Cleanup applies to the shell and descendants it still owns. A deliberately daemonized/reparented process can escape that ancestry; this is not a cgroup or operating-system sandbox. Hard host crashes cannot run the shutdown method. The host must await ordinary shutdown, and must not silently report a timed-out cleanup as successful.

Run `bun test apps/host/src/terminals/manager.test.ts`. Tests execute actual temporary shells, files and an ANSI foreground program: TTY detection, command readback, initial cwd/size, color/control output, SIGWINCH dimensions, raw Ctrl-C, independent shell state, detach/reconnect replay, bounded UTF-8 output, exit codes, startup failure, capacity limits, subscriber isolation and explicit cleanup. The cleanup test observes both stable process exit and disappearance of the owned shell/background child from `ps`; a second owned terminal remains usable when the first closes. All ten manager tests passed on home macOS and Deckbox Linux with Bun 1.3.14, including exact raw-byte roundtrip, split UTF-8 decoding and a 250,000-byte final burst before exit. Native Process still handles stable descendant cleanup. These tests do not claim desktop emulator rendering or physical UI attachment acceptance.
