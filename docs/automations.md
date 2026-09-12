# Local scheduled tasks

Scheduled tasks run on their owning Agent Desktop host through its existing OMP session and command paths. The manual flow supports creating and editing tasks, pausing, resuming, running now, deleting, and reading or archiving run history. A heartbeat continues one original chat; a cron task creates a new chat for each run. Creating a task does not run it immediately.

## Behavior contract

- The Scheduled page shows host-bound active, paused and completed tasks, search, unread run history, and cached content while offline. Existing edits save before navigation. New unsaved tasks require an explicit discard. Invalid or unavailable saves retain the editor.
- Manual creation defaults to a new heartbeat chat and a daily 09:00 schedule. The form also supports an existing chat and a new chat per run. Native project, model and reasoning choices remain owned by OMP. Creating a cron uses local execution; existing worktree configuration is preserved when editing.
- Schedule controls cover hourly/minute intervals, daily, weekdays, weekly, monthly and custom recurrence rules. Explicit date/time-zone and complex rules remain visible as custom rules. Host-local scheduling validates impossible dates and high-frequency restrictions before calculating a next occurrence. Eligible automatic runs use bounded deterministic jitter; manual runs do not.
- Schema 23 adds tasks, revisioned updates, run history and request receipts while retaining the existing browser recovery records. An exact window request must receive its original committed save acknowledgement before dispatch. Reopening does not replay requests. An uncertain outcome retains the request ID for explicit inspection and retry.
- The host validates its identity and native destination before admission. A task revision protects edits against concurrent changes. Native chat creation and prompts have durable original request IDs; failures after possible dispatch are unknown rather than blindly repeated. Task deletion stops future admission and retains history.
- Automatic admission advances the due cursor before dispatch. Missed occurrences advance from the current time, without replaying every missed run. A busy original chat, pending interaction or draft prevents a heartbeat from consuming unrelated work. At most three runs execute concurrently per host. Shutdown joins admitted mutations, scheduling and runs before closing the store.
- History has bounded pages, read/archive state, original-chat navigation and explicit failed or unknown outcomes. Deleting a schedule does not delete admitted runs or native sessions. Notifications respect the task's policy; only commands owned by the automation service suppress duplicate ordinary completion notifications.

## Validation

The acceptance fixture in `scripts/acceptance/automation-flow-fixture` uses the actual App, Electron renderer input, desktop transport, authenticated host HTTP, temporary SQLite/window stores and a pinned OMP worker. A native extension command completes without a model request. It exercises creation, edit/save-before-navigation, pause, run, history, reload, offline state and deletion. Its callback bridge and WebSocket connection remain fixture-owned; this is not proof of an installed Electron main-process or physical Tailscale flow.

Focused tests cover recurrence, records, concurrent saves, native host admission and the renderer's original committed save barrier. Keep failed early fixture results distinct from later passing runs. The standard compiler/build and CI checks remain required for publication.

## Reference and remaining parity work

The behavior was traced through the pinned Codex 26.901.41600 build 7982 local automation branches. Older build 7868 captures provide layout context only. Private reference assets and screenshots are not distributed. This implementation uses the host's SQLite journal instead of Codex's TOML-plus-SQLite storage and OMP's original sessions instead of Codex threads; it does not implement excluded hosted scheduling.

This manual-flow milestone does not finish the entire automation feature. Agent-created schedules, native plugin template/suggestion producers, the global command shortcut, detailed same-state 7982 visual comparison, physical multi-host behavior and provider-backed permission/model runs remain separate required parity work. No fabricated templates or successful model runs stand in for those dependencies. Full application and release acceptance remain governed by `GOAL.md`.
