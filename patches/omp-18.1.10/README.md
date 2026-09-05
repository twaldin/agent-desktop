# Native session ownership candidate

**Unintegrated and not ready for writable original-session import.** The maintained native acceptance run has **23 passing checks, zero failures**. The former fork source-retirement failure is fixed through a transition lifetime spanning actual `AgentSession` preparation, persistence drain and rollback. Cold persisted-child revival now verifies native identity under ownership, reads its current contract after admission, and drains failed setup. Other required ownership work remains below; this passing bounded fixture is not full import acceptance.

This candidate targets the npm source of OMP **18.1.10**, release commit `f241301c83726afe75a847e919b89977a54dafbe`. `baseline.json` pins the exact existing source hashes; `session-ownership-candidate.patch` is a concentrated package-root patch. It has not been applied to this project's `node_modules`, the root lockfile, the installed CLI, the desktop bundle, or any host service. It does not decide whether normal `omp` or an app-specific launcher eventually selects a cooperating build.

## Implemented boundary

- `SessionManager` acquires a per-canonical-file native `FileLock` sidecar before writable loading or initial header publication. It owns the handle until terminal close or a successfully drained fork transition retires/transfers that file owner. Independent sessions remain independently writable; there is no global lock.
- Existing admission can check an inspected canonical path, native ID, recorded cwd and content SHA-256 while holding ownership. It reads through a descriptor and validates file/parent identity and revision. Final symlinks and hard links are rejected.
- Local `FileSessionStorage` append and title writes use `O_NOFOLLOW`, validate the actual descriptor, and update the known revision after an owned write. Full rewrites validate the target and rebind only to their known staged inode after publication. The candidate reports `omp-session-file-v1-candidate`, not a completed import protocol.
- New, forked, and branched destinations acquire ownership before first publication. Basic move acquires both file leases, synchronously renames and rebinds the inode before asynchronous work resumes, and preserves the native session ID.
- `SessionManager.fork({prepare, rollback, sourceSuccessor})` retains both native leases while the owning `AgentSession` completes its preparation. Commit drains persistence and retires the source; failure drains destination work, restores the native snapshot and provider identity, and retires the failed destination only after rollback drains. Uncertain writer close or rollback seals the manager and retains the leases. Failed destination files/artifacts remain available for inspection. Session-change callbacks and recovery attribution move after commit. The native extension event runs during preparation, so arbitrary external handler effects are not transactional.
- In-flight bash retains native behavior: its detached source manager receives the same OS handle at commit, without releasing/reacquiring it. It appends to the original transcript and releases ownership after its last actual command finishes. This is a file-specific transfer, not a global lock.
- Cold persisted-child revival binds the native ID observed by its read-only factory peek to the later writable open. `SessionManager.open({expectedNativeId})` checks the header while holding its lease and before creating/migrating a manager. The actual reviver reads the latest `session_init` from that admitted manager on every revival, and drains/closes it if setup fails. This avoids both stale runtime grants and a stranded lease after SDK refusal.
- `close()` becomes terminal for file-backed managers: it seals late callbacks, closes/drains persistence, and releases ownership only on successful completion. Failed persistence does not explicitly release the lease; process exit releases OS ownership. `seal()` alone does not release it. Native durability remains software-crash durability; this patch does not introduce `fsync` or claim power-loss safety.

## Actual checks

The maintained fixtures invoke the copied **real native SDK, AgentSession, SessionManager, FileSessionStorage and FileLock**, with real filesystem operations and competing Bun processes. It does not fake a manager, replace the lock with an in-memory flag, invoke providers, or load user authentication/configuration.

Passing checks cover new ownership before the first header, same-process and cross-process writable exclusion, independent simultaneous sessions, inspected path/ID/cwd/revision mismatch rejection, symlink/hard-link rejection, append/title path replacement, same-inode external edits, fork/branch destination ownership, busy explicit fork destinations, close/seal/write-drain ordering, SIGTERM/SIGKILL release, and basic native move.

The original required source-retirement check now passes. Five added high-level checks establish:

1. Real `AgentSession.fork()` copies a real artifact and changes native/provider identity while both paths remain locked during a gated final preparation drain. Only commit releases the original and notifies identity observers; the new owner stays writable.
2. A controlled native storage-drain failure after high-level preparation restores the original native ID/path/cwd, entry IDs, agent messages and provider identity. Both leases remain exclusive during a gated rollback drain. After rollback the original remains writable and the failed destination becomes independently inspectable/writable.
3. A second controlled failure during rollback seals the manager, drops late appends and keeps both leases held, including after rejected close.
4. A terminal close racing the high-level fork waits for rollback; it never releases either lease while the transition is still at its gated drain.
5. A real bash process started before the fork finishes afterward, appends only to the original native transcript under the transferred owner, then permits another process to open it.

Storage subclasses only gate/fail actual native drain calls. Identity, manager state, file publication, artifacts, OS locks, competing Bun processes and bash execution are real. No provider turn is simulated or requested. These scenarios do not exercise active Hindsight/Mnemopi backends or arbitrary extension side effects.

Four additional native/process checks cover cold persisted-child revival:

