# Native MCP authorization

The authorization foundation uses the app-owned OMP18.1.10 runtime and the session's native `AuthStorage`. It does not use a global OMP executable, create a second account store, or change the provider/broker ownership contract. The session/worker lifecycle, authenticated host routing and explicit desktop Authenticate action are implemented. Native slash-command reauth and automatic tool-challenge integration remain pending; those paths must not imply that opening settings executed authorization.

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

`NativeSessionMcp.startAuthorization` reserves the existing session MCP mutation queue and consumes the observed manager revision. One active authorization belongs to that controller. Callback responses carry its exact authorization/request identity, resolve once, and remain in memory; worker replacement cannot accept an older identity. Worker protocol22 exposes start, inspect, respond and cancel operations. Polling the active operation returns its existing callback state without starting another login.

The session runtime blocks competing prompts, model/account changes and MCP reloads while authorization owns the mutation. It exposes pending native work for Stop, cancels authorization before abort/disposal waits, and drains the MCP queue before closing the native session and credential store. Queued MCP operations reject after disposal. Observer failures cannot orphan the callback or poison the queue.

`mcp-oauth-config.ts` captures native user/project/standalone source precedence and raw bytes. It rejects malformed/non-regular/symlink owners, preserves placeholders and unrelated settings, and uses the native file locks and atomic writer. A second identical-byte commit cannot reuse the captured target. File/source ownership is checked before native credential storage and again before configuration commit. Cancellation while waiting for locks prevents the file write. As with native advisory locks, another process that ignores the locks is outside the transaction guarantee.

The snapshot separates credential-write outcome (`not-started`, `unknown`, `stored`), configuration outcome, and actual reconnection. A store acknowledgement failure must not claim that an old grant survived; a successful store followed by cancellation must not claim completed configuration/reconnection. A started file write without a confirmed result is likewise unknown. Definition-only entries preserve their configuration bytes and use OMP's profile/URL credential binding. Explicit authorization reloads through the native manager, waits for its connection, and refreshes actual native tools before reporting connected. Superseded legacy rows are currently retained; collection requires its own reference/ownership check and is not credited as complete.

Actual local tests cover callback and config races, native file-lock contention, malformed owners, partial outcomes, real worker Stop/disposal, admission fences and replacement-worker identity rejection. The worker fixture allows only its exact local issuer and callback origins. These lifecycle tests alone imply no hosted-provider, installed-artifact or pixel evidence. The separate HTTP and rendered-control checks below cover their named boundaries.

## Authenticated routing and desktop consent

`session.mcp.authorize` is an exact-owner durable start command containing only the server and observed manager ticket. Its receipt stores the authorization identity, never the authorization URL or callback answer. The live snapshot carries that start command ID so a lost receipt can be correlated with the original flow. Pending receipts remain unknown after a host restart; inspecting them never loads a worker or starts another login.

The owner-fenced authorization GET preserves the start receipt even if its worker is unavailable. Separate authenticated POST routes accept exact authorization/prompt identities for write-only responses and cancellation, with bounded bodies and no-store replies. Native prompt resolution admits one answer across clients. A transport failure or invalid post-mutation response is an unknown outcome, not permission to replay the answer.

Live MCP settings advertises Authenticate only for enabled native HTTP/SSE configurations and compatible desktop bridges. The renderer reuses the account callback form, opens the issuer URL only on an explicit click, and shows credential-write, configuration and reconnection outcomes separately. It persists opaque start/response identities before dispatch; private callback values never enter local storage or the host command journal. Read-only polling survives reopening and navigation; stale responses cannot replace the new view. A response with an unconfirmed outcome stays disabled while the same prompt remains pending. Cancel remains explicit. A missing or damaged local receipt blocks new writes rather than silently losing deduplication.

Actual local HTTP tests cover concurrent duplicate starts/answers, receipt-write failure and host restart without replay. A hidden Electron run exercises the real renderer and production transport through a fixture IPC adapter into the actual authenticated host and native OAuth worker: one start, one callback, one token exchange, actual reconnection, narrow layout and reopen without replay. The fixture replaces only the issuer browser consent with an exact local callback; it does not test a hosted provider. The first run exposed use of the host-only loopback launcher; the sign-in action now uses the issuer URL, suitable for a client on another machine. Private captures and receipts are in `.data/mcp-authorization-ui-source30-3/` and `.data/mcp-authorization-desktop-checkpoint/`. The fixture IPC adapter does not prove the full installed desktop IPC/packaging path or native-window/pixel parity.

## Remaining integration

Explicit native slash-command reauth and native tool challenges should share this controller. The latter must preserve the native blocked tool lifetime and interactive consent; `setAuthHandler` supplies no cancellation signal, so cancelling the tool alone does not cancel the underlying callback. The app must own that lifetime explicitly. Provider/tool approvals remain interactive and separate from detached questions.

Cross-device UI resolution, broker refresh, installed artifacts, real external-provider consent, cancellation/error visual states and matched reference geometry remain separate acceptance gates. The frozen reference marks MCP OAuth Authenticate as an uncaptured fixture frontier; current captures do not establish one-to-one appearance for that missing reference state. Local issuer tests do not establish those gates.
