# Candidate24: bounded native move transaction

**Isolated, unintegrated, and incomplete for original-session import.** Fresh macOS reproduction passes **11 move checks plus 23 existing ownership checks, zero failures**. This is an incremental patch on frozen candidate23 (`abbb86cb3cd949b44046fd2e64bfa9c1c118c1f620e653b0c029e6e308051751`). Candidate23, its runner/results, installed dependencies, user sessions/configuration and normal CLI selection remain unchanged. No artifact-directory aliases are introduced.

`SessionManager.moveTo(cwd, directory?, {prepare?, rollback?})` now owns the transition through the caller's cwd work and final persistence drain. `AgentSession.moveSession` forwards that optional native callback contract. Both `CommandController` relocation and its completed persistent shell `cd` path use it; the shell path retains its existing manager-level admission semantics.

- Source and destination file owners remain held during forward cwd setup and rollback. Only completed commit retires the source. A failed move retires the destination only after the restored source and caller rollback drain.
- Close seals late appends immediately and waits for the move to settle. Recovery can perform its explicit synchronous owned metadata write while sealed; it does not temporarily reopen general writes.
- Competing new/open/fork/branched-file/drop/move transitions cannot change the manager's file identity while the outer move is pending.
- Rollback preserves native entries and title changes completed during forward/rollback work. Native cwd/path/additional-directory metadata is restored, along with ordinary artifact files and the native draft sidecar.
- Uncertain writer close, failed rollback, or failed physical rename-back seals the manager and retains its file/namespace owners. The controller reports the failure and requests shutdown; it never reports a successful move or independently admits the old path.
- Per-artifact-directory native namespace gates prevent new/open child admission during a parent relocation, including admission that would recreate a vacated source directory. These gates live outside the directory being moved and are held only briefly for normal file admission; independent native sessions remain concurrent.
- Existing nested `.jsonl`/`.jsonl.lock` trees, nested-session moves, unverified artifact symlinks and existing destination artifact directories are refused before transcript relocation. **Active and parked nested-session relocation is still unsupported.** A busy refusal preserves the existing child; it is not acceptance of full move parity. Inspection is bounded at 100,000 artifact entries.

The advertised isolated protocol is `omp-session-file-v2-move-candidate`; it is not compatible participation proof for stock writers or frozen candidate23 writers. Namespace and stable-sidecar identity under adversarial replacement remain unaccepted, as do the existing conditional-publication/parent replacement gaps. This patch does not claim power-loss atomicity, a transactional rollback of arbitrary extension/configuration side effects, active artifact-writer rebinding, or all background warm/task/advisor paths.

## Verification

```sh
bun patches/omp-18.1.10/candidate24/run-isolated.ts candidate23
bun patches/omp-18.1.10/candidate24/run-isolated.ts candidate24 --full
```

The first command intentionally exercises the stronger move contract against the old candidate. The runner verifies installed baseline hashes, copies the native package, applies candidate23 and (when selected) candidate24 with zero fuzz/offset, and uses isolated HOME/agent/project/session directories. The full run also executes the unchanged 23-check ownership fixture in a separate isolated child. Its old generic pending-summary text is preserved; this document scopes the additional move checks.

The tests use real `SessionManager`, `AgentSession`, `CommandController`, filesystem/storage, native `FileLock`, competing Bun processes, and a real shell `cd`. No provider calls are made. The UI surface is a non-rendering fixture; cwd callbacks perform actual process `chdir` with explicit failure/drain gates. Full interactive settings/extension rescoping and physical Linux acceptance are not claimed by these tests.

Original red evidence: `.data/temp/omp-ownership-native/move-red-sId6H6/run/result.json` (**0/3**). It demonstrates retained source ownership after successful commit, admission during close/cwd rollback, and relocation of an actively owned child. The 9-check direct native run is `.data/temp/omp-ownership-native/move-check-D2EP2u/result.json` (**9/9**). The unchanged ownership suite passed **23/23** at `.data/temp/omp-ownership-native/move-candidate24-ifHXYb/regression/result.json`.

Fresh reproduction also caught an overlooked native persistent-shell controller caller after the obsolete helper was removed; the failure is preserved in `candidate24-full.log`. The subsequent shell fixture initially lacked its native loader's render-notification callback; that fixture error remains in `candidate24-full-2.log`. A final competing-transition test exposed an unguarded synchronous branched-file operation; its **10 pass / 1 fail** comparison is `.data/temp/omp-ownership-native/move-candidate24-PhfYdu/run/result.json`. These failures were retained and corrected; no installed process was altered.

Final zero-fuzz reproduction: `.data/temp/omp-ownership-native/move-candidate24-5rpeYS/run/result.json` (**11/11**) and `regression/result.json` (**23/23**), with exact baseline/patch attribution in `provenance.json`. The runner verified original installed source hashes again after both child processes exited. Incremental patch SHA-256: **`03543f9616daa3ce40369e1358ed42d44b8ef4fa25ca9aca8ccf63c5643d5aff`**. Reproduction log: `.data/temp/omp-ownership-native/candidate24-final.log`.

## Remaining native rebind seam

`registry/agent-registry.ts:attachSession` can change a live ref's path, but it does not update lifecycle-owned cached revivers. `registry/agent-lifecycle.ts` retains both `#adopted.revive` closures and in-flight `#revivals`/`#parks`. `task/persisted-revive.ts` captures `sessionFile` before returning the factory's reviver; changing the ref alone leaves the closure stale. The executor has additional warm/task/advisor captures. `ArtifactManager` also has an immutable directory and callers can retain allocated paths.

The next cohesive seam belongs to native lifecycle relocation: reserve the affected refs against new revival, settle existing park/revive operations, verify child IDs and file leases, then update exact refs and rebuild/rebind their native factories on commit (restore them on rollback). Warm factories must preserve their native contract rather than being replaced indiscriminately with a cold default. Their captured paths and retained artifact writers must be rebound or drained before directory publication. Until those paths are tested together, candidate24 refuses the child namespace and leaves it intact. Permanent source symlinks would hide these stale-reference obligations and are not the chosen fix.
