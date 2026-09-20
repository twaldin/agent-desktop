# Actual App native background Jobs acceptance

This runner launches the already-built production Electron App/main/preload against the production host and worker in a disposable HOME, native agent directory, profile and project. Every job it shows is a **real detached task child** registered by the original native `task` tool in the original native session; child turns run against a loopback, auth-free OpenAI chat-completions SSE server that the fixture holds and releases per child. This is **controlled loopback acceptance, not vendor/provider proof**, installed-build acceptance, reference parity, physical-device acceptance or independent review.

Do not run until Root confirms the coherent final native patch was clean-installed and the combined typecheck/build passed (`apps/desktop/dist` must exist). No install or rebuild is performed by this runner; the pinned Electron binary must already be installed.

From the Root integration checkout, after those gates:

```sh
bun --no-env-file scripts/acceptance/native-jobs-app/run.ts .data/native-jobs-app-acceptance-001
bun --no-env-file scripts/acceptance/native-jobs-app/run.ts .data/native-jobs-app-acceptance-002 --pause-for-browser
```

The output directory must be new/empty. `--pause-for-browser` is the **same automatic run** with one driver: once the real running+queued state is on screen (`02-running-queued`), the driver shows the hidden window, writes `<output>/pause-ready.json` (Chromium DevTools locator on `127.0.0.1`, plus the resume marker path) and waits. Continue with `touch <output>/resume`; the run then finishes every remaining step unchanged. Electron debug switches (`--remote-debugging-port`, `--remote-debugging-address`) are appended **after** the fixture positional arguments so the driver's argv layout is identical in both modes.

## What is proved

1. Supported-empty native Jobs state through the production EnvironmentCard section, preload, `host:session-jobs` IPC, `session-jobs-transport`, the host `POST /v1/sessions/:id/jobs` route and the worker `nativeJobs` RPC over the ORIGINAL captured native session.
2. Two real detached children (`app-a`, `app-b`) spawned by the original task tool: the first running (its provider turn held open), the second `queued` behind `task.maxConcurrency: 1`.
3. The real **Cancel** control: a guarded request (owner + id/startTime/guard target) that native accepts before the body settles; the row lands in Recent as cancelled with the "request does not confirm settlement" qualification.
4. The real **Inspect** control on the completed child: the retained output is the actual child `yield` payload; the native consumed flag is unchanged by the UI read (verified through the worker control before/after).
5. A child that yields an error settles the original job as failed; its error text is inspectable.
6. Owner loss: a fourth real child stays running while the host restarts **cleanly** on the same host id/port (every original worker retires). The App reconnects; Jobs refuses the original owner with `OWNER_UNAVAILABLE` or `STALE_OWNER`. Other existing App observers can load a replacement worker, but Jobs never silently adopts it. Last known same-owner rows stay visible, labelled stale; the retained running row's Cancel control is disabled.
7. Switching to the other conversation clears state synchronously and shows that conversation's own supported-empty state.
8. Reselecting the original conversation reads a fresh worker whose cold manager is empty — no restoration of lost rows.

Every capture (`01-…` to `08-…`, plus `failure` on error) records the exact final window bounds, content bounds, minimum size, visibility, renderer `innerWidth/innerHeight/devicePixelRatio/visualViewport/CSS zoom`, Electron zoom factor/level and PNG width/height/bytes/sha256 (`<label>.json`). Captures wait for the App's own `/jobs` read to complete, `aria-busy="false"` and two animation frames.

## Files and teardown

- `run.ts`: Electron preflight (direct installed binary), source-hash fence over maintained sources and built assets at both boundaries, disposable root, host child, candidate app, Electron launch, evidence copy, cleanup.
- `host.ts`: `prepareJobsFixture` (loopback provider, short control-socket directory, agent/models/child-agent files), the real host with `jobs-worker.ts` as worker entry, two isolated conversations, and a token-guarded loopback control bridge (`spawnTask`, `awaitReached`, `release`, `fail`, `job`, `waitJob`, `status`, `workers`, `inference`, `restartHost`).
- `main.cjs`: the single driver — real `sendInputEvent` pointer input against the production `SessionJobsPanel` controls, read-only transport observation, captures, optional browser pause.
- `apps/host/src/omp/fixtures/jobs-controlled.ts` / `jobs-worker.ts`: shared fixture and the transparent worker capture (first main `AgentRegistry` registration; no native API replaced).

All outbound fetches in host/worker/main require `http://127.0.0.1`; renderer requests have the same boundary; the worker also refuses `preconnect` and `WebSocket`. A private `tailscale` executable refuses discovery. Shutdown stops the App, sends `stop` to the host (bridge → host → provider/control directory, sequentially), copies only `*.jsonl`/`*.md` native journals into `<output>/native-after-stop`, re-hashes sources, and removes the private root only when everything passed. A failed run or failed cleanup retains the root and writes `retained-fixture.json`; that root holds host/control tokens and a native auth database and must not be published. `ready.json`, profiles and `agent.db` are never copied into the output.
