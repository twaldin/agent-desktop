# Shared native automatic / manual reset admission acceptance

This is authored acceptance, not App command integration, independent review, or full parity approval. The checkout composition is public `bf17bf044b0b778057c8d52d5ec4886b2a39710e` plus exact retirement patch `8a6eaea7cdc2ba35344feb0c03b057044f8a2f8fbc8fcf59f8befe215a405549`. Later Root integration and shutdown-correction commits are not substituted.

## Run

From the repository root:

```sh
bun run test apps/host/src/omp-workers/shared-native-manual-admission.test.ts
```

Set `SHARED_RESET_EVIDENCE` to a private output directory to preserve each subprocess's inputs, SQLite stores, complete trace, raw HTTP request/response bodies and process output before its disposable directory is removed. These stores contain only generated synthetic credentials. The fixture's final stdout line is the complete result JSON; each scenario also writes `result.json` and `trace.jsonl`.

For a direct program smoke, invoke `fixtures/shared-native-manual-admission.ts <disposable-root> <scenario>` with Bun `--no-env-file`, `HOME` and `TMPDIR` set to that root, and `PI_CODING_AGENT_DIR=<root>/agent`. Use a clean environment as the test runner does. No retained profile is an input.

## Real components and controlled seams

Two actual `WorkerRuntime` sessions use the actual production worker entry. One drives native automatic policy, the other is the desktop manual service's original worker. They share **one** `HostStore`, `ResetAccountAdmissions`, `NativeResetPolicy` and account collision key. Each worker has an isolated temporary SDK profile with the same generated account, credential payload, credit identity and provider timestamps.

Two workers are necessary for the decision races: a pending native question makes the same session's manual usage API fail its readiness check. Testing only that refusal would not demonstrate shared account admission.

The native route is real `AgentSession` inference through the pinned Codex SSE transport. A controlled HTTP 429 reaches the native message/retry pipeline, which creates the blocked automatic policy pass. Real session bindings, pass contexts, `NativeResetChannelOwner`, worker/host channels and `NativeResetPolicyWorkerOwner` carry its requests. Neither `agent.streamFn` nor reset-policy callbacks are replaced; no pass, plan, account evidence, permit or completion is fabricated.

The SDK normalizes account API URLs to the Codex endpoint. A fail-closed fetch relay permits only exact canonical routes with the generated bearer/account headers, then sends the actual HTTP request to a `127.0.0.1` server. All other fetches and all WebSocket construction are refused. Native eager preconnect is also refused before IO and remains visible in evidence. The fixture's `escaped` counter counts denied attempts, not successful egress; the only permitted denials in successful runs are the separately counted preconnects.

Usage/credit response bytes are captured when the request arrives, before a hold is released. The two loopback views deliberately need not observe each other's reset immediately. Thus safety must come from shared admission, not merely from removing a credit from the losing worker's provider response. Credits expire outside the salvage horizon so that incidental background checks do not turn this into an expiring-credit scenario.

Manual prepare/confirm uses real `SessionUsageService` and worker-side `NativeSessionUsage`, surrounded by real `HostStore.claimCommand` / `finishCommand`. The small fixture dispatcher does not implement App parsing, HTTP routing or App command presentation. The held manual checkpoint is the service's public `existing()` await **after** the durable account claim and dispatch marker, **before** `redeemUsageReset`; it does not fake a successful database write or hold a synchronous SQLite transaction.

The native read gate is armed while acknowledging the actual blocked pass's `started` checkpoint. It does not accidentally hold a pre-prompt account read. Decision holds are actual desktop interaction-bridge questions, answered through `WorkerSession.respondInteraction`.

## Scenarios

| Scenario | Observable contract |
| --- | --- |
| `native-read-first` | Native report read is held before the manual claim. Manual wins once; the original native plan is durably invalidated. Original manual confirmation and receipt remain. |
| `checkpoint-first-read` | Manual claim is held before native entry/read. Native cannot dispatch; manual consumes once after release. |
| `native-decision-first` | Native's real decision is displayed before the manual claim. Its later Yes cannot displace the manual winner. |
| `checkpoint-first-decision` | Manual claim is held before native's real decision. Yes cannot authorize a second consume. |
| `native-admission-first` | Native claims and dispatches one held consume. The pre-existing manual confirmation is rejected, not rebound. Original account, credit and redeem-request IDs remain inspectable. |
| `native-consume-failure` | A controlled transport rejection occurs after loopback consume dispatch. The original automatic attempt remains UNKNOWN; manual cannot take over. |
| `manual-checkpoint-failure` | Host failure after the durable manual claim, before provider dispatch, retains the original conservative UNKNOWN receipt and fences native admission. Zero consumes. |
| `manual-consume-failure` | An ambiguous HTTP success body after manual dispatch retains UNKNOWN. Native cannot replace the original operation. |
| `cancelled-child-retirement` | Manual cancellation stays attached to its original confirmation. A real child is disposed while its native read is held; after its drain, the original sibling redeems once and the original root completes a real native response. |
| `original-worker-recovery` | Clean handoff begins with the original native consume held. After release, the original SDK session reaches idle; authenticated recovery keeps PID, epoch and root identity. No admission/redemption replay; original manual rejection remains. |

All scenarios inspect original command receipts and attempt records, repeat the original command, and assert at most one dispatched consume across both workers. The checkpoint-failure case dispatches none. Successful fixture completion also requires both actual worker PIDs to be gone after teardown.

## Operational errors are retained, not relabelled as clean cleanup

Two scenarios intentionally finish with a reported shutdown diagnostic:

- Read-first revision invalidation: `NativeResetPolicy.plan()` commits `closed.reason = invalidated`, then throws the original revision refusal. `NativeResetChannelOwner.checkpoint()` retains that operational rejection and later reports it again from retirement/finish.
- Child disposal during a held read: the original close fence rejects the later authority checkpoint. The SDK records that checkpoint failure, the native pass finishes failed with no child admission, and whole-worker finish retains the same rejection.

The evidence preserves the original failure, nested shutdown `AggregateError`, and confirmed worker exit. Tests correlate the reported diagnostic to the original refusal and separately verify receipt/admission safety and root/sibling usability. They do **not** claim clean shutdown or erase the failed runs. A future change to diagnostic classification belongs to the production owner, not these fixtures.

The initial recovery attempt also remains in private evidence: takeover was correctly refused while the original SDK retry still had work. A detached host RPC is not proof that its native session is idle. The final fixture awaits that original session's public `waitForIdle()` before takeover; no timeout or fabricated terminal signal substitutes for it.

## Limits

- Controlled loopback responses and synthetic OAuth only; no real account, token, credit spending, official Codex UI, browser profile or retained state.
- No App, session-usage production, SDK patch, CI or capability changes. Root owns native `/usage` parsing and actual App integration separately.
- The manual command dispatcher is not the App transport. These tests add shared native/manual competition, not another manual-only App acceptance run.
- Recovery uses a real retained worker endpoint without creating or touching a browser tab. It does not recreate a worker, ticket or admission.
- There is no public conversion from a recovered `WorkerClient` into a `WorkerSession`. New manual ticket creation after recovery is not claimed. Original cached receipt inspection and command replay are exercised without contacting a replacement worker.
- No hard host-crash acceptance is claimed by the new recovery scenario; prior frozen recovery evidence remains separate.
- Retirement's independent PASS/PASS does not carry to this new authored batch. Public release CI status and Root's later shutdown correction remain separate evidence.
