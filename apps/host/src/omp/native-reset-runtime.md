# OMP native reset owner lifecycle

`NativeResetRuntimeOwners` owns one pinned root and the live or retiring children of that root. The bound of 128 includes the root, factory reservations, live children and children still draining or cleaning up. Completed child history consumes no slots. Binding identity is the exact `AgentSession` object, not its session or registry ID; cold revival with the same ID creates a different owner. A second factory invocation for the same object is refused.

The first binding must contain the original root Settings, ModelRegistry and AuthStorage. Children retain the root's borrowed Settings writer and must be internally exact for their own SDK session objects. Factory identity and capacity are reserved before lifecycle registration or owner creation can synchronously reenter. A failed first/root creation cannot promote a later child to root.

## Exact native retirement

The SDK binding supplies `registerLifecycle({ beginClose, drained })`:

- `beginClose` runs synchronously when that exact native session begins terminal disposal. The host locally fences admission and cancels only that owner's held decision before the native drain can wait on it.
- `drained` follows the unbounded native reset drain: prestarted report/provider IO, owned pass bodies, post-reset refresh, completion callbacks and the awaited final checkpoint. Empty host callback tracking or return from the SDK's bounded `dispose()` is not equivalent.

The group registers before invoking the owner factory. Child retirement then joins any wrapper callbacks still resolving, calls local retirement, and removes the child from capacity only after cleanup settles. Factory setup failure still fences and drains the exact constructed session. If lifecycle registration itself throws, the failure path calls that session's native `beginDispose()` and unbounded `drainCodexResetPolicy()` directly; a rejected drain does not fabricate terminal notification or release capacity.

Late or repeated native lifecycle notifications are idempotent. A callback already tracked before native drain is joined; a new callback after the exact `drained` notification is rejected before it can reach a disposed owner or a revived replacement. Requesting whole-group finish does not reject factual callbacks that prestarted native work still owes.

## Local resources versus shared transport

`NativeResetRuntimeOwner` has two distinct operations for each lifetime:

| Lifetime | Fence | Cleanup |
| --- | --- | --- |
| One child session | `beginSessionClose()` | `retireSession()` |
| Whole root/worker | `beginClose()` | `finish()` |

`NativeResetChannelOwner.beginSessionClose()` permanently fences captured pass authority and aborts only its registered decision signals. Its original factual completion and final-checkpoint obligations remain valid. `retireSession()` disposes stranded local contexts once, preserves failures, and never closes or finishes `ResetPolicyChannel`. It must be called only after native drain and wrapper callback quiescence.

Only the pinned root calls whole-owner `beginClose()` / `finish()`. Group shutdown fences every owner before waiting, begins native disposal for every exact session, joins every native drain and local child retirement, then invokes root finish once. A child cleanup failure cannot skip another sibling or close shared transport underneath it. Errors are retained in group accounting instead of being thrown from an SDK notification and lost in its logger. Accounting keeps the first 128 diagnostics plus the total failure count, so failed historical churn does not create an unbounded error list. Raw thrown values, including `undefined`, remain failures.

Policy callback rejection still reaches the original native caller and settlement path. The wrapper does not additionally classify every policy refusal as a cleanup failure: an intentionally refused, unadmitted pass during recovery must not invent a terminal resource-cleanup error. Failures retained by the local owner, including context cleanup failures, still reach group accounting through retirement or whole-owner finish.

Retirement and group-finish promises are published before outward cleanup, making synchronous reentry observe the same operation. There is no timer, guessed exit, registry-parking inference, worker-loss notification, or replacement epoch in this path.

## Recovery tracking

Worker entry retains the pinned root and a set of live/retiring children. The native channel owner's optional `onRetired` callback removes a child only after local cleanup attempts settle, including failed cleanup; the group separately retains those failures for terminal shutdown. Recovery quiescence joins native drain and the local retirement completion for already-disposed children. A child beginning disposal after the quiescence acknowledgement is not resumed, while root and live siblings can resume normally. Original epoch, authenticated endpoint identity and durable reconciliation rules are unchanged.

## Decision UI and ownership

Decision UI delegates through the original root `OmpInteractionBridge`, including `runWithSignal`, and fails while that bridge is unavailable. No child close cancels unrelated UI. Durable host policy authority, Store/lease shutdown and worker-loss/exit accounting remain outside this helper.

The focused suite distinguishes controlled lifecycle/capacity peers, actual SDK sessions and actual original-worker reconnect. External provider traffic and account/credit actions are not acceptance evidence. SDK lifecycle and recovery prerequisites are frozen separately; their reviews do not approve this retirement implementation.
