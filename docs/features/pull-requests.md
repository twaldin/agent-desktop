# Pull Requests

The sidebar opens a host-owned GitHub inbox with All, Reviewing and Authored views, relationship groups, qualified search, status/repository filters, and a persistent selected pull request. The detail presents the description, checks, discussion and changed-file diffs. Closing and reopening retains the window's selection and filters; document reload restores those preferences through the actual window store. Cached read results are window-local and expire after ten minutes.

## Reference and source contract

This flow follows pinned Codex 26.901.41600 build 7982: `pull-request-route-b688ff525335.js`, its detail model/query/comment/action modules, and the native GitHub handlers in `src-VqXTPopo.js`. The `Har`/`Wkt` query rules distinguish unquoted GitHub qualifiers from prose; `Uar` prioritizes direct review requests, team requests, previously reviewed and authored rows, without duplicates. The original pull-request and filter glyph geometries are retained. The application themes and host/account selectors adapt these controls to multiple execution hosts; this source work does not certify exact screenshot parity.

The bounded acceptance contract for this change is:

1. Use the selected host's existing native GitHub CLI accounts. Never invent an authenticated account or persist a credential in renderer/window state. A missing CLI, unavailable account, offline host or operational error stays visible with a deliberate retry.
2. Bind every read to the original selected host/account and every detail continuation to its original pull request and head/base/update revision. Refuse foreign responses, stale revisions and repeated cursors; preserve readable earlier pages on failure. A closed/replaced page cannot publish a late response into a new presentation.
3. Preserve pinned relationship ordering, query qualifier behavior and pagination. A partial relationship error does not erase successful sections or claim authoritative emptiness. Load-more requests extend only requested sections. Show an explicit notice when upstream nested comments or changed-file limits truncate content.
4. Expose real descriptions, checks, activity and file patches. Existing diff rendering supports unified/split and collapse. Re-selecting the already selected row preserves its detail without a redundant read. External GitHub actions use the existing safe external-link bridge.
5. Persist only window presentation and selection. Cached content must match the restored account/query/target on the first offline render. Reopening a page cannot grant a cached account live read authority: fresh account confirmation is required.
6. Integrate the actual App sidebar, overlay ownership, close/focus behavior and save/reload path. Other content overlays retire the page and its pending publications. Existing browser, Files, MCP, Automation and session behavior remains intact.
7. Bound command output, request/response bodies and accumulated display pages. Cancellation/shutdown retires commands and drains their pipes. Failed launch cannot leave a deadline timer, and operational data or credentials must not leak through error messages.

## Implementation and evidence

The host runs the actual `gh` executable with an in-memory credential for the selected native account and confirms that account before API reads. The executable identity is captured and checked. API requests are read-only. Search cursors encode account/filter/section; detail cursors bind an original revision. Files are read from the REST endpoint, then the head/base/update identity is rechecked. Strict shared parsers are applied at host, main and preload boundaries. The authenticated host route and desktop response owner header preserve execution-host identity.

Controlled service tests exercise account discovery, query/relationship behavior, detail and partial failures, revision loss and shutdown. Actual local subprocess tests cover bounded pipe draining and input. Desktop tests use authenticated disposable HTTP, actual transport/preload parsing and a temporary WindowStateStore. The page Electron harness uses trusted Chromium input and captures offline cache, errors/retry, retired reads, filters, selected detail and diffs. A separate full-App harness uses the actual authenticated host, SQLite, native CLI reader and a private deterministic `gh` executable; it verifies sidebar/overlay ownership, detail/files, window reload and close/reopen. This is controlled CLI data, not a live account or provider test. Separate read-only checks against a real configured GitHub CLI validate a public pull request.

## Remaining parity work

This milestone completes the read inbox/detail flow. Comment submission, reviews, merge/checkout/Fix actions, chat association, complete nested-thread pagination, cross-window durable result history, additional native account/authentication workflows and final pinned pixel/OS interaction parity remain required work. No disabled or inert controls stand in for those features. It does not approve a provider mutation, private repository access beyond the selected account, installed-artifact behavior, physical Home/Work parity or the whole project goal.
