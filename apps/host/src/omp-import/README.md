# Original native session import: inspection and ownership proof

The owning host exposes read-only discovery and inspection plus explicit original-session admission for known cooperating native writers. The desktop command opens an inspection picker, obtains a preparation for the exact inspected revision, and asks for confirmation before sending a durable command. The native worker opens the original file under its writer-process ownership; catalog publication preserves its native ID, history and cwd. There is no copy/fork fallback.

Arbitrary stock OMP files remain inspectable but are refused for writable import. An existing file cannot be retrospectively enrolled by a checkbox, a quiet-file check, a free lock, a PID scan or this UI. The pinned native participation entry point establishes its binding before an original's first header is written. Unpatched writers and direct filesystem writes remain outside that guarantee.

## Current small interface

```ts
const imports = new NativeSessionImports({ sessionDirectories: trustedOwnerPaths });
const candidates = await imports.scan();
const inspection = await imports.inspect(candidateId);
const admission = await imports.checkAdmission(candidateId, inspection.revision);
```

`scan()` runs only on explicit import discovery, not automatic sidebar cataloging. Its directories come from the owning host's native profile/project resolution or an explicitly selected local directory; a renderer must not supply arbitrary paths. Each candidate has an opaque ID, original source path and native summary fields. Native listing counts only a prefix, so `messageCountEstimate` is labelled accordingly. `persistedStatus` describes the last saved message, never live ownership.

`inspect()` reads the original using the pinned native JSONL/title-slot parser and returns an opaque revision, canonical original file, native identity, recorded/canonical cwd, full entry/message counts and parse/path problems. It does not open a writable SessionManager, initialize accounts/models/extensions, repair backups or copy history. Symlinks must resolve within the explicitly selected native directories; hard links are refused until there is an alias ownership contract. Missing cwd blocks admission instead of accepting OMP's fallback cwd. Corrupt records and newer formats are explicit. Full inspection defaults to 64 MiB and rejects oversized files explicitly; it does not pass a partial transcript off as a complete import.

`checkAdmission()` rejects stale revisions. A well-formed stock OMP source still returns `{allowed:false,reason:"ownership-unverified"}`. This inspection result is not an approval checkbox; the separate native admission service must prove participation and acquire ownership. Revisions and file stats detect ordinary changes; they cannot prove another process is inactive or prevent a future external write.

## Historical pinned baseline and the reason for participation

Baseline: OMP 18.1.10, commit `f241301c83726afe75a847e919b89977a54dafbe`. The original pre-admission session-manager source hash matched the pinned reference: `58bac0e379c726692cd87638dfd73217079eb44f560e96b909d8b4ddcb54b6b3`.

| Evidence | Consequence |
| --- | --- |
| `session-manager.ts:2913` opens with `loadSessionFile`, constructs a manager and calls `#setSessionFile`. There is no process ownership acquisition. The contrary comment at `:2944` is not implemented. | `open()` is not an ownership receipt. |
| `session-storage.ts:123` opens a normal append descriptor. The native persistence queue/commit guards are manager-local. | Independent native managers can both append, with separately cached branch/context state. |
| `session-listing.ts:622` provides `listSessionsReadOnly`; ordinary directory listing can recover orphaned backups. Listing status and count are derived from prefix/tail windows. | Use the readonly function and avoid claiming live state or complete counts from its summary. |
| `session-manager.ts:1869` closes the current writer; later appends can reopen it. `seal()` at `:1900` raises the terminal write barrier, and normal AgentSession disposal uses final release. | Merely observing `close()` is insufficient. A release protocol must revoke the writer and drain it, or wait for its writing process to exit. |
| `pi-utils/src/file-lock.ts` uses a native process-owned advisory lock on the resolved path plus `.lock`. Linux uses a kernel socket name; other Unix platforms use flock sidecars. | The lock excludes cooperating participants and is released on process death. It cannot stop an ordinary open/write that ignores the lock. The physical proof here ran on macOS; Linux behavior is source-described until separately tested. |
| The pre-admission `omp-workers/runtime.ts` guarded canonical files only within that runtime, and the app host lease guards the app data directory. `HostStore.upsertSession` keys by native ID. | Neither blocks stock OMP. Integration must also reject an existing catalog ID bound to another file and multiple native files sharing an identity. |

The account broker owns credential refresh/selection and credential quota blocks. Its inspected client/types do not expose session-file execution ownership. Import must preserve the owning worker's existing native profile/auth/broker discovery; no credentials or broker configuration should be read from an imported transcript or replicated into app state. This proof made no user auth or broker calls.

