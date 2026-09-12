# Worktree starting-state intent

Starting state distinguishes a local branch/revision label from an explicit remote
namespace. Branch intent may carry `remoteRef` as a literal `refs/remotes/...`
reference. The label is preserved independently; serializers never infer remote
identity from it. Local two-field branch and working-tree inputs stay compatible.
Exact remote identity participates in captured draft equality.

A remote intent in a draft, conflict attempt, command history or host-owned
preparation raises the SQLite downgrade floor to schema18 in the same transaction.
The existing device policy is preserved before the floor changes. Clearing the
choice does not lower the floor. Existing hosts supporting only schema17 must
refuse reopening that data. Preparation storage uses the shared strict parser.

Remote intent is stored before its admitted preparation may resolve or fetch.
`/v12/commands` preserves the exact namespace. Older endpoints reject incoming remote
fields and stored-remote draft writes/consumption; preparation resume also requires
v12 when its original record carries a remote ref. The client selects v12 for
explicit remote inputs or an explicit v12 marker and never retries an older route.
A bare missing-endpoint404 is a definite rejection; coded404, authorization and
transport failures retain their existing error/uncertainty semantics.

Remote creation must supply a saved draft, worktree and explicit environment
selection (including null) so it uses EnvironmentSessions and the durable creation
consumer. The internal environment envelope remains normalized to version5, with
its exact saved-draft equality checks. The direct creator still refuses remoteRef.
The state advertises startingRefs.commandVersion12 alongside the existing v4
worktree capability. Renderer draft saves use v12 for a remote snapshot or base.
The local draft cache retains that requirement after a remote save may have reached
the host, including a lost reply followed by a Local clear. This marker is not
removed on clearing the choice. Existing local flows retain their older protocols.
The transport cannot infer an absent field's saved history.

Submission creation and prompt/steer use v12 from the captured remote draft. Remote
preparation resume uses v12 from that same capture; local resumes remain v5. Cached
create, input and resume envelopes must match the captured protocol exactly.
Unknown retries retain the original ID, namespace, draft revision and environment,
regardless of newer editor choices. Controller tests use in-memory cache/command
doubles, not actual disk, IPC or native worktrees. The remote picker is implemented as a separately reviewed source consumer; its mounted and native gates remain open. App checks the owning host's
advertised remote support and environment execution before fresh remote submission,
and rechecks the current owning-host record after awaiting the saved draft. Remote
starting refs do not have to masquerade as local branch entries. Existing project,
workspace, busy, environment selection and conflict gates still apply.

A new preparation continuation uses the original captured draft for availability,
not the current editor choice. An existing sent envelope can still be checked with
its original v12 ID; no older-route fallback is introduced. The preparation card
shows the incompatibility and disables new continuation while retaining read-only
status, output and cancellation controls. App handler/expression and static-render
fixtures are controlled source evidence, not mounted React, native or IPC proof.
Mounted App/native integration and picker behavior remain required.

The pinned starting-ref sequence is distinct from checkout: upstream divergence,
cached remote candidates, conditional remote lookup/fetch, revision fallback, and
creation-time refresh for an explicit remoteRef. Effectful resolution belongs to
admitted preparation rather than menu loading. The private primary trace records
exact pinned source and controlled branching evidence. Mounted UI, actual remote
creation, installed/native and physical acceptance remain open under the launch hold.

## Resolver implementation boundary

The host service now contains the starting-ref resolver and creation-stage refresh
as internal methods, absent from all read-only workspace query routes. The worktree
preparation lifecycle consumes them only after storing its worktree-creating phase.
Public commands use the v12 preparation gate; direct creation retains its remote
guard. Renderer controller versioning is implemented separately; picker and App capability cutover are separately implemented source scopes, without mounted/native approval.

Resolution checks HEAD/@, upstream divergence (remote only when strictly ahead),
local identity, all cached candidates, then remote lookup/fetch and revision fallback.
Creation refreshes an explicit remoteRef against the longest configured remote-name
prefix. Configured origin retains first priority; remaining order comes from Git.
The existing Git runner supplies per-command timeout/output limits and now accepts
cancellation. Cancellation before fetch is rejected; errors after dispatch are
OUTCOME_UNKNOWN, with no alternate fetch or creation fallback. The preparation consumer retains that
uncertainty under the original identity across reobservation and store reopen.

Deliberate owner-side differences from pinned cached worker queries: literal refs
must exist in the exact namespace before commit peeling (no shadow-tag DWIM), local
reads disable promisor lazy fetch, malformed remote branch candidates skip remote
lookup, operational lookup failures propagate, and a removed explicit remote fails
REMOTE_CHANGED instead of using a stale supplied ref. This service performs fresh
queries, not the native query-cache lifetime. No configured remote/auth/hooks are
changed. Counts compare resolved commit IDs; later creation still resolves its own
commit. No atomic repository snapshot or prevention of external ref/config changes
is claimed. These choices require integration/native acceptance along with the
renderer cutover.

## Durable preparation consumer

The lifecycle stores worktree-creating before resolving a starting state or adding
a checkout. HostWorkspaces reads the original record by ID and revision, derives
the destination from that ID, and checks the saved host, project, source and phase.
The service resolves from the saved starting state inside its existing per-repository
serialization. Checks before and after resolver Git calls retain the admitted owner
and source/destination directory identities. Worktree creation must use the exact
recorded destination. Cancellation is passed to Git; it cannot authorize a fallback.

