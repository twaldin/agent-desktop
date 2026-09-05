# Original external OMP session ownership

Original import must preserve native session ID, file, working directory and history. App control starts only after the external writer releases ownership. An idle status or a readable file is insufficient evidence.

**OMP 18.1.10 stock CLI plus a launcher/extension cannot enforce this contract.** A same-process preload can acquire a native OS lock before explicit resume, but existing extension events do not cover every native writable open or file transition. Recommend a pinned cooperating OMP build with ownership integrated into native persistence; a launcher can select that build. Installing or maintaining that build remains a separate decision and implementation task.

The baseline is release commit `f241301c83726afe75a847e919b89977a54dafbe`. Experiments used the unmodified installed npm CLI bundle and matching source, isolated HOME/native/project/session directories, and no provider work. No installed/global OMP or live user configuration was changed.

## Tested behavior

| Transition | Evidence | Result |
| --- | --- | --- |
| Explicit original resume | Actual bundled CLI | Same ID/file resumes under a same-process sidecar lock; a busy lock rejects before session bytes change |
| Switch and new | Actual bundled CLI RPC | Switch opens an already locked target; new creates and persists an unowned destination |
| Switch/new/branch guards | Actual bundled CLI with supported extension events | Before hooks can cancel them; new/branch hooks do not expose a destination before native allocation |
| Fork guard | Actual native SDK `AgentSession.fork` | Before-switch cancels fork; its event has no destination path |
| Move | Actual bundled CLI `/move`, returned `agentInvoked:false` | Same native ID moves to an unlocked writable path despite all before-switch/branch guards |
| Cold child revival | Actual native persisted-reviver factory | Opens and appends a sidecar-locked original; restricted contracts intentionally omit extensions |
| SIGTERM and SIGKILL | Actual bundled CLI | Native OS ownership is reacquirable after process exit |
| JSONL inode replacement | Actual bundled CLI process | Stable canonical sidecar remains busy |
| Canonical path retarget before open | Actual bundled CLI with deterministic preload barrier | Replace locked A with a symlink to already locked B; stock CLI resumes B and successfully writes B's native title |

The successful experiment has **10 bundled-CLI checks and 4 native-API checks**. The interactive Agent Hub and other operating systems were not exercised in this slice. Source inspection additionally found direct writable opens for task resume/warm revival, and pre-extension opens for continue/latest/ID/picker/auto-resume/initial fork. Existing stock writers do not participate in advisory locking.

Reproducible temporary fixtures, complete transition matrix and exact source hashes are retained in `.data/temp/cooperative-cli-proof/`: `README.md`, `scenario.ts`, `revive.ts`, `result.json`, `revive-result.json`, `source-index.json`. The earlier independent import proof is `apps/host/src/omp-import/inspection.test.ts`. The inspector remains unintegrated and rejects stock writable admission as `ownership-unverified`.

## Required native persistence lease

The smallest complete boundary belongs to native `SessionManager` persistence and must be shared by app workers and cooperating external processes:

1. **Existing admission:** acquire the canonical ownership key before writable loading/migration, verify the inspected native ID/cwd/revision under that lease, and bind the actual writer to the admitted file. Path retarget, hard-link alias and identity changes fail before writing. Launcher-only `realpath` checks do not close the demonstrated race.
2. **New/fork/branch:** allocate the destination ID/path and acquire ownership before writing its first header or rewrite. A post-transition hook is too late.
3. **Switch/rollback:** acquire the destination while retaining source ownership until success or rollback settles. Publish identity only after commit.
4. **Move:** hold source and destination ownership through session/artifact relocation and rollback, preserving native ID while updating canonical path/cwd.
5. **All writers:** main sessions, child/advisor sessions, task resumes and cold/warm revival obey the same invariant. Readonly inspection must not create a writable manager or repair files.
6. **Release:** seal the native manager and drain all writes before releasing the lease. Stock `close()` alone is nonterminal and allows later callbacks to reopen a writer. OS process death releases ownership; never delete an active sidecar or infer ownership from PID existence alone.
7. **Import handoff:** require explicit cooperating-protocol participation. An obtainable sidecar does not prove a stock writer is absent. Introducing cooperating ownership must not silently treat existing nonparticipating sessions as safe.