## Current ownership and recovery flow

The host derives `sessionsRoot` from its selected native profile using the pure `getSessionsDir` path helper. Discovery enumerates existing directories only and resolves opaque IDs within that process; it never calls the migration-capable default-session-directory helper. The ownership directory is the canonical owning profile's `original-session-ownership`. All participating processes must select the same canonical path.

1. `NativeOriginalSessionAdmission.prepare` re-inspects the selected source and its native participation record without opening a writer. Preparation is bounded and process-local; an expired preparation requires another explicit review.
2. `admit(commandId, preparationId)` journals the exact command before callbacks. `OriginalImportRecords` atomically reserves the native-ID/file pair before worker startup, preventing replacement of a catalogued original or an unresolved import.
3. The child calls the native original-admission API. It acquires the original writer-process lock before writable load/migration and compares the captured source and binding under ownership. Native identity-changing operations without a matching ownership transition are refused before effects.
4. The host requires the exact retained, current worker handle and native binding before publishing the catalog entry and its durable binding together. A native admitted receipt alone is not catalog publication or evidence of a live worker.
5. Reopening an imported catalog entry uses its saved native binding and a fresh internal native preparation/admission. It never falls through to ordinary `runtime.open`. A current retained handle may be reused; a competing writer blocks cold reopening.
6. Shutdown stops new actions, drains pending admission, then disposes the original-admission owner before ordinary reconnect handoff. Failed cleanup is not reported as released ownership.

The authenticated HTTP boundary offers listing/inspection, `POST /v1/session-imports/prepare`, `POST /v1/session-imports/admit` and lookup-only `GET /v1/session-imports/outcomes/:commandId`. Inputs contain opaque IDs, never caller-selected source paths. Host, inspected revision, command and returned original identity are validated across main/preload/renderer. The host bounds response work; cancellation after admission dispatch does not abandon catalog publication.

Before confirmation dispatch, the renderer saves the original command and preparation under a separate local recovery key per command. Concurrent windows cannot overwrite one another's saved request. A lost response remains unknown until an explicit outcome lookup; remount/reconnect never replays an import. An explicit retry is available only for a host-reported absent command and resends the same tuple. Imported status describes durable catalog publication, not a standing claim that an external writer is absent. Damaged/unavailable recovery storage prevents new dispatch and preserves the stored bytes.

Unsupported enrolled switch/move/revive/fork transitions remain explicit native refusals and product backlog, not claims of complete imported-session feature parity. Participation does not create an OS security boundary against unpatched or arbitrary writers. Cross-machine physical acceptance, provider execution and full imported-session feature acceptance remain separate gates.

## Verification

`bun run test apps/host/src/session-import-server.test.ts` exercises actual authenticated host HTTP and desktop transport against disposable native originals: stock refusal, an actual held cooperating writer, exact catalog publication after release, duplicate/status lookup without replay, host restart with a competing writer, and same-original reopening after release. The child workers use a transport guard that rejects external fetches; these checks do not prove provider behavior.

The renderer state tests cover late replies, connection/capability loss, storage failure, two-window recovery, explicit same-command retry, and outcome lookup cancelling an in-flight listing without leaving loading stuck. The private hidden-App fixture composes the actual StrictMode App with real host/worker/native admission and a fixture IPC dispatcher; intentional lost delivery and dialog remount recover by status, then explicit Open routes to the original host/session and renders its real native history without another admission or session command. Synthetic Electron input and hidden captures are not physical keyboard, production-main-handler, reference-pixel or all-platform proof.

## Earlier ownership proof retained

`bun test apps/host/src/omp-import/inspection.test.ts` starts actual native managers in separate Bun processes inside temporary HOME/session/project directories. It proves:

- Readonly discovery/inspection preserve bytes and orphaned backups; original identity/cwd/full message count are retained, and stale revisions, invalid cwd, corruption and unsafe aliases are refused.
- A stock external native manager and a second native manager both append while the conventional advisory lock is held; close alone permits another append.
- A participating writer's real native lock blocks takeover, then allows a same-file/same-ID/same-cwd native continuation after the writer closes and exits. SIGKILL releases that writer's kernel ownership as expected.

The cooperative case is conditional proof of the protocol, not proof that user runners already participate. The current integration tests above add host/catalog/worker/UI coverage; physical external-runner and full feature acceptance remain pending. No provider response, copied conversation or PID-only lock is used in this test.
