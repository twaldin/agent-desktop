# Composer permissions

Release 12 adds a permission choice before the first prompt and for later idle prompts. This is one bounded composer slice, not full composer or permission-system parity.

| Choice | Native OMP meaning |
| --- | --- |
| Follow native default / current session | A new session uses its workspace configuration. An existing session keeps its actual current policy. |
| Always ask | Prompt for native write and execution tiers. |
| Write | Allow native writes; prompt for execution tiers. |
| Yolo | Allow native tiers without a mode-level prompt. |

Native per-tool policies, tool declarations and provider gates still apply. These are OMP approvals; they do not establish an additional OS sandbox. Advanced native policies remain in OMP Settings.

## State and admission

An explicit draft `approvalMode` follows the same owner revisions, offline cache, conflict resolution and exact submission envelope as text/project/model/thinking. Absence means follow native state. A Settings refresh updates the current/default label and leaves an explicit draft choice intact. Conflict and pending-submission details show both text and selections.

The host retains the selected policy as `SessionSummary.approvalOverride` in its own catalog. OMP 18.1.10 does not persist a runtime `tools.approvalMode` override in native session history. Create/open applies the host's choice before SDK construction and extension startup. An idle prompt commits an explicit choice before asking the worker to apply it or execute the prompt. If the prompt later fails, the chosen session policy remains; the pending details explain that partial outcome.

The exact native Settings override/clear uses this same host-owned policy path and revision check. Clear removes the app override and follows that worker's loaded configuration. Native read-only Settings does not reload from disk; reopening a worker loads fresh workspace defaults. Other supported runtime setting overrides retain their existing lifetime.

A running steer may assert its captured permission choice but cannot change the running policy. Both owner and worker check it, including the worker's actual native mode immediately before queue admission. A differing choice retains the draft for an idle prompt instead of silently discarding the selection.

If native application loses its acknowledgment, the saved policy remains authoritative. The host retires that worker before reopening from the saved policy. Unverified disposal keeps admission blocked; it cannot create a second worker or replay the prompt automatically. A failed durable write admits no prompt. Pending retries retain their original command identity and policy.

This policy belongs to the app's host catalog. An unrelated stock OMP runner does not restore it; external-session handoff remains subject to the incomplete cooperating-runner contract in [external-session-ownership.md](external-session-ownership.md).

## Version compatibility

Permission-bearing draft/create/prompt/steer envelopes use `/v2/commands`. Permission Settings edits use `/v2/sessions/:id/controls`. Neither falls back to an old route: older hosts normalize away unfamiliar fields, which would otherwise silently lose the choice. The new v1 command handler rejects raw permission intent. An uncoded missing v2 endpoint reports an unsupported host; other delivery failures retain the existing uncertainty rules.

Persisting any permission-bearing command, draft, conflict or session promotes SQLite state to schema 2 in the same transaction. New hosts read schemas 1 and 2; old readers reject 2. New artifacts declare their supported schemas, and installation/restart/rollback checks compatibility before stopping a working host and again after shutdown. No automatic database downgrade or backup restore erases permission intent.

## Evidence and remaining checks

- Renderer/controller and actual old-HTTP-host tests verify permission-only offline conflicts, capture versus later edits, original-envelope retries, visible pending session identity, and no old-route fallback.
- Production App + isolated actual native host/worker acceptance: `.data/app-startup-acceptance-source12-final/summary.json`. All 161 source/build hashes matched before and after. The native startup question appeared in New chat before admission. The captured Write policy was applied; newer unsent Always ask/text edits survived answering it. A native handled slash command ran exactly once, without a provider. An actual owner draft conflict retained both permission choices. Six wide/narrow/zoomed captures and integrated app-shortcut ownership were checked separately from installed behavior; both isolated processes exited cleanly.
- Host native/HTTP/SQLite failure and restore checks are maintained in `permissions-http.test.ts`, worker permission contracts and `approval-recovery.test.ts`. The frozen source 12 suite passed 346 tests / 23,230 assertions, one Linux-only skip, no failures; typecheck passed. Deckbox separately passed 20 isolated tests / 110 assertions against its installed production sources, including the actual systemd parser and native permission receipt-loss recovery. Provider fetch was blocked in these isolated checks.
- Home's installed 12→11→12 rollback before any permission save preserved exact catalogs/drafts and original native bytes. Saving the actual composer choice promoted state to schema 2; attempting the old release then refused before quitting the one running desktop, leaving host PID, window and data unchanged. Evidence: `.data/ui-acceptance/home-release12-rollback-to11-preservation.json`, `home-release12-return-preservation.json` and `release12-installed-rollback-refusal.json`.
- Actual installed provider/tool acceptance is recorded in `.data/ui-acceptance/release12-installed-permissions-result.json`. Both physical desktops displayed the same Home-owned write request: Work denied the first, leaving the file absent; Home approved a second distinct request, producing the exact 59-byte Unicode content once. Native IDs identify two user entries and one denied/one successful write result. Home's clean host restart preserved the chosen policy, exact drafts/catalog and original transcript bytes. Work remained open and read the restarted host, but its observer missed the short disconnect interval.
- Home's actual This session Settings scope changed Always ask→Write, cleared to native Yolo, then restored Always ask. Work's composer reflected each result. Drafts, commands, native entries and output bytes stayed unchanged throughout those Settings edits. Shared New chat retained and then restored its original selections across both UIs; the older unsent session draft stayed exactly revision 16.
- Account intent before the first prompt, richer permission menus, additional policy combinations and simultaneous competing approval responses remain separate requirements. The restart also exposed Auto→Xhigh reasoning selection loss under investigation; it is not counted as a successful selection-persistence check.