A coarse global lock would serialize unrelated sessions; cancelling move or revival would remove agreed functionality. Neither satisfies the goal. The proposed native lease is a required implementation seam, not an ownership waiver.

## Native source anchors

All paths are under `node_modules/@oh-my-pi/pi-coding-agent/src/`:

- `main.ts:940`: initial manager selection; `:728`: missing-cwd open/move; `:1778`: picker open.
- `extensibility/shared-events.ts:33`: before-switch shape; `:51`: before-branch shape.
- `session/agent-session.ts:7565`: new; `:7696`: fork; `:7767`: unhooked move; `:8706`: switch; `:8978`: rollback; `:9070`: branch; `:9173`: `/btw` branch.
- `session/session-manager.ts:1406`: set-file; `:1484`: new; `:1505`: fork; `:1546`: move; `:1869`: close; `:1900`: seal; `:2722`: branch destination; `:2913`: open.
- `task/persisted-revive.ts:116`: writable open precedes extension setup at `:195`; `task/executor.ts:3236,3452`: other resume/revival opens.

Comments claiming an existing single-writer lock at `session-manager.ts:2944` and `persisted-revive.ts:115` are contradicted by the executed proofs.

## Isolated native patch candidate

A maintained [native persistence candidate](../patches/omp-18.1.10/README.md) now exercises the common boundary in a copied 18.1.10 package. It adds manager-owned per-file native leases, descriptor/identity checks at local file writes, inspected ID/cwd/revision admission, ownership before new/fork/branch publication, and terminal close/drain/release. The normal CLI, root dependencies, installed services and application import path remain unchanged.

Actual native/process verification now has **23 passing checks, zero failures**. The previously failing fork retirement check is fixed by an explicit lifetime spanning actual `AgentSession` preparation and `SessionManager` commit/rollback. Real high-level tests cover gated commit, a forced post-prepare drain failure restoring original native/provider identity, an uncertain rollback retaining both leases, close racing rollback, and a real in-flight bash command receiving the original OS lease until its append finishes. The original owner is never released just because the lower-level destination rewrite returned. Cold persisted-child revival also now checks native identity under the writable lease, derives its current contract after admission and closes the admitted manager after failed setup. Real lifecycle/competing-process checks cover busy rejection without writes, freed admission preserving original ID/history, coalesced requests, park/re-revival, same-path replacement rejection and actual SDK refusal cleanup. The new checks exposed three failures against the previous frozen candidate and pass after these changes.

This closes the bounded fork and persisted cold-factory ownership gaps. New/switch/branch retirement and failure paths, active memory-backend/extension side-effect rollback, full move rollback/concurrency, executor-specific warm/task/advisor revival, initial registry-import identity, final filesystem publication/parent replacement and sidecar identity remain unaccepted. Move needs an owning lifetime through the outer native command/controller rollback and coordination of child session/lock files inside its artifact directory; moving only the parent file leases is insufficient. The native artifact-copy helper still logs/catches failures; complete artifact publication is not claimed. The normal CLI, dependency/package selection and installed services remain unchanged. This candidate does not establish safe original import or decide the normal-command versus app-launcher installation choice.

## Separate candidate24 move experiment

[Candidate24](../patches/omp-18.1.10/candidate24/README.md) extends the native parent move lifetime through `AgentSession`, both outer `CommandController` cwd paths, commit and rollback. Close waits for that lifetime; failed rollback keeps ownership and reports uncertainty. Fresh isolated macOS reproduction passes **11 move checks plus the existing 23 ownership checks, zero failures**. Actual native tests cover competing writers/transitions, completed appends/title changes, draft/ordinary-artifact preservation, a real persistent shell `cd`, and controlled publication/drain failure. Candidate23 and its original failures remain frozen.

This does **not** close the full child-move gap. Candidate24 reserves the artifact namespace and refuses existing active or parked child session trees before mutation. Native registry updates alone cannot repair the cached lifecycle/factory closures that retain old file paths, and retained artifact writers have a separate directory binding. The next native seam must coordinate those refs, park/revival work and artifact writers through relocation; source-directory aliases are not being used to conceal stale paths. No patch is applied to installed dependencies, user sessions/configuration, the normal CLI, or app import admission. The launcher choice remains separate from this isolated correctness work.