- A real competing Bun owner makes two simultaneous `AgentLifecycleManager.ensureLive()` calls reject before any file change. Releasing it admits one coalesced native `AgentSession`, preserving original ID/path/cwd/message IDs and writable ownership. Actual park, re-revival and stale disposed-manager no-write are checked too.
- Replacing the transcript at the same path between factory creation and revival rejects the changed native ID before modifying the replacement file.
- Appending an updated `session_init` under another native owner before revival makes the new agent use that current contract and history, rather than the factory's stale peek.
- A genuine native SDK refusal for a replaced/aborted registry ref closes the newly opened manager and permits another process to acquire that original file afterward.

The new checks were run against the previous frozen 19-check candidate: **20 passed, 3 failed**, exposing the identity, stale-contract and failed-setup lease gaps. The updated candidate passes all 23. This is actual native API/process evidence, not a bundled CLI, interactive Agent Hub or provider-turn acceptance claim.

## Remaining work before integration

1. Apply and prove an owning transition lifetime for new/switch/branch and their rollback paths. Those paths still retain previous leases until terminal close. Fork alone now spans actual high-level prepare/commit/rollback and retires its source appropriately. Concurrent different transition types on one manager remain unaccepted; unrelated managers are independently writable.
2. Prove active memory-backend state and extension side-effect behavior around fork rollback, artifact-copy failures, and all new/branch error paths. The pinned artifact-copy helper logs/catches its own errors; this patch preserves that behavior and does not claim all-or-nothing artifact publication. The high-level proofs establish native file/identity ownership rollback, not rollback of arbitrary external effects.
3. Prove move's competing destination, artifact rollback, concurrent completed appends, interrupted relocation and rollback recovery. `CommandController.#relocateSession` / `#moveInteractiveCwd` can roll back after `AgentSession.moveSession()` returns, so source retirement must span that outer operation. Artifact directories also contain child session files/lock sidecars: parent move must coordinate their namespace with active owners and immediate revival, not merely hold the parent's two file leases. The basic smoke test neither disables moves nor accepts all move behavior.
4. Prove the executor-specific captured warm reviver, task resume and advisor paths. The persisted cold-factory path through actual lifecycle `ensureLive` and subsequent park/re-revival is now checked, including its current contract and ownership cleanup. That does not establish all background writer paths or relocation of a child namespace. Cold initial inspection/registry import identity before factory creation also remains outside this slice.
5. Close the atomic publication identity race. Current synchronous userspace checks are not a kernel conditional rename; parent-directory replacement and retargeting at the final publication boundary are unaccepted. Descriptor checks protect tested append/title retargets, but do not establish every rewrite race. Also prove ownership of the stable sidecar itself under path replacement; never unlink an active sidecar as recovery.
6. Preserve canonical paths through every transition, cover empty-draft deletion and sidecar/artifact mutation ownership, and test storage error recovery. Indexed/custom backends are unchanged and explicitly outside this candidate's claimed participation. Lease-bound Windows EPERM fallback has no acceptance; this milestone's targets are macOS/Linux.
7. Build the cooperating CLI from patched source, generate/verify native declarations, run native regression and platform tests, and test explicit stock-writer handoff. An available sidecar remains insufficient evidence that an old nonparticipating CLI is absent. The normal-command/app-launcher choice and application import integration remain pending.

## Reproduce

From this repository, with its pinned Bun/dependencies already installed:

```sh
bun patches/omp-18.1.10/run-isolated.ts
```

The runner verifies the untouched installed source hashes, copies the package under `.data/temp/omp-ownership-native/candidate-check-*`, applies the patch with zero fuzz, and runs with isolated HOME/agent/project/session directories. The dependency link only reads the already pinned dependency installation. It records patch/source provenance and the exact result privately, then verifies the original source hashes again. **The current expected exit status is 0 for these 23 bounded checks.** No package installation or user command selection occurs.

The initial positive run is `.data/temp/omp-ownership-native/run-2ABeno/result.json`; the earlier required retirement failure remains recorded in `.data/temp/omp-ownership-native/candidate-check-oLAJw9/run/result.json`. The new direct high-level run is `.data/temp/omp-ownership-native/fork-check-xWa1rg/result.json`. Fresh zero-fuzz reproduction: `.data/temp/omp-ownership-native/candidate-check-Dq1Hxl/run/result.json`, with exact baseline/patch provenance beside it in `provenance.json`. Each maintained rerun records `provenance.json` and `run/result.json` beneath its printed candidate directory. See [the ownership decision and stock-CLI proofs](../../docs/external-session-ownership.md) for why a launcher or extension alone cannot satisfy the full contract.

Cold-revival direct evidence: `.data/temp/omp-ownership-native/revival-check-EiRRLx/result.json`. The failing old-candidate comparison is `.data/temp/omp-ownership-native/revival-red-RVYAT1/result.json`; its 3 failures were retained rather than softened. Current pinned source provenance additionally includes `src/task/persisted-revive.ts`.

Latest complete zero-fuzz reproduction: `.data/temp/omp-ownership-native/candidate-check-46gsbh/run/result.json` (**23/23**), with unchanged-original source checks and exact patch attribution in `provenance.json`. Patch SHA-256: `abbb86cb3cd949b44046fd2e64bfa9c1c118c1f620e653b0c029e6e308051751`.
