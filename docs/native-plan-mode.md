# Native Plan mode

Plan mode uses OMP's native Plan lifecycle. It is separate from the session permission mode: enabling or leaving Plan mode does not change approval settings, and changing permissions does not approve a plan.

The native `/plan` command toggles the mode. `/plan-review` opens the latest proposal when one exists. After a successful native Plan-file write, the host records the proposal, pauses the planning turn without blocking the worker event loop, and presents the saved artifact for review. The review is tied to its native session, file reference, revision and worker epoch. Reads and mutations use those captured identities rather than a client-supplied path.

The app provides an embedded editor for the complete proposal. A current review can be edited, dismissed, reopened, refined, saved, or approved:

- **Keep context** leaves Plan mode and executes the approved proposal in the current context when native context limits allow it.
- **Compact first** uses OMP's native compaction path, preserving its cancelled, failed and uncertain outcomes before execution.
- **Fresh conversation** uses OMP's native new-session result, copies the supported local artifacts, binds the exact replacement session and environment, then executes only after the replacement is reopened.
- **Refine** sends native refinement feedback. Empty feedback follows the native close-and-return-to-planning branch without inventing a prompt.
- **Save** writes through the native resolver and starts the native replacement conversation only when that transition is confirmed.

Native compaction failure preserves OMP's best-effort behavior: execution may proceed with the original context and Plan model, and the selected execution role is not applied on that branch. The receipt and review UI retain the failed compaction outcome and error instead of presenting an unqualified success. Successful or cancelled compaction follows the native model transition; cancelled compaction does not dispatch the approval prompt.

Plan-mode exit and native session replacement are separate effects. Cancelling a fresh-session transition after approval still leaves Plan mode exited and the review closed; saving can also have written the destination before that cancellation. Receipts expose those effects independently, retain unknown outcomes, and do not claim that the whole current session is unchanged. Older receipts without these fields remain readable without inventing the missing effects.

Approval and nonempty refinement create a durable native execution phase before prompt admission. The host claims that phase before entering the synthetic native message and settles it as entered, known not entered, or unknown. It does not infer success from text, reconstruct a native prompt in the client, or replay a dispatching phase after restart.

## Recovery and transport

Command protocol 19 carries the existing Plan state, review operations, decisions and typed receipts. Native document mutations require command protocol 20 and an advertised `plan.document` capability; existing Plan commands remain compatible with protocol 19. Worker protocol 60 carries section reads as well as the existing Plan operations. The ordinary host command journal owns command deduplication. Decision records are also keyed by the original command ID, so a later review action cannot overwrite an earlier execution continuation or its receipt.

When native admission is definitively not entered, the Plan response exposes a `ready` execution continuation even if the review or worker is not currently loaded. An explicit `session.plan.execution.retry` command must name the exact execution owner, origin session, original decision and latest attempt. The host atomically reserves that attempt before opening a worker or starting effects, reopens only the recorded native session/file/cwd binding, and starts the original phase without repeating approval, compaction, fresh-session creation or saving. Each retry has its own journal receipt; it never overwrites the original decision result.

Pending, entered, unknown and stale continuations cannot retry. A pending attempt whose command is no longer active is reported as unknown after restart. Transport loss, worker replacement, owner mismatch and uncertain native effects remain unknown and are never converted into replay permission.

## Evidence boundary

The embedded proposal editor and controlled runtime paths are implemented. Focused controlled tests cover native toggles, proposal capture, review revisions, decision branches, execution admission, durable retry ownership and worker restart behavior. The production App gate is still pending.

External-editor behavior, native App acceptance of annotations and the proposal outline, native TUI equivalence, physical-device behavior, reference appearance and retained-runtime acceptance remain incomplete. Current source and controlled tests do not establish independent review, release acceptance or complete parity.

The captured Codex transcript Plan card, environment Plan row and inline implementation/refinement prompt also remain presentation work. The current review dialog provides the native OMP decision controls; it does not establish those reference surfaces as matched.

## Native document review

The review exposes the original native Plan document's outline, rendered sections, section and line annotations, section deletion, and undo. OMP owns section and row identities, rendered line context, annotation realignment, and feedback composition. The desktop never derives an annotation target from its Markdown preview or source-editor offsets.

Section reads name the captured session ticket, review revision, document revision, section, and rendering width. They use an existing worker only and do not create, reopen, mutate, or retry a session. A replaced worker, bridge, document, rendering width, or owner invalidates an outstanding read. The desktop uses native rendered rows at the advertised width and paginates only their display; oversized native projections are refused visibly without truncating the saved Plan.

Every document mutation checks the original document revision. Native preparation creates an isolated next state; the host writes changed artifact content before adopting it. Annotation-only mutations still advance the document revision and Plan ticket. Failed preparation or writes preserve the original owner; effects that cannot be confirmed stay unknown. Markdown edits must be saved or discarded before document actions can proceed.

Deleting a heading removes its native section and descendants after confirmation. Undo restores the native document state. Refinement combines native annotation feedback with the user's additional feedback through the native helper. Direct dismiss/reopen keeps the same in-memory document owner and undo state. Empty refinement returns to planning and retains detached annotation state for the exact original resolved reference, to be realigned if that reference is proposed again. This does not establish annotation durability across worker or host restart.

Document commands use the existing durable command journal and renderer recovery record. A lost response is reconciled by reading the original command; the desktop never resends an annotation, deletion, or undo automatically. Unsubmitted annotation text remains copyable across refresh and conflict. These are implemented source behaviors with focused controlled tests; the complete document workflow still requires independent review and native App acceptance.

## Configured external editor

A ready Plan review can open the owning worker’s native `VISUAL`/`EDITOR` command in a real terminal pane. The same flow can write a native section or rendered-line annotation. The worker validates the original review, artifact and document before preparing content; successful editor output returns through the native Plan mutation against that original ticket. A changed document produces an unknown/conflict result with retained output, rather than replacing the newer plan.

The host records the request and reserves a terminal UUID before launch. Repeated requests inspect their existing job; changed input with the same UUID is refused. Other clients can list saved jobs, and restarting a host does not replay an editor or a Plan write. Unresolved original processes still occupy admission capacity until their exact pane is confirmed stopped. The desktop saves requests before dispatch, so a lost reply can be checked without sending the edit again.

“Open editor terminal” uses the existing dock terminal. Hiding the Plan panel or changing conversations does not terminate the editor. “Cancel original editor” joins original termination. Recovery reads only the saved output for that job and offers copying; it does not automatically apply an old edit. Known results remain durable, and failed result storage retains an unknown outcome. Session deletion does not remove authenticated status/cancel/recovery access to its original host records.

The fixed helper uses the pinned public OMP external-editor utility. It inherits the captured worker cwd and environment, with terminal transport variables (`TERM`, `TERMINFO`, `COLORTERM`) and private job temporary directories (`TMPDIR`, `TMP`, `TEMP`) owned by the terminal/helper. The latter allow verified cancellation to remove native temporary copies without scanning shared temporary storage. Editor commands, environment values and private paths are not sent through the desktop bridge. Edited recovery text remains subject to the Plan transport size bound.

Host schema 26 records editor jobs, while package compatibility includes schemas 1–26. Worker protocol 61 adds private preparation and capability reads. These are independent from the Plan decision command journal and do not approve execution, create a replacement session or alter native account configuration. Controlled state, IPC, SQLite and real tmux tests have separate scopes; packaged-helper and native App acceptance must be recorded explicitly before claiming those flows verified.
