# Native goals

The desktop reads and controls the owning OMP session's goal. It does not infer a goal from transcript wording or mark success from an assistant's claim.

## Control and admission

`GET /v1/sessions/:id/activity` includes the bounded native goal and an optional short-lived goal-control ticket. `POST /v1/sessions/:id/goal-control` requires the selected owner header, ticket, request identity and expected goal identity. Older hosts without a ticket stay read-only. Main-process and renderer receipt checks bind the owner, session and request.

Create, replace, pause, resume, drop and budget changes invoke OMP 18.1.10's native `goalRuntime` methods. The worker flushes the session manager before acknowledging success. Native replacement creates a new goal identity and resets usage; the editor explains this. Replacing a paused goal requires resuming it first, following the native API. Create/replace/resume/budget changes currently require an idle session. Pause/drop may run during a response between tool executions, with no pending native ask, approval, admission or interruption; neither aborts the current turn.

The host orders goal mutations with ordinary prompt admission. Identical request retries share the receipt; conflicting identity reuse rejects. A host restart invalidates old tickets. Both host and worker compare a canonical fingerprint of native identity and effective configuration immediately before dispatch. Usage/time/`updatedAt` are excluded because native accounting advances them without a user edit. Objective, budget, status, mode and identity changes still invalidate the fingerprint, including two edits in the same millisecond. Returning to exactly the same configuration is equivalent; the fingerprint is not a monotonic audit revision.

A failure after possible native dispatch remains unknown. The desktop refreshes state and retains authored text instead of automatically issuing a new mutation.

## Continuation and recovery

The owning host schedules one continuation check after native completion or a relevant state change. Client presence is not an execution requirement. The host rechecks session ownership, idle status, archive/stop state and authored draft text/images in its existing command queue. The worker rechecks native modes, queued messages, async jobs, post-prompt work, pending asks/approvals, active tool calls and mutation/admission/disposal state.

An eligible continuation uses native `buildContinuationPrompt()` and `promptCustomMessage()` with the hidden `goal-continuation` type and agent attribution. The exact flushed native entry establishes acceptance; the prompt text does not cross worker IPC. Internal hidden messages remain hidden in the desktop transcript. Credential revalidation has an admission cancellation signal, so Stop during that wait cannot dispatch a prompt afterward.

A host-owned checkpoint is persisted before dispatch. Unknown/in-flight checkpoints do not automatically replay after restart. The existing running-session recovery also marks interrupted outcomes for inspection. A continuation that used no tools suppresses another automatic turn until explicit accepted user work or a goal activation. Pending native work gets a bounded recheck so a lost wake-up does not strand the goal; approvals are never answered by that recheck.

Cold goal restoration retains the prior native reconciliation: formerly active goals are paused by OMP. Restoration itself does not submit a provider prompt. A completed native goal is finalized by atomically recording mode `none` and one `goal-completed` custom entry, restoring the prior tool roster and clearing the live goal. Cold complete-state repair uses the same finalization; reopening a finalized branch does not append another completion.

## Desktop surfaces and limits

The selected conversation's activity observer stays active independently of the Environment card, coalesces matching invalidations and periodically recovers lost events. Late responses from another owner cannot replace its state. An error retains explicitly stale same-owner data.

The compact goal strip sits above the composer with native objective/status/budget, clear, pause/resume and an editor-tab action. Active elapsed time interpolates between native reports using the client's receipt clock; paused/offline figures remain the reported value. This interpolation never changes native billing or accounting. A persisted completion entry adds the subdued achievement footer to its actual preceding native assistant message; prose alone cannot produce that badge.

The editor uses a held base fingerprint, so a remote edit rejects rather than overwriting authored text. It exposes optional native token budget controls. Unsent objective and budget edits are stored on this device for the original restored window, host and conversation. They survive closing the editor and restarting the desktop, including offline reopening. Restored edits keep their original native conflict fingerprint; a fresh snapshot supplies the mutation ticket, and neither restoration nor refresh submits changes. Confirmed saves and explicit Revert clear only this editor’s saved draft, including an older cached revision left by a failed later write. A late reply from a closed editor cannot erase newer edits. Storage failures are visible; keep the tab open if local storage is unavailable. This is local draft recovery, not cross-device synchronization. The `/goal` composer-intent chip, new-conversation goal submission and remaining native command-menu integration still need implementation. The current application action opens the editor for an existing conversation; it is not full command parity.

Worker IPC is version 12. All required APIs are from the pinned OMP18.1.10 plus the existing selected browser patch; no dependency upgrade is included.

## Evidence

Controlled renderer acceptance at `.data/goal-panel-editor-final/result.json` exercises seven state/interaction groups and captures wide, narrow and 150% views with stable source hashes. It covers owner isolation, stale/error recovery, running pause/drop, held edit fingerprints, unknown non-replay, native-only achievement metadata and clock behavior. These captures do not establish registered reference parity.

Native worker tests cover mutation persistence/reopen, hidden admission, wall-time accounting, running pause, completion/finalization and cold repair. Host scheduler tests separately cover draft/native-work gates, stop/owner races and durable no-tool/unknown/in-flight checkpoints. The combined source suite passed 545 tests and 24,602 assertions, with 17 skips and zero failures across 113 files; all 496 recorded source/config files stayed unchanged (`.data/goal-batch-full.log`, `goal-batch-before-full.json`, `goal-batch-after-full.json`). The native HTTP acceptance includes zero-client continuation, draft gates, running pause/drop, pending asks, restart non-replay and persisted achievement projection. Later presentation-only editor changes have separate seven-group renderer acceptance and typecheck evidence; they are not attributed to the earlier full run. Installed goal behavior and registered native-window comparison remain unverified. An initial root combined run is retained as failed at `.data/goal-controller-focused-root.log`; it exposed a new fixture's external-directory dependency-resolution problem and is not a passing baseline.
