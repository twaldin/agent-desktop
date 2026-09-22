# Native Processes UI

`SessionProcessesPanel` presents the owning project's **OMP supervised processes**: registry rows, readiness, logs, per-process Stop/Restart and stdin. It is separate from async **Jobs** and configured **Environment Actions**.

This is an intentional native adaptation. The pinned reference's Background processes section lists still-running command executions left behind by conversation turns, excludes the newest in-progress turn, and offers **thread-wide Stop all background terminals** plus output viewing. Its verified row/output owners do not expose stdin or restart. The sibling Environment-summary placement is shared; daemon registry/lifecycle semantics are not claimed as exact reference controls.

## Integration

Mount the panel in a separate `Processes` summary section. Keep the existing Jobs panel. Pass the original selected host/session, that host's connection state, and section visibility. A collapsed section must pass `visible={false}` even when its children remain mounted; an absent session must not mount an active panel. Unmounting/hiding the panel never stops a native process.

The structural bridge is:

```ts
sessionProcesses?(
  sessionId: string,
  request: SessionProcessesRequest,
  hostId: string,
): Promise<SessionProcessesEnvelope>;
```

Types and runtime validators come directly from `packages/shared/src/session-processes.ts`. The UI accepts no worker observation in place of a durable host mutation receipt. Missing bridge support is displayed as unavailable, not as an empty registry.

`SessionProcessesPanel` takes `bridge`, `hostId`, `sessionId`, `connected`, `visible`, and an optional `journal`. Without a working journal, reads remain available but effects are disabled. Keep bridge/journal objects stable across component renders and remounts.

## Mutation journal

The injected `SessionProcessesJournal` owns no browser storage policy:

```ts
interface SessionProcessesJournal {
  load(scope: { hostId: string; sessionId: string }): Promise<unknown>;
  save(
    scope: { hostId: string; sessionId: string },
    entries: readonly SessionProcessOperationMetadata[],
  ): Promise<void>;
}
```

Each stored entry contains **only** `operationId`, `action`, `owner`, and `target`. `owner` binds native session/epoch/project; `target` binds broker/name/id/generation. The external journal key binds host/session. Never persist stdin, logs, receipts, row snapshots, error text or component drafts through this port.

Root supplies the window-persistence adapter through trusted main IPC, separate from renderer layout saves. `save` must resolve only after its exact metadata projection is durably saved, including the file/rename/directory durability boundary. Merely updating React state or scheduling a later save is insufficient. Loads must return the matching original scope's entries. The contract permits at most 32 entries per scope and 64 scopes per window; corrupt storage must block writes rather than erase identities. Report persistence failure; do not substitute an in-memory success or empty journal for unavailable storage.

The state layer records operation metadata before invoking the bridge. Journal load/validation/save failure bars dispatch. Reopening surfaces retained entries as unresolved operations. **Check status** sends only an explicit receipt lookup to the original host/session; it never resubmits the operation. A missing receipt is unknown, not evidence that nothing happened. Pending/unknown operations cannot be dismissed into permission to repeat them. Terminal receipt pruning failures remain visible and bar further effects until journal recovery.

## Ownership and display

- Default rows show useful process state, readiness, PID, output and controls. Broker/record/owner identities, launch generations and timestamps are in a closed Process details disclosure. Operation identities remain available in Operation details; reference/parity provenance belongs in this document, not product copy.
- First accepted native owner and broker stay pinned. Refresh/reconnect cannot silently switch epoch, project or broker. Changed/malformed replies leave the original cached data stale and effects disabled.
- Every effect uses the exact current row identity. Input and target are copied before asynchronous persistence/dispatch; row replacement cannot redirect a prepared action to a newer generation.
- Visible connected refresh is bounded to two outstanding bridge calls across controllers/remounts. Journal read/merge/write transactions are serialized per injected journal, and updates affect only captured original operation IDs. Hidden, collapsed, offline and absent-session states do not poll. Cached rows/logs remain readable offline; no mutation is queued for reconnection.
- States and readiness come from native rows. Starting is not Ready; outstanding log/port readiness is shown. Transitional stopping/restarting rows do not offer conflicting actions.
- Logs are escaped text, with empty/error/loading states and the host's truncation flag. Opening logs does not consume an async Job result.
- Stdin sends the entered text exactly, with no automatic newline. It stays only in the component draft/captured request, never in the operation journal. A draft clears only after the matching durable completed input receipt; failure/unknown does not imply delivery or invite automatic resend.
- Completed/rejected means a validated **durable mutation receipt**. A refreshed row alone does not settle an operation. Process state and receipt outcome are displayed separately.

## Verification boundary

Focused state/renderer tests exercise owner fences, journal-before-dispatch ordering, unknown-operation recovery, bounded requests, stale/offline controls, readiness and truncated logs. They do not establish native runtime, physical-host, installed-artifact or visual parity acceptance.

This authored lane does not launch an App, native host/worker, reference application or provider. Root owns the bridge, worker/HTTP/desktop integration, window persistence and the separately authorized live verification slot. Until those checks run, keyboard/focus code is source-supported and controlled rendering is automatically tested—not live visual verification.