Errors in this admitted stage preserve an unknown worktree-create outcome, even if
only fetch refs/objects changed and no worktree exists. Existing IDs are inspection
only on reobservation; continuation permits validated preparations but refuses
unknown or already-creating ones. A saved validated record can resume using its
original starting state and destination. No new native session is part of this step.

Temporary Git/SQLite tests cover remote refresh, real fetch receipt loss, in-process
store close/reopen, owner loss, parent replacement, cancellation, and nested dirty
snapshots. They do not prove physical process restart, public command admission,
live v12 transport, provider/native execution or UI behavior. Directory and project
checks are observations, not an atomic filesystem transaction or a global fence
against external Git/config changes. Materialization keeps its existing worktree
configuration behavior, including enabling extensions.worktreeConfig when needed.

## Starting-state search

The read-only `git.search-starting-branches` query retains each remote's exact ref
and uses its remote-qualified display name. It shares the pinned normalized term
matching, tip-date ordering and combined 20-result cap with checkout presentation.
Matching local names still suppress same-short-name remote rows; two distinct
remotes survive when no matching local name was returned. Checkout search retains
its existing short-name collapse. Neither query resolves a starting state or fetches.

A distinct query kind prevents an older host silently ignoring a new preservation
flag. Project/session ownership is rechecked after the read. Native remote glob
prefiltering is retained; the result is a bounded presentation inventory, not an
exhaustive exact-ref lookup. Git errors remain explicit and local reads prohibit
promisor lazy fetch. The renderer picker consumes this query separately; its source integration does
not acquire native approval from disposable Git or controlled catalog tests.

## Open picker source integration

The composer starting-state menu now shows local file state, the remote-backed base
branch, local branches, and typed remote results. Base means the first discovered
remote default, not the current branch upstream or push destination. A dedicated
read returns its remote/local pair; existing default naming still adds the bounded
local fallback. Starting inventory reuses that base read and recent heads, avoiding
a duplicate default-discovery request. Remote discovery may contact configured
remotes through the existing remote-show path; selecting a row never fetches or
checks out anything.

Idle names retain default/current/saved-if-known/recent order, using the saved
branch (or main for local file state) when current branch data is absent. Typed search waits
300 ms and uses the remote-preserving query; current-checkout search stays200 ms.
The menu keeps its288px shell and200px list. Remote rows save full refs with
qualified names; the base row keeps its local name plus exact remote ref. Search
response identity is validated before it can become a draft choice.

One committed menu/query lifetime owns each handler. Close, replacement, query
changes, status changes and observed connection loss invalidate prior rows; a
connection return cannot revive them. Search reads remain serialized, and modified
Enter uses the same selection decision while composition and pending queries are
protected. Selection preserves existing draft mutation ownership and does not
resolve a revision or dispatch a checkout.

Controlled hook/handler tests and compiled App acceptance fixtures are not actual
React reconciliation, DOM default actions, focus, native or pixel acceptance.
The open-menu integration and the following label/lifetime change are separate
source scopes; neither completes the starting-state parity gate.

## Closed label and retained inventory

The composer retains its starting-state base/recent query owner after the first
explicit picker open. Closing ends typed search and selection handlers but allows
an in-flight base/recent reply and later observed Git revision/connection updates
to refresh the closed label. Reopening refreshes the inventory. Workspace replacement,
leaving worktree mode, capability loss and unmount stop its reads; an unopened
replacement project does not acquire the previous project's first-open permission.
This uses the existing owner subscription and Git-status refresh path. Native
repository-watch delivery, including ref-only changes without a status revision,
remains separate required work and is not established by this owner lifetime.

The local-file-state chip shows the authoritative current branch followed by
`(current)`, falling back through the picker default/current/recent ordering to
`main`. A branch intent shows its authored branch name; it uses a qualified base
name only when both the saved branch and remote ref match the returned base pair.
Label refresh does not rewrite the saved intent. Source/controlled validation
remains separate from mounted UI and native acceptance under the launch hold.


## Workspace-event invalidation

Matching owning-host workspace events now invalidate branch reads independently
of the HEAD/index revision used to admit Git mutations. Both active search and
retained inventory observe the event before refreshing status; a ref-only change
can therefore refresh names/base results even when status returns the same revision.
Already-sent replies lose their generation and only one latest replacement read is
admitted after they settle. Pending checkout resolution also loses admission.
Ordinary editor/cache notifications and unrelated host/workspace events do not
advance this signal. It is transient renderer invalidation, not a persisted Git
revision or a mutation-admission token.

This consumes the existing host event route. Producing those events from external
filesystem/ref changes still requires the separate owning-host watcher and its
subscription/identity/cleanup bridge; no native watcher or transport execution is
established by the controlled event-consumer tests.


A saved remote intent may remain in the closed label even when branch inventory
is unavailable. Its label alone never creates a Local branches row: the same name
must also occur in current/default/recent local data or a returned local search
result. Otherwise no synthetic local candidate is offered, and neither row click
nor Enter can discard the saved remote ref. A discovered remote row retains its
exact ref; a genuinely same-spelled local branch remains a separate local choice.
This corrects the unknown-remote fallback row, not the historical source verdicts.
