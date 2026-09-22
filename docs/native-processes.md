# Native supervised processes

The Processes flow uses OMP's project-scoped daemon broker. It is separate from
Jobs, which projects the loaded session's AsyncJobManager. A process may outlive
the tool call or desktop client according to its native persist/detached policy.
Opening this flow must not consume, acknowledge or replace the agent's native
completion subscription.

## Original process controls

Native name-only commands remain available to their existing tool callers. The
desktop uses the new opt-in `observe` and `guarded` operations: an observation
binds the running broker incarnation, native process record ID, name and launch
generation. An older broker rejects the unknown operation. The desktop must not
fall back to a name-only mutation or refresh a target to make a rejected action
succeed.

The broker checks that original target before dispatch and after asynchronous
reads/cleanup, immediately before further effects or returning a result.
Restart may advance only its own generation; its receipt supplies the resulting
target. Name reuse and broker restart invalidate previous targets even when
persisted metadata survives. Replies copy native snapshots so later changes do
not alter an already-produced observation. These are broker-level identity
checks, not proof against operating-system PID reuse or physical race immunity.

## Implemented flow

The loaded OMP session owns an independent process-observation client. Worker
protocol 72 carries bounded, validated observations; it never grants a worker
response durable-receipt authority. Task relocation drains the original view
before changing the project and creates a new epoch on a later explicit read.
Old project targets stay invalid, including after same-session reopen. Session
disposal joins requests and closes only this client, preserving project processes
and the agent's separate completion subscription.

The authenticated host route claims each mutation in SQLite before native
lookup/dispatch and finishes its receipt before confirming success. Duplicate
IDs validate the original input without dispatch; lost results and abandoned
pending records remain unknown. No stdin plaintext is saved in receipts. First
admission raises schema28 atomically with the existing access policy. Host
shutdown joins both request bodies and native operations before closing SQLite.
The desktop transport captures the endpoint and original request before awaiting
network I/O, validates the outer and inner owners and never retries a mutation.
Main/preload handlers connect the selected session to the Processes panel.

Client operation identities have a separate per-window file owned by the main
process. Trusted synchronous IPC acknowledges a save only after file fsync,
atomic rename and directory fsync. Records bind host/session and retain only
operation ID, action, native owner and original target; stdin, logs and receipts
are excluded. Layout saves cannot overwrite the journal. Corrupt journal data
blocks process changes while ordinary layout recovery continues. Thirty-nine
focused journal and existing window-layout tests and ordinary typecheck pass;
the initial type-widening error and combined-file recovery regression are
preserved in private evidence. The renderer uses this journal before dispatch and restores unresolved IDs for explicit receipt lookup.

Forty-nine focused tests / 263 assertions and ordinary typecheck pass across
eight selected files, with 35 selected input hashes stable before/after the run.
The real disposable macOS path exercises desktop transport, host authentication,
SQLite, the production worker/entry/OmpRuntime, native broker sockets and actual
process input/restart. It verifies stale-generation refusal, task move without
killing the old project process, observer disposal, fresh reopen epochs and
host-restart receipt lookup without replay. Seven native fact groups finish with
zero owned process survivors. Controlled tests separately cover malformed late
replies, held drains, capacity, storage failure and transport uncertainty. This is
not Electron, real-provider, physical Tailscale or full dependency-graph proof.

The complete net OMP patch was regenerated against the pinned published archive.
A fresh private frozen installation matched all 3,125 intended package members'
bytes, sizes and modes, with an unchanged lockfile. That install used the
pre-diagram manifest; the current worktree subsequently installed the diagram
manifest and candidate patch. Full final package/application acceptance remains
required. The earlier narrow native compile retained external diagnostics and
is not a full SDK typecheck pass.

## Reference distinction and remaining work

Pinned 7982's **Background processes** is an earlier-turn, still-running command
list with a thread-wide **Stop all background terminals** action. It is a sibling
summary section, separate from Environment actions and Jobs. Per-process Restart,
stdin, readiness and native daemon history are OMP adaptations, not controls
proved in that reference owner. Reference output-tab, formatting and restoration
internals have additional untraced boundaries; no pixel match is claimed.

The integrated flow passes 121 tests / 824 assertions across 16 files, ordinary
typecheck and a desktop build. All 2,460 selected regular source hashes stayed
unchanged across those checks; this is not a full transitive dependency fence.
An actual hidden Electron window exercised process output, standard input,
renderer reload and durable receipt lookup after a controlled lost HTTP response,
restart to a new generation, and stop. The response was withheld only after the
real host completed input; the process received it once. Controls were invoked
through the rendered DOM and Electron text insertion, not physical keyboard or
pointer input. The app, host and broker stopped with zero survivors in that run.

A separate read-only visual follow-up scrolled the existing environment card
to the controls and captured the narrow layout. Its immediate cleanup check
reported one still-present process after broker shutdown, so that run retains
exit 1. Subsequent read-only process checks found every owned PID absent; no
extra termination or successful synchronous reaping is claimed. The original
screenshots had controls below the viewport and are not visual control proof.
The fixture omits the terminal bundle, leaving unrelated editor-unavailable
messages visible. Independent Standards/Spec review is required before release.
Linux, Work, packaged installation, physical interaction and reference appearance
remain separate acceptance requirements. Earlier setup/fixture failures and
qualified concurrent-read positives are preserved in private evidence; later
passes do not rewrite them.
