# Native MCP authorization

The authorization foundation uses the app-owned OMP18.1.10 runtime and the session's native `AuthStorage`. It does not use a global OMP executable, create a second account store, or change the provider/broker ownership contract. The desktop authorization controls and worker lifecycle bridge are still pending; `/mcp reauth` must remain unavailable until that path is connected.

## Private authorization material

`mcp-oauth-plan.ts` performs a temporary native HTTP/SSE initialization with managed OAuth injection disabled, then uses native error analysis and OAuth metadata discovery. Explicitly configured headers retain OMP's behavior. A successful anonymous initialization does not establish that tools are public: metadata discovery still runs, and a tool-level challenge is honored. Stdio authentication belongs to its child process and is rejected before starting that process.

The plan contains resolved client credentials and must stay inside the owning worker. Client selection follows the pinned reauth controller: configured client, persisted client, stored client, then a metadata client only when dynamic client registration is unavailable. A secret is paired only with its matching client. Environment placeholders are expanded for execution but retained verbatim for configuration write-back. Definition-only servers use the native profile-and-URL credential binding and need no configuration write.

`mcp-oauth-flow.ts` runs actual `MCPOAuthFlow`: PKCE, state validation, dynamic registration, native callback listener and manual redirect handling. It forwards callbacks through the existing `NativeLogin` shape and never opens a browser automatically. Returned tokens, refresh material, registered client secrets and URL-derived credential IDs stay private. Snapshots may expose the authorization URL while consent is pending; entered redirect/code values remain write-only.

Cancellation before credential storage preserves the previous grant. A completed storage write remains authoritative if cancellation arrives during that write. The stored native OAuth row contains its refresh endpoint, client pair, resource and authorization endpoint so the native local store or configured broker can refresh it without copying secrets into project configuration. The adapter does not delete superseded credentials or claim a successful server reconnection merely because token exchange succeeded.

Discovery carries a60-second abort deadline; the native flow has a5-minute deadline. Native header command substitutions have no caller-abort API and are awaited; cancellation prevents further adapter work after they settle. A worker-level controller must retain ownership while that work is pending, and the existing worker shutdown bound remains necessary.

## Pinned compatibility fixes

The repository's existing OMP patch also carries the authorization repairs. These are explicit source changes to18.1.10, not an upstream version upgrade:

- HTTP/SSE failures retain bounded raw authentication hints in an error-identity `WeakMap`, read only through an explicit internal getter. Ordinary messages, JSON serialization and tool diagnostics keep token redaction. This prevents the diagnostic sanitizer from erasing `resource_metadata` when it follows `Bearer`, and preserves exact URL/query identity for discovery without publishing it in an error.
- Initial, cached and refreshed tool registrations forward the authentication challenge to the native manager's reconnect handler. The native tool bridge can then perform its existing single retry after successful authorization.
- Caller cancellation reaches the legacy SSE handshake, including when native timeouts are disabled.

The patch remains subject to focused native tests and frozen-install verification. Ordinary transport retry policies, provider approvals and the existing browser patch are not replaced.

## Remaining integration

The session-owned controller must bind authorization to the selected server, manager generation and configuration revision. It must reject overlapping login ownership, cancel and drain on Stop/disposal, and prevent an answer from another host/session from completing the flow. A disconnected desktop must be able to inspect the pending interaction again without starting another flow.

After the real storage receipt, configuration write-back must compare the original source under the existing native file-lock/CAS boundary. Only after that commit should a superseded managed credential be collected. Credential storage, configuration persistence and reconnection are separate outcomes: a failure after storage cannot be reported as if no authorization occurred or blindly replayed.

Explicit reauth and native tool challenges should share this controller. The latter must preserve the native blocked tool lifetime and interactive consent; `setAuthHandler` supplies no cancellation signal, so cancelling the tool alone does not cancel the underlying callback. The app must own that lifetime explicitly. Provider/tool approvals remain interactive and separate from detached questions.

The UI will reuse the account callback presentation and the reference connection surface. Callback URLs refer to the owning host; remote authorization needs clear manual-redirect handling. Cross-client resolution, config conflicts, refresh through a configured broker, installed artifacts, real external-provider consent and matched visual states need their own acceptance evidence. Local issuer tests do not establish those gates.
