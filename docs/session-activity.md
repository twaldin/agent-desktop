# Native session activity

`GET /v1/sessions/:id/activity` reads a bounded snapshot from the session's owning OMP worker. The request and successful response carry `X-Agent-Host-Id`; an owner mismatch or missing session is a coded conflict. Desktop compatibility falls back only when an older host returns a plain route-level 404.

Each surface distinguishes a supported empty value from an unavailable or unsupported capability:

- `goal` is the exact native OMP goal identity, objective, status, enabled/mode state, budget, usage, and millisecond timestamps, or `null` when the native session has no goal.
- `jobs` uses `AgentSession.getAsyncJobSnapshot()`. It exposes bounded running/recent job identity, type, status, label, start time, optional agent link, and delivery state. A session without an async job manager reports unavailable rather than an empty list.
- `agents` uses the session's actual `AgentRegistry`. It exposes bounded non-main identity, display name, native status, parent identity, timestamps and activity. `running` is true only when the registry's status is corroborated by a live streaming child session. Session files, history objects and internal arguments remain private.
- `sources` is explicitly unsupported. OMP 18.1.10 has no stable consumed-source registry equivalent to the reference app's conversation-source model. Project files are not substituted for sources.

Worker protocol version 12 carries the same activity in response and event snapshots. The activity RPC flushes native goal usage before projection. Goal, agent and tool lifecycle events are marked as activity invalidations; the selected-conversation observer coalesces them and periodically re-reads the owner-bound snapshot independently of whether the Environment card is open.

The activity endpoint remains read-only; [native goal control and continuation](native-goals.md) use separate ordered operations and tickets. Child navigation and background job cancellation remain separate work. On headless reopen, the host applies OMP's native cold-session reconciliation to the latest branch `mode_change`: a valid paused goal retains its identity, objective, budget, usage and timestamps, while a formerly active goal is paused once through `GoalRuntime.onThreadResumed()` and receives OMP's native `goal_paused` entry. A disabled goal setting or malformed native goal payload is cleared with OMP's `none` mode instead of being reconstructed from transcript text. Completed goals get durable finalization/repair. No hidden continuation prompt is queued by restoration itself.

Shutdown response snapshots retain only the last live activity projection once disposal starts. Native lifecycle fields and snapshot revisions still advance; reading activity from a disposed session would otherwise discard a pending completion response. The existing native steer/disposal regression verifies the cancellation receipt, absence of extra user turns, and final non-streaming/non-post-prompt state.


## Native jobs fixture boundary

The jobs adapter fixture uses the real OMP session, AsyncJobManager, owner delivery sink and yield queue. It holds initial delivery while asserting that inspection is non-consuming, then releases it and verifies consumption of completed, failed and asynchronously formatted large results. Native idle delivery may wake the agent, so a deterministic in-process provider returns a normal terminal assistant response. The fixture still rejects all outbound fetches and asserts zero network calls; this is not real-provider execution evidence.

The previous non-executing model could enter blocked-network retries after a native wake, leaving another delivery pending. That failure was reproduced and traced before changing the fixture. The five-second delivery assertion and thirty-second child-process watchdog remain; no production adapter or SDK code changed.
