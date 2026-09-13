# Actual App native force acceptance

This runner launches the already-built production Electron App/main/preload with the production host and worker in a disposable HOME, native agent directory, profile and project. A local, auth-free HTTP server supplies controlled OpenAI chat-completions SSE. The actual native request builder, force queue, command dispatcher, journal and `read` tool remain in use. This is **controlled local HTTP acceptance, not vendor/provider proof**, installed-build acceptance, reference parity, cross-device acceptance or independent review.

Do not run until Root confirms the coherent final native patch was clean-installed and the combined typecheck/build passed. Root must also own the native input lease. No install or rebuild is performed by this runner.

From the Root integration checkout, after those gates:

```sh
bun --no-env-file scripts/acceptance/force-tool-app/run.ts .data/force-tool-app-acceptance-001
```

The output directory must be new/empty. An optional third argument is the same explicit surface-conditions JSON accepted by the Fork harness. Default: actual main window 1440×1000, origin 560/180, DPR 2, zoom 1. Different dimensions must be a separately named responsive case. Native CG/AX, display, focus, viewport, theme, yabai and zero-peer checks run before every input/capture. Their existing Fork labels are retained in the reused guard. No reference bundle is read.

For the observed Home display at 1800×1169/DPR 2, use this explicit, separately named responsive conditions file as the third argument. The original fixed case at 560/180 does not fit that display; its failed evidence must remain a setup failure. These bounds end at 1520/1060, preserving the full 1440×1000 native content viewport without emulation or zoom changes:

```json
{"name":"home-responsive-1440x1000-at-80x60","responsive":true,"bounds":{"x":80,"y":60,"width":1440,"height":1000},"viewport":{"width":1440,"height":1000},"dpr":2,"zoom":1}
```

The host initializes and commits only the disposable project with a fixture Git identity and hooks/signing disabled. It verifies the real repository root, HEAD, `main` branch and clean status before host launch. That receipt is retained in `fixture-evidence.json`; no retained repository or configured personal Git identity is changed.

The runner reuses `session-fork-app/surface-guard.cjs` and `geometry.swift`, WindowStateStore/defaultWindowView/createDockState, and the normal production `dist` entrypoints. It adds no renderer bridge or host RPC. The hash fence re-inventories all regular files under maintained `apps/host/src`, `packages/shared/src` and `apps/desktop/src` before and after each run, alongside the declared runner inputs, patches, selected installed native packages and built assets. It skips nested symlinks and `node_modules` directories and detects added/deleted maintained files as well as changed bytes. This is an input inventory fence, not a copied transitive import closure, a clean-install attestation or independent native SDK proof. Private evidence includes actual HTTP bodies, versioned command envelopes/results, native queue snapshots, native journals, inputs and qualified screenshots. Connection bearer data stays in the temporary fixture and is deleted on successful owned-process shutdown.

Input evidence uses two explicit methods. The macOS native tool select uses asynchronous System Events key codes (Space/Home/Down/Return), with a read-only focused-select check, owned Unix PID/frontmost checks before each OS key, surface checks before/after, raw process failure details, and a selected-value postcheck. Other pointer/key/text actions remain qualified Electron `sendInputEvent`/`insertText` input. This mixed method exercises the production App but does not establish an all-OS-input or human-operated physical acceptance claim. No helper assigns the select's DOM value, invokes React callbacks, or silently activates an app.

## Cases

