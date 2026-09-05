# Original native session import: inspection and ownership proof

This slice is read-only inspection plus a real native-file ownership proof. It is **not wired to the host, workers, protocol or renderer**, and it does not implement writable import for stock external OMP. The agreed result remains original file/history/identity on its home machine, with writes admitted only after the external runner releases ownership. There is no copy/fork fallback.

## Current small interface

```ts
const imports = new NativeSessionImports({ sessionDirectories: trustedOwnerPaths });
const candidates = await imports.scan();
const inspection = await imports.inspect(candidateId);
const admission = await imports.checkAdmission(candidateId, inspection.revision);
```

`scan()` runs only on explicit import discovery, not automatic sidebar cataloging. Its directories come from the owning host's native profile/project resolution or an explicitly selected local directory; a renderer must not supply arbitrary paths. Each candidate has an opaque ID, original source path and native summary fields. Native listing counts only a prefix, so `messageCountEstimate` is labelled accordingly. `persistedStatus` describes the last saved message, never live ownership.

`inspect()` reads the original using the pinned native JSONL/title-slot parser and returns an opaque revision, canonical original file, native identity, recorded/canonical cwd, full entry/message counts and parse/path problems. It does not open a writable SessionManager, initialize accounts/models/extensions, repair backups or copy history. Symlinks must resolve within the explicitly selected native directories; hard links are refused until there is an alias ownership contract. Missing cwd blocks admission instead of accepting OMP's fallback cwd. Corrupt records and newer formats are explicit. Full inspection defaults to 64 MiB and rejects oversized files explicitly; it does not pass a partial transcript off as a complete import.

`checkAdmission()` rejects stale revisions. A well-formed stock OMP source still returns `{allowed:false,reason:"ownership-unverified"}`. This is the material integration gap, not an approval checkbox. Revisions and file stats detect ordinary changes; they cannot prove another process is inactive or prevent a future external write.

## What the pinned native implementation actually proves

Baseline: OMP 18.1.10, commit `f241301c83726afe75a847e919b89977a54dafbe`. The installed session-manager source hash matches the pinned reference: `58bac0e379c726692cd87638dfd73217079eb44f560e96b909d8b4ddcb54b6b3`.

| Evidence | Consequence |
| --- | --- |
| `session-manager.ts:2913` opens with `loadSessionFile`, constructs a manager and calls `#setSessionFile`. There is no process ownership acquisition. The contrary comment at `:2944` is not implemented. | `open()` is not an ownership receipt. |
| `session-storage.ts:123` opens a normal append descriptor. The native persistence queue/commit guards are manager-local. | Independent native managers can both append, with separately cached branch/context state. |
| `session-listing.ts:622` provides `listSessionsReadOnly`; ordinary directory listing can recover orphaned backups. Listing status and count are derived from prefix/tail windows. | Use the readonly function and avoid claiming live state or complete counts from its summary. |
| `session-manager.ts:1869` closes the current writer; later appends can reopen it. `seal()` at `:1900` raises the terminal write barrier, and normal AgentSession disposal uses final release. | Merely observing `close()` is insufficient. A release protocol must revoke the writer and drain it, or wait for its writing process to exit. |
| `pi-utils/src/file-lock.ts` uses a native process-owned advisory lock on the resolved path plus `.lock`. Linux uses a kernel socket name; other Unix platforms use flock sidecars. | The lock excludes cooperating participants and is released on process death. It cannot stop an ordinary open/write that ignores the lock. The physical proof here ran on macOS; Linux behavior is source-described until separately tested. |
| `omp-workers/runtime.ts` currently guards canonical files only within that runtime, and the app host lease guards the app data directory. `HostStore.upsertSession` keys by native ID. | Neither blocks stock OMP. Integration must also reject an existing catalog ID bound to another file and multiple native files sharing an identity. |

The account broker owns credential refresh/selection and credential quota blocks. Its inspected client/types do not expose session-file execution ownership. Import must preserve the owning worker's existing native profile/auth/broker discovery; no credentials or broker configuration should be read from an imported transcript or replicated into app state. This proof made no user auth or broker calls.

## Smallest sound writable integration

Require a cooperative writer entry point on that host, or add ownership to the pinned native writer upstream. Acquire the same canonical original-file lock **in the process that writes the session**, before writable native open, and hold it through terminal native disposal. Acquiring only in a launcher/daemon is insufficient if that process can die while its child continues writing. Do not delete the sidecar on release; native release handles ownership without racing a successor.

The next concrete candidate is a Bun preload/bootstrap in the stock CLI's own process, initially requiring an explicit original session path. It would acquire before the CLI module loads and keep the native lock alive until process exit, then use the same bootstrap contract in the app's session worker. This still needs an actual stock-CLI proof and a policy for every session-changing command; it is a proposed integration path, not an implemented wrapper or a guarantee that existing runners use it.

All participating transitions must acquire before adopting a source, including resume/switch/revive/move, and preserve the lock across native atomic file replacement. A path-based sidecar survives an inode replacement; a lock on the JSONL inode does not. Resolve symlinks, reject hard-link aliases and duplicate native IDs until they have an explicit contract. A late `session_start` extension is too late to establish this: native `open()` can already migrate/rewrite or create a missing source before the extension runs. A stock CLI started outside the participating entry point remains outside the guarantee.

The future host-only admission seam should be `admit(candidateId, expectedRevision)` through a configured cooperative ownership adapter. It must:

1. Confirm this source belongs to the participating writer regime. An absent PID, quiet file, "complete" status, free sidecar or renderer assertion does not establish that fact.
2. Acquire the writer-process lock; return busy while the external writer owns it.
3. Re-read the original under that lock, compare the reviewed revision/ID/cwd and the catalog's existing ID/file ownership, then open the original through the real worker.
4. Return the same native ID/file/cwd plus a lifetime-bound handle. Catalog adoption occurs only after the native worker returns that identity; failures release resources without minting a replacement session.

Choosing and wiring that cooperative entry point is outstanding. This bounded slice intentionally cannot claim safe writable imports from arbitrary already-running stock CLI sessions. OS process/file-handle scans can provide negative evidence (a writer is present), but cannot close the race or replace participation. Do not weaken this requirement to make the UI's Import button appear functional.

## Actual proof

`bun test apps/host/src/omp-import/inspection.test.ts` starts actual native managers in separate Bun processes inside temporary HOME/session/project directories. It proves:

- Readonly discovery/inspection preserve bytes and orphaned backups; original identity/cwd/full message count are retained, and stale revisions, invalid cwd, corruption and unsafe aliases are refused.
- A stock external native manager and a second native manager both append while the conventional advisory lock is held; close alone permits another append.
- A participating writer's real native lock blocks takeover, then allows a same-file/same-ID/same-cwd native continuation after the writer closes and exits. SIGKILL releases that writer's kernel ownership as expected.

The cooperative case is conditional proof of the protocol, not proof that user runners already participate. App/catalog/worker/UI integration and physical external-runner acceptance remain pending. No provider response, copied conversation or PID-only lock is used in this test.
