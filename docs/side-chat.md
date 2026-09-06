# Native OMP side chat

Source30 connects a Side chat dock to pinned OMP18.1.10 `AgentSession.runEphemeralTurn`, using the native `/btw` prompt. The parent stays selected and can keep running. The dock has its own revisioned draft, Send/Stop, streamed Markdown answer, copy action, tab title and local unread marker. It is accessible through the dock menu, conversation menu, composer app action and Option–Command–S.

## Native behavior and ownership

OMP `/btw` answers from the current parent history, including its partial in-flight assistant text. It inherits the parent's model, thinking configuration, system context and account resolver. The provider request has its own lineage and stable prompt-cache key. The native operation does not execute returned tool calls or append this question/answer to the main transcript. The UI therefore labels the operation “No tools” and shows the inherited model without an inert model picker.

There is one current native side request per owning session worker. A new request replaces/cancels the previous native request, as the native TUI does. Stop addresses only that run's AbortController. Closing/hiding the viewer does not stop host-owned work. Drafts use the existing conflict-preserving cross-device draft controller; window navigation, read markers and dock placement stay local.

The host durably records intent before dispatch. Existing command receipts deduplicate retry identities. GET inspects the existing worker and records its latest observed answer; it cannot start/reopen a worker. A missing worker marks an observed running request as interrupted/unknown, and neither that read nor recovered pending commands replay it. This is last-observation recovery, not durable continuation of OMP's ephemeral turn. A matching terminal native observation can settle a lost desktop acknowledgement while preserving any newer draft edits.

Questions are limited to32KiB, answers to1MiB, and errors to4KiB. Hitting the answer bound aborts the side request and reports a failure instead of silently claiming a complete answer. The worker retains bounded request identities and explicitly refuses further admission when its identity ledger is full. Pending desktop receipts are recorded before dispatch; failure to save that receipt prevents sending.

## Reference scope

The frozen7868 bundle supplies `14-side-chat/01–06` for empty/draft/running/completed/tab-menu states and `17-hover-states/19–26` for summary rows, active/inactive tabs and child composer. The pinned7982 static shell maps its Side chat icon to `plus-chat-bubble-right-light-16`; the same SVG geometry is used here. Private source/offset evidence is `.data/side-chat30/icon-reference.json`.

The screenshots do not prove the behavior of a running tab on close, a worktree side chat, tool edits or restart. They also show a general child conversation with model/permission controls. Those controls cannot be falsely attributed to OMP's native same-model, tool-less ephemeral turn. The inspected native backend behavior above is the basis of this first slice; independent promotion/tool-capable sessions need their own ownership integration.

## Checks and remaining work

The broader regression checkpoint passes789 tests with29 platform/runtime skips and no failures (26,304 assertions/155 files). The final side-chat tests below follow the last Unicode/recovery changes and add persisted offline dock restoration; typecheck and desktop build pass. This is not a frozen packaged acceptance run.

The final focused check has53 passing tests and298 assertions across native worker, controller, actual SQLite recovery, desktop pending receipts, shortcut/dock and window-state paths. Native checks use the real pinned SDK/worker with a controlled local provider, not a hosted account. SQLite failure injection covers intent-before-dispatch, lost admission response, failed receipt persistence/reopen, late reads and worker loss. Desktop checks cover retained request identities, newer typing, cache-write failure, malformed persisted receipts, cancel-owner mismatch and stale/wrong-owner observations. Actual HTTP transport tests preserve the maximum JSON-escaped answer and reject foreign owners/oversized bodies. Failed UTF-8 bounds discard incomplete trailing code points and always retain a nonempty error.

The controlled App/Electron pass uses a real disposable host, pinned SDK and outbound-fetch-disabled local provider. Five settled captures exercise empty, close/reopen draft with focus restoration, running, stopped and completed states at1440×1000 content points/2880×2000 raster/DPR2/zoom1. The host records exactly start/cancel/start and unchanged main-message projection. Root inspected the final empty state against the frozen reference, correcting the stray textarea focus rectangle and centering the native icon. The final pass includes the UTF-8 boundary correction; all31 recorded source hashes remain stable across the run. Private evidence: `.data/btw-ui-1788729072800/result.json`; focused checks: `.data/side-chat30/integrated-final-with-restart.log`.

Earlier failed attempts remain in the private failure index and run directories. The actual App test caught missing host command-validator cases before any side provider request; the corrected entry point has dedicated malformed-input and byte-bound tests. No failed attempt is credited as a passing interaction.

This is source/native-contract and controlled App evidence, not installed desktop or pixel acceptance. The renderer fixture reaches real host HTTP through a scoped bridge, bypassing desktop main-process IPC; the separate HTTP transport tests do not turn that into packaged IPC proof. The existing release29 Work verifier run predates this slice and cannot certify it.

Still required for the full goal: direct `/btw <question>` composer dispatch, safe native `branchFromBtw` promotion with the changed session/file identity, the remaining Codex multi-tab/child-composer behaviors, parent sidebar unread presentation, full hover/focus/geometry comparison and independent packaged cross-device acceptance. Native `/btw`'s one-request lifetime and inherited configuration must remain explicit through those additions. Scheduling and native plugin/MCP management are separate core gaps; agent-system addons remain deferred.
