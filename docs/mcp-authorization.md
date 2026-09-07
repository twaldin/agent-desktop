# Native MCP authorization

The authorization foundation uses the app-owned OMP18.1.10 runtime and the session's native `AuthStorage`. It does not use a global OMP executable, create a second account store, or change the provider/broker ownership contract. The session/worker lifecycle bridge is implemented; authenticated host routing and desktop authorization controls are still pending; `/mcp reauth` must remain unavailable until that path is connected.

## Private authorization material

`mcp-oauth-plan.ts` performs a temporary native HTTP/SSE initialization with managed OAuth injection disabled, then uses native error analysis and OAuth metadata discovery. Explicitly configured headers retain OMP's behavior. A successful anonymous initialization does not establish that tools are public: metadata discovery still runs, and a tool-level challenge is honored. Stdio authentication belongs to its child process and is rejected before starting that process.

The plan contains resolved client credentials and must stay inside the owning worker. Client selection follows the pinned reauth controller: configured client, persisted client, stored client, then a metadata client only when dynamic client registration is unavailable. A secret is paired only with its matching client. Environment placeholders are expanded for execution but retained verbatim for configuration write-back. Definition-only servers use the native profile-and-URL credential binding and need no configuration write.

`mcp-oauth-flow.ts` runs actual `MCPOAuthFlow`: PKCE, state validation, dynamic registration, native callback listener and manual redirect handling. It forwards callbacks through the existing `NativeLogin` shape and never opens a browser automatically. Returned tokens, refresh material, registered client secrets and URL-derived credential IDs stay private. Snapshots may expose the authorization URL while consent is pending; entered redirect/code values remain write-only.

Cancellation before credential storage preserves the previous grant. A completed storage write remains authoritative if cancellation arrives during that write. The stored native OAuth row contains its refresh endpoint, client pair, resource and authorization endpoint so the native local store or configured broker can refresh it without copying secrets into project configuration. The adapter does not delete superseded credentials or claim a successful server reconnection merely because token exchange succeeded.

Discovery carries a60-second abort deadline; the native flow has a5-minute deadline. Native header command substitutions have no caller-abort API and are awaited; cancellation prevents further adapter work after they settle. The session controller retains ownership while that work is pending. Native reload/connection work is drained after it starts; the existing worker shutdown bound remains necessary when native work cannot be interrupted.

## Pinned compatibility fixes

The repository's existing OMP patch also carries the authorization repairs. These are explicit source changes to18.1.10, not an upstream version upgrade:

- HTTP/SSE failures retain bounded raw authentication hints in an error-identity `WeakMap`, read only through an explicit internal getter. Ordinary messages, JSON serialization and tool diagnostics keep token redaction. This prevents the diagnostic sanitizer from erasing `resource_metadata` when it follows `Bearer`, and preserves exact URL/query identity for discovery without publishing it in an error.
- Initial, cached and refreshed tool registrations forward the authentication challenge to the native manager's reconnect handler. The native tool bridge can then perform its existing single retry after successful authorization.
- Caller cancellation reaches the legacy SSE handshake, including when native timeouts are disabled.

The patch remains subject to focused native tests and frozen-install verification. Ordinary transport retry policies, provider approvals and the existing browser patch are not replaced.

## Session and worker lifecycle

`NativeSessionMcp.startAuthorization` reserves the existing session MCP mutation queue and consumes the observed manager revision. One active authorization belongs to that controller. Callback responses carry its exact authorization/request identity, resolve once, and remain in memory; worker replacement cannot accept an older identity. Worker protocol21 exposes start, inspect, respond and cancel operations. Polling the active operation returns its existing callback state without starting another login.

The session runtime blocks competing prompts, model/account changes and MCP reloads while authorization owns the mutation. It exposes pending native work for Stop, cancels authorization before abort/disposal waits, and drains the MCP queue before closing the native session and credential store. Queued MCP operations reject after disposal. Observer failures cannot orphan the callback or poison the queue.

`mcp-oauth-config.ts` captures native user/project/standalone source precedence and raw bytes. It rejects malformed/non-regular/symlink owners, preserves placeholders and unrelated settings, and uses the native file locks and atomic writer. A second identical-byte commit cannot reuse the captured target. File/source ownership is checked before native credential storage and again before configuration commit. Cancellation while waiting for locks prevents the file write. As with native advisory locks, another process that ignores the locks is outside the transaction guarantee.

The snapshot separates credential-write outcome (`not-started`, `unknown`, `stored`), configuration outcome, and actual reconnection. A store acknowledgement failure must not claim that an old grant survived; a successful store followed by cancellation must not claim completed configuration/reconnection. A started file write without a confirmed result is likewise unknown. Definition-only entries preserve their configuration bytes and use OMP's profile/URL credential binding. Explicit authorization reloads through the native manager, waits for its connection, and refreshes actual native tools before reporting connected. Superseded legacy rows are currently retained; collection requires its own reference/ownership check and is not credited as complete.

Actual local tests cover callback and config races, native file-lock contention, malformed owners, partial outcomes, real worker Stop/disposal, admission fences and replacement-worker identity rejection. The worker fixture allows only its exact local issuer and callback origins. No hosted-provider request, desktop/host HTTP control, installed artifact or pixel evidence is implied.

## Remaining integration

Authenticated host routing must keep submitted codes/redirects out of durable command journals, deduplicate start commands, and fence host/session identity. Desktop reconnection must inspect an existing flow instead of replaying it. Cross-client resolution at that HTTP boundary, broker refresh and the consent UI remain unverified.

Explicit reauth and native tool challenges should share this controller. The latter must preserve the native blocked tool lifetime and interactive consent; `setAuthHandler` supplies no cancellation signal, so cancelling the tool alone does not cancel the underlying callback. The app must own that lifetime explicitly. Provider/tool approvals remain interactive and separate from detached questions.

The UI will reuse the account callback presentation and the reference connection surface. Callback URLs refer to the owning host; remote authorization needs clear manual-redirect handling. Cross-client resolution, config conflicts, refresh through a configured broker, installed artifacts, real external-provider consent and matched visual states need their own acceptance evidence. Local issuer tests do not establish those gates.
