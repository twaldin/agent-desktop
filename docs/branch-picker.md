# Branch picker ownership and search

The current-checkout picker asks its owning host for presentation data. Idle rows use independently delivered default/current/recent names. Typed search normalizes case and separators, matches every term, lists local tips before remote tips, and deduplicates remote short names. Git tip committer date determines order within each namespace. Full refs and object identities accompany display names; selecting a row or Use sends a fresh `git.resolve-checkout` query and does not infer checkout targets from a truncated list.

`git.search-branches` returns at most20 rows and `limitReached`. This records that the cap was attained, not that an additional match was observed. The previous `hasMore` result field is removed; the current renderer rejects an older response without the new cap contract. Maintained producers and fixtures use the same result shape. Physical mixed-version compatibility remains an acceptance gate; this source cutover is not proof for arbitrary old clients against a new host.

Search reads Git stdout incrementally, decodes complete UTF-8 records, stops the child at the cap and waits for it to close before a remote pass. Parent cancellation, operational errors, timeout and invalid output remain distinct from a successful cap stop. The command uses --no-lazy-fetch and fails closed if Git lacks it, rather than repairing missing promisor objects. Default host timeout applies separately to each namespace; stderr is bounded and incomplete records have a1MiB bound. This is not the old8MiB whole-stdout collection. The helper supports an AbortSignal, but renderer cancellation still invalidates local consumption; sent HTTP/IPC query cancellation is not wired by this change.

The pinned worker's short-lived query cache and conversion of certain command failures into empty rows are not reproduced: owning-host reads are fresh and failures are explicit. Non-HEAD symbolic refs may be displayed and deliberately sent to target resolution; checkout admission's existing symbolic-ref rejection remains a behavior difference to verify, not an inert row.

The commit-destination menu and worktree starting-state picker are separate consumers. Conflict-to-commit continuation, actual React/DOM interaction, native matched appearance, physical connection behavior and installed acceptance remain required. Source tests do not close those gates.

The host distinguishes a checkout blocked by working-tree changes from a generic Git failure. It uses the pinned English checkout header grammar and retains Git display paths (including any quoting); these strings are for display, never later command arguments. Only a numeric exit1 with this diagnostic is classified, after the existing status/identity checks. A failed create that leaves its branch behind remains unknown even when HEAD returns to the source. Timeout, truncated process output and unverified resulting state do not become a commit-continuation signal. This source boundary does not yet carry the structured refusal through command transport or implement the conflict dialog and owner-bound commit continuation.

The ordered command path now projects the typed host refusal into `error.checkoutConflict` and stores it in the existing command journal. The renderer validates the payload against the pending checkout command, publishes `checkoutRefusal` only after its local acknowledgement succeeds, and retains the original pending ID when acknowledgement fails. A response lost after host settlement is checked using that same ID. This is a current workspace-state signal; a completed refusal is not a persisted continuation in the renderer cache, and neither its presence nor reopening a workspace authorizes a checkout. Conflict-dialog lifetime, retained-action persistence and explicit successful-commit continuation remain separate required work.

### Blocked checkout and commit continuation

A current picker hands its confirmed `GIT_CHECKOUT_BLOCKED` receipt and original
checkout action to the App-owned conflict dialog. The menu closes without taking
focus back from that modal. Ordinary errors and uncertain checkout deliveries do
not produce this continuation. Explicit original-ID retry can reveal the same
confirmed refusal later. The conflict form uses the pinned feature-dialog text,
400px/92vw shell, sections and primary action; it opens the existing OMP-backed
commit workflow rather than staging or committing when the conflict is displayed.

The continuation retains the owning WorkspaceState and admitted commit command
ID. Only that host/workspace/ID's successful receipt with an actual commit can
continue. A read refresh must still report that exact commit at HEAD; the next
checkout keeps the original destination identity and updates only the source
revision. A moved target therefore fails the normal host check. Pending, unknown,
failed, cancelled, push-only and foreign receipts never authorize checkout.
Closing a working dialog hides it while its original observer remains; leaving
its owner or entering settings/plugins cancels further admission. A controller
connection loss latches invalidation even if reconnection is batched before React
renders. Already-admitted native work is not cancelled or replayed by these gates.
`mutateCommand` exposes the admitted ID and checks its admission predicate after
restore; existing boolean `mutate` callers keep their interface.