1. Select real active `read` and enter optional text. Verify outside composer click dismisses without focus theft, Escape on reopening restores the trigger, and optional text survives both. Then add `/force read …` to the actual composer without sending. Submit v18 with its prepared epoch/revision guard. Hold the actual named-tool HTTP request and inspect `tool-in-flight`; release a real read call against a unique local nonce; hold the next request and verify actual `tool_choice: "none"`, the real tool result and `final-response-in-flight`; release and require empty native/UI queue plus admitted user history.
2. Prepare and send an arm-only command. Remove its actual pending directive. Drop the already-completed cancel acknowledgement and reload the renderer. Use the App's durable “Check original operation”; require the same command ID, no rearm and no HTTP model request.
3. Use actual New chat and native model catalog to choose the controlled model. Type raw `/force read`, then send through real session creation, live session command-catalog winner resolution and unguarded v18 native submission. Cancel its pending directive in the App.
4. Send `/force read /force-fixture-effect`. The loaded native extension appends one private side-effect line and returns no prompt/user message. Require a real unknown outcome and disabled recovery. The existing pending-send action checks the same command ID; require exactly one side effect and no model request. Cancel the actual remaining directive.
5. Hold only the original force submission after the native `SessionManager.flush()` has returned and its real arm custom entry is verified on disk. While that continuation is held, call the existing real host `session.interrupt` and require acknowledgement before releasing. Let the original ownership check reject before native prompt entry. Require a delivered known armed/not-recorded receipt; preserve newer composer edits and recover through the real App operation. Require the original epoch/directive and model/thinking/approval binding, no new arm or current draft reference, actual user admission, read/none HTTP flow, and preserved current draft.

6. In a dedicated session, invoke the actual loaded extension command `/force-fixture-shadow`, which registers canonical `force` only in that native session. Verify the real catalog reports the extension winner and shadowed builtin, and the actual canonical picker is unavailable. Type `/force:read` with an ordinary optional prompt in the App. Require unguarded v18 builtin admission across the real arm/history await, named `read` and final `none` HTTP flow, durable recorded user receipt, and zero calls to the canonical extension handler. The picker remains truthfully unavailable after alias completion.

## Scheduling hook and unproved boundary

`worker.ts` is a fixture entrypoint which installs a loopback-only fetch guard before importing the SDK and production worker. Its only native method wrapper first **awaits the original flush**, verifies the exact command's actual force entry on disk, then delays that returned promise. It does not append/replace entries, consume/requeue a directive, substitute dispatch, inject an error, create a receipt or alter provider options. The native queue and SessionManager are the original objects.

Case 5 is deliberately strict: if interrupt cannot acknowledge during this hold, or the native result remains unknown, it fails as a **missing deterministic hook** before recovery. Cleanup may release the hold but never counts as acceptance. No timing-only race or forged partial receipt substitutes for this gate. Opaque native FIFO ordering is preserved; the fixture only expects this single owned directive because it starts from an empty isolated session.

The whole App run has not been performed in the initial author packet. Initial evidence is author-only static validation: focused TypeScript (`tsc --ignoreConfig`, ES2023/Bundler/strict/noEmit/skipLibCheck, Bun/React/Vite types) for these TypeScript entrypoints and `node --check main.cjs`. No vendor, native execution or physical acceptance is inferred from those checks.

## Files and teardown

- `run.ts`: source/build hashing, native geometry compiler, production candidate launch and shutdown.
- `fixture.ts` / `host.ts`: private environment, real host, five isolated sessions, native static custom model configuration (`auth: none`) and fixture-only `yolo` approval.
- `provider.ts`: loopback-only HTTP SSE, recorded actual requests, explicitly released responses and strict named/none mapping checks.
- `extension.ts`: actual native local command effects and session-local canonical collision registration; no provider registration.
- `worker.ts`: production worker with pre-import network guard and post-original-flush scheduling hold.
- `main.cjs`: actual App native input, read-only evidence, one lost acknowledgement and the existing real interrupt command.

All outbound fetches in host/worker/main require `http://127.0.0.1`; renderer network requests have the same boundary. Native read targets only the owned project file. A private `tailscale` executable refuses discovery and the real desktop must report zero remote peers. The environment does not inherit account keys, native profiles or dotenv configuration. Fixture shutdown stops the local provider and real host/workers before deleting the private root; failed shutdown retains its root and is reported as failure.
