# Native same-session context reset

Clear context calls the pinned native `AgentSession.resetSessionContext()` on the original session. It does not create a new desktop conversation, fork a branch, delete history, or send a prompt to a provider.

## Native behavior

A successful reset retains the native SessionManager session ID and file, existing history entries, selected model, thinking level and session settings. It appends a native `reset_boundary`, empties the live model context, and rotates the provider session identity. Reopening the same session file and rebuilding context honor that boundary; pre-reset messages do not return to the model context through an ordinary rebuild or `/shake`.

History still contains the earlier messages and branches. Reset is not deletion or redaction. Native shake can subsequently transform retained historical content; the reset guarantee is that rebuilding does not silently revive the pre-reset model context.

`NativeSessionTree` requires an `onProviderSessionChanged` port before admitting reset. Runtime supplies the existing `applyFreshProviderIdentity` callback, which rebinds Jobs, Todos, Plan and Usage and resets the runtime plan epoch. The callback runs whenever the native provider identity changed, including when the reset throws after partial effects.

A recovered Tree edit draft is retired at a reset boundary. The older native recovery marker remains in history; it cannot automatically recover an obsolete pre-reset edit after reopening.

## Admission and outcome

The request carries the original native session, Tree epoch and revision. Admission checks repeat after preparation. A stale ticket, replaced owner, Stop during preparation, busy host, active native eval/bash/stream, or missing identity-rebind port refuses the operation before native reset effects.

Slash `/clear` includes `origin: "clear-command"`. After preparation, the adapter checks that the current exact `/clear` command still resolves to the native built-in. An extension or custom command winner must not be bypassed by the slash route. Explicit History Clear context omits `origin` and deliberately does not depend on slash-command ownership.

Native reset can clear live state and rotate provider identity before it appends a boundary. Therefore, once the native reset call has started, an exception is an unknown outcome even if the journal appears unchanged. A later boundary/flush failure is also unknown. The original Tree owner enters reconciliation, identity-dependent controllers are rebound when necessary, and the command must not be replayed. Only a known pre-effect native refusal can become a no-effect rejection.

Success requires the original manager ID/file to remain current and its journal flush to complete. Unknown outcomes retain the original command for inspection rather than reporting success or rolling back native effects.

## Wire compatibility and recovery

Existing Tree reads, mutation results and receipt shapes remain unchanged. Navigation and labeling remain command version 23. The targetless reset mutation uses command version 25:

```ts
{ action: "reset-context", origin?: "clear-command" }
```

Reset rejects `targetId`, navigation options, labels and unknown origins. The separate `tree.resetContext` capability advertises `{ version: 1, commandVersion: 25 }`; old Tree support alone does not enable reset.

Renderer state derives the command version from the mutation and validates that same action/version pair when restoring a saved command. A saved navigation remains version 23; a saved reset remains version 25. Missing current reset support blocks new resets but does not block inspecting an existing receipt. Corrupt or mismatched recovery bytes remain intact and block new mutations.

A proven unsupported reset endpoint refusal (`TREE_RESET_PROTOCOL_UNSUPPORTED`) is not submitted. Lost responses instead preserve the original command ID and inspect its receipt. Receipt recovery never resends the mutation, and a late result cannot replace a newer authoritative Tree read.

## Renderer and App ownership

`SessionTreeHistory.onResetContext` requests the owner-controlled confirmation. The button requires a loaded, supported and settled Tree. `SessionTreeResetContext` is presentation only: it accepts busy/disabled/error state and close/confirm callbacks. It does not capture an owner, acquire a Tree ticket, mutate history or consume a draft.

App owns the immutable original route, owner, Tree ticket and draft identity; invalidation remains sticky. Slash confirmation consumes only the matching original draft after confirmed success. Cancel retains the draft. History confirmation does not consume the composer draft. These guards belong to the App integration, not the reusable dialog.

## Verification scope

The focused owned run covers 42 tests / 159 Bun expectations, including 19 child-process native Tree scenarios and the existing Tree-edit recovery regressions. The native fixtures use the pinned SDK and real SessionManager journal, isolated home/auth storage, blocked network access and a controlled in-process stream. They exercise:

- identity/history/model/settings retention, provider identity rotation, durable reopen, empty live/rebuilt context and native shake;
- Jobs/Todos/Plan rebinding and stale-owner rejection, plus Usage's local owner/admission guard without provider usage or credit requests;
- stale/retired/missing-port refusals, Stop and actual native eval/bash/stream admission;
- native `/clear` and an extension shadow installed during preparation, with explicit History reset still available;
- exceptions before the reset boundary and during its flush, preserving unknown outcomes and preventing replay;
- recovered-edit retirement at a durable reset boundary.

The direct native reset/reopen/shake fixture also passes outside the test runner with zero blocked fetch attempts. A separate composition with the Root-owned protocol/transport files passes `tsc --noEmit`; those integration files are not part of the owned source handoff.

Root separately reports passing actual StrictMode App + authenticated host + production worker proof: slash confirmation without premature dispatch, Cancel retaining draft and restoring focus, exactly one command25/native boundary, History preserving the `/tree` draft, and reload without replay. Root also reports original command25 receipt deduplication before and after a cold host restart with exactly one boundary and no extra provider call. These are Root-run integration results, not additional Work app launches.

First failures are retained in the external evidence packet: an incorrect native shake image-count assumption and three test-only TypeScript inference errors. Repairs remove the unrelated image-count assertion, preserve literal mutation types and narrow parsed recovery fields. The owned native adapter and renderer component bytes are unchanged from the source used by Root's App proof. Renderer component tests are semantic probes, not visual proof; no independent review or additional live-provider testing is claimed here.

The combined integration suite passes 94 tests across nine files. Root also exercises the final App in a single hidden Electron candidate with disposable host and worker state: cancel returns focus to the original composer, confirmed reset preserves history, History reset leaves composer text alone, and reload does not repeat a reset. The separate host check repeats the original command before and after a host restart and receives the same receipt with only one native boundary. These checks use synthetic input and a loopback fixture; they do not establish physical keyboard, live provider, reference appearance or whole-app parity.