This continuation is current-window state, not a durable automatic follow-up.
The underlying original command recovery remains durable, but a process restart
requires deliberate inspection and a new branch action. Native dialog focus,
animation, geometry/material/pixel parity and the pinned per-file/fallback diff
statistics remain unaccepted. The initial conflict body displays supplied paths
without decoding them into Git arguments; optional diff statistics require their
own authoritative producer and are not reconstructed from cached renderer views.

Selection handlers belong to a committed menu/query lifetime, not merely a tuple
of current values. Closing and reopening, or changing A → B → A, retires the
previous Use/Enter/row handlers even when the tuple is identical again. Admission
checks that render token before obtaining a fresh request attempt or controller
generation. Ordinary redraws retain it. A controller-observed connection pulse
without an intervening render still allows the current handler to obtain the new
connection generation; it does not revive a handler from an older rendered menu.

`git.review-summary` is a read-only owning-host query for staged or unstaged
review changes. Unstaged includes untracked files; neither source is the net
commit selection. Per-path rename identities and nullable binary/unmerged counts
allow the conflict dialog to follow the reference's two-source statistics without
summing cached renderer diffs. Host counts support its separate
`max(stagedCount, unstagedCount) + untrackedCount` file-count rule.

The query checks repository ownership and HEAD/index/status shape before and
after reading. It does not lock external editors or promise a transaction snapshot
of working bytes. Untracked embedded repositories and unsupported file types fail
explicitly, rather than returning partial totals. Query failures are unavailable,
not zero changes. Renderer consumption, live refresh and matched native diff-stat
appearance remain required; this host seam alone does not close those gates.

The conflict description now consumes both host review summaries through a
separate dialog-owned read controller. It sums staged and unstaged activity,
normalizes refusal display paths like the pinned helper, and matches either side
of renames. A missing path has no invented count; binary/unmerged null counts use
the reference's zero contribution. The fallback file count comes from the host
counts, never the renderer's cached status-entry length.

The controller refreshes every two seconds while mounted and on a new status
object. One pair runs at a time; retries and reconnection queue behind outstanding
IPC. Owner unmount, connection loss/return and status replacement invalidate old
results. Both sources must validate and agree on index revision/status counts;
loading and failure remain visible instead of fabricated zero totals. This is
an app polling adaptation, not the reference worker's live-query subscription.
Read errors do not gate the separate explicit commit flow. Source tests and SSR
prove only their named controlled boundaries; actual React/IPC, default colors,
font geometry, live refresh and native dialog appearance/animation remain open.

The conflict dialog's portal content now measures an inner natural-height body,
matching the pinned dialog helper's ResizeObserver/frame lifecycle. The padded
form stays inside that measured body. Measurements coalesce per frame, ignore
changes below half a pixel, and enable the ready marker on the next frame; close
removes observer/frame/style state. The existing viewport cap remains in place.

Correction to earlier animation wording: the pinned helper sets a height variable
and ready marker, but the extracted shipped styles contain no matching marker or
height-variable rule. No animation duration/easing is established by that source.
This implementation mirrors measurement and adds no invented transition timing.
Actual portal measurement, resize/scroll behavior and native motion/appearance
still require verification once the launch hold is lifted.

### Worktree starting-state draft retention

The starting-state selector is separate from the checkout picker above. Reopening
a worktree draft now loads its branch inventory and retains an authored starting
state while Git status and branch results arrive independently. An empty or failed
catalog, a removed branch, or a now-clean working tree does not rewrite that
choice. Existing Send eligibility still requires a usable starting state, and the
host validates it when creating the worktree. Switching projects retains the
existing fallback initialization; choosing Local avoids the additional catalog
read. These changes do not alter draft command/revision persistence.

Pinned `ato` clears the auto-default snapshot when the user selects a state; `oto`
retains explicit choices rather than validating them against the dropdown list.
Our previous same-project validation effect could replace a saved non-current
branch with the current branch before any inventory response. The corrected
component regression reproduces that overwrite before the fix and preserves the
same selection after it. Effects and asynchronous reads are controlled in this
check, not mounted React or physical restart evidence.

The reference's default-snapshot tracking, default/current/recent branch ordering,
300ms starting-state search, remote-ref selection and submission-time starting-ref
resolution remain separate required work. Loading the existing local inventory
does not establish that full picker contract or native appearance.
