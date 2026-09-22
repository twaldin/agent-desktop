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

The editor uses a held base fingerprint, so a remote edit rejects rather than overwriting authored text. It exposes optional native token budget controls. Unsent objective and budget edits are stored on this device for the original restored window, host and conversation. They survive closing the editor and restarting the desktop, including offline reopening. Restored edits keep their original native conflict fingerprint; a fresh snapshot supplies the mutation ticket, and neither restoration nor refresh submits changes. Confirmed saves and explicit Revert clear only this editor’s saved draft, including an older cached revision left by a failed later write. A late reply from a closed editor cannot erase newer edits. Storage failures are visible; keep the tab open if local storage is unavailable. This is local draft recovery, not cross-device synchronization.

Worker IPC remains version 71. Goal composer admission uses command version 24 (`/v24/commands`) without changing the worker protocol or dependency patches. All native APIs are from the pinned OMP18.1.10.

## Composer intent

The Goal app action starts unsent Goal intent for a new conversation; on an existing conversation it opens that conversation's editor. An unshadowed native `/goal` opens the existing editor, or activates the new-conversation Goal chip. `/goal objective` removes only the prefix and prepares the objective for an explicit send. The native management verbs `set`, `show`, `pause`, `resume`, `drop`, and `budget` open the existing editor with retained-input guidance rather than silently changing a goal. Native extension/custom command ownership is resolved before converting typed commands. Guided-goal commands are not part of this route.

The ordinary draft text is the objective. `Draft.goal` holds the raw optional budget, so unfinished budget edits survive local recovery, host persistence, offline edits and reopening. Clear goal removes intent, not text, images, model or environment choices. This draft is independent of the per-window GoalPanel draft. Goal-formatted drafts retain `goal: null` after clearing or consumption; older clients cannot strip the field. The first such host write raises the monotonic database floor to 27.

New conversation creation and environment preparation keep their existing protocols. The captured first `session.prompt` carries the validated objective/budget using version 24. Inside the original native prompt reservation, the host validates credentials, model and attachments, creates the native goal, activates its goal tool and flushes its original session file before dispatching the ordinary user prompt. The first provider call therefore sees the durable goal and its native context. Existing non-terminal goals cannot be replaced implicitly; use GoalPanel for replacement.

An ordinary native user-message receipt is required before consuming the submitted revision. Definite preflight rejection preserves the draft and permits correction. Failures after possible goal creation remain `OUTCOME_UNKNOWN`, with the original command envelope retained; an explicit receipt retry does not create another goal or turn. Stop after creation follows native pause semantics. Goal intent cannot be queued, steered, or consumed by side-chat/question paths. Later edits and another window's GoalPanel drafts are never cleared by this admission.

## Evidence

Controlled renderer acceptance at `.data/goal-panel-editor-final/result.json` exercises seven state/interaction groups and captures wide, narrow and 150% views with stable source hashes. It covers owner isolation, stale/error recovery, running pause/drop, held edit fingerprints, unknown non-replay, native-only achievement metadata and clock behavior. These captures do not establish registered reference parity.

Native worker tests cover mutation persistence/reopen, hidden admission, wall-time accounting, running pause, completion/finalization and cold repair. Host scheduler tests separately cover draft/native-work gates, stop/owner races and durable no-tool/unknown/in-flight checkpoints. The combined source suite passed 545 tests and 24,602 assertions, with 17 skips and zero failures across 113 files; all 496 recorded source/config files stayed unchanged (`.data/goal-batch-full.log`, `goal-batch-before-full.json`, `goal-batch-after-full.json`). The native HTTP acceptance includes zero-client continuation, draft gates, running pause/drop, pending asks, restart non-replay and persisted achievement projection. Later presentation-only editor changes have separate seven-group renderer acceptance and typecheck evidence; they are not attributed to the earlier full run. Installed goal behavior and registered native-window comparison remain unverified. An initial root combined run is retained as failed at `.data/goal-controller-focused-root.log`; it exposed a new fixture's external-directory dependency-resolution problem and is not a passing baseline.


### Force after removing a composer Goal

Removing Goal intent leaves `goal: null` in the saved draft so older clients cannot silently discard its format. A new native Force submission from that draft uses prompt protocol 24 without a Goal payload. Both worker boundaries accept Force on protocols 18 and 24, with the same original command identity and typed Force receipts. Active Goal plus Force remains rejected; ordinary Force drafts still use protocol 18.

Previously saved protocol-18 Force commands are retained exactly for receipt recovery, including a cleared Goal draft. They are never silently upgraded or assigned a new command ID. The user must resolve the original outcome before a new send.

The regression exercises actual renderer submission, HTTP host, saved draft, worker and native Force arm/cancel with provider calls prohibited. Controlled restart checks retain both new protocol-24 and legacy protocol-18 envelopes. This does not claim real provider execution or mounted UI acceptance.
