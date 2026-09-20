# Native `/session pin`: actual App acceptance

This runner exercises native `/session pin` through the production App, preload, host and worker. It uses private profiles and synthetic credentials; it does not patch the SDK or add desktop account-selection or persistence semantics.

## Command and persistence boundary

- `/session pin` lists the current session model provider's stored OAuth accounts. `list` is **not** a special subcommand: `/session pin list` is an exact selector named `list`.
- `/session pin <selector>` uses the full native remainder: 1-based native account position, `active`, or an exact case-insensitive native label/email/account ID/project ID/enterprise URL/org ID/org name/`OAuth credential #N`. Multiword identities are not split into a desktop-specific grammar. Native parsing owns whitespace and verb normalization; the desktop does not create a registry.
- Duplicate, unknown, absent-account and absent-model selectors produce native factual output rather than invented successes. A consumed native command can clear its draft even when its output refuses the selection; this is distinct from a transport/admission failure.
- A successful pin command changes **live session auth**, not the session journal's saved credential pin. Saved command output is not a saved account preference. A successful assistant turn records `credential_pin`; cold adoption uses that native account identity hash and the native routing freshness rules when no current auth sticky exists. Local auth storage may itself retain its sticky choice across restart: do not infer that a command-only choice must disappear on immediate restart. This fixture checks no journal pin entry before the first turn, the serving account/hash afterward, then cold reopens the **same** session and checks the next actual provider payload.
- Cold selection after the successful turn is checked with both auth cache and journal intact. It proves that the original session uses the expected account and payload, **not** that the journal alone caused restoration. No auth-cache clearing or persistence adaptation is introduced.
- The companion native fixture separately distinguishes auth-cache restoration from journal restoration: a command changes the cached choice without changing the saved journal pin, an immediate cold reopen retains that cached choice, and the existing public release operation removes the auth sticky before a separate cold reopen proves journal-based restoration.
- Existing explicit account buttons use `createNativeAccountSelectionBridge`, which records and flushes at click time. They are not the command's persistence semantics. Release clears the live choice; a saved preference may return on resume.
- `/session delete` and other identity-changing branches remain pending. No deletion, automatic session replacement, broader identity transition, or global active-account feature is introduced.

## Launch after source freeze

From the repository root, using Bun 1.3.14, Node 22.12 or later, and the locked Electron 44.2.0 package:

```sh
bun install --frozen-lockfile --backend copy
node node_modules/electron/install.js
bun scripts/build.ts
bun --no-env-file scripts/acceptance/session-pin-app/run.ts .data/session-pin-app-proof-001
```

Electron 44.2.0 has no postinstall hook. Its explicit installer downloads the pinned public runtime artifact and verifies the package's bundled checksums; a package-only install is not sufficient. This dependency setup is separate from acceptance and does not access provider accounts.

The runner does **not** build/install. It refuses a nonempty output directory, locates the already-installed Electron executable without invoking its installer, and launches it directly with the copied `main.cjs` wrapper and symlinked production `dist`. `dist/main.cjs`, the real preload, real `App`, `startHost`, and the shared production-entry worker remain the execution path. No fake renderer bridge is installed.

The host calls `prepareSessionPinFixture(privateRoot)` exactly once. The shared helper owns the synthetic accounts, full sanitized worker environment, guarded canonical-provider-to-loopback routing and SSE server. No real provider/OAuth login, quota, registry duplication, or provider token is needed. The child receives an allowlisted environment rather than ambient credentials; HOME, agent, host data and Electron userData live under a private temporary root. Tailnet discovery is explicitly refused. App and host network fetches are loopback-only; the shared worker supplies its own canonical request guard.

`ready.json` stays mode 0600 under the private root and includes the local host connection (including its **local transport secret**, never a provider token), session/model owners and a monotonically increasing host generation. Startup/restart is bounded at 60 seconds, each automated Electron phase at 180 seconds, shutdown at 15 seconds. `operator.json` in the private output directory identifies that root and owner PID without copying the connection secret. Never publish `ready.json`, auth databases or private profiles.

The live phase sends native list, position, active, multiword organization, case-insensitive exact identity, duplicate and unknown selectors through the actual composer. It reopens the existing account popup and presses **Refresh accounts**, checks independent sessions, submits an obsolete guard via the real preload (not a stale DOM click), checks a pending delete's retained draft and a draft model's account-owner explanation, then sends a real controlled assistant turn. The runner closes Electron, fully stops the host/workers and starts a new host runtime while retaining only the controlled provider server. The cold phase launches a new Electron process/profile instance onto the original session and sends another real turn. No reseeding or synthetic session replacement occurs.

## Interactive Electron/browser inspection

For one browser observation on the **same automated run**, use:

```sh
bun --no-env-file scripts/acceptance/session-pin-app/run.ts .data/session-pin-app-proof-001 --pause-for-browser
```

After the real App/preload and original route are ready, the live driver writes mode-0600 `browser-pause.json` and waits up to five minutes before issuing any input. Read its `debugging` path for the ephemeral CDP port, attach with `browser.open` as below, run `observe()` and `screenshot()` only, then release that browser attachment with `browser.close({name:'native-session-pin'})`. Create the empty marker file at the exact `resumeFile` path in `browser-pause.json` using the harness Write tool. The paused driver resumes the original live/cold scenario in the same owning Electron, with no duplicate manual run. The live process ceiling becomes eight minutes; cold remains three minutes. Never create the marker before releasing browser control.

Use a distinct output directory:

```sh
bun --no-env-file scripts/acceptance/session-pin-app/run.ts .data/session-pin-app-manual-001 --manual
```

This launches the same production App without the automatic driver, with loopback CDP on an ephemeral port and a 15-minute ceiling. Read `operator.json` and `manual-ready.json`; read the first line of the indicated `profile/DevToolsActivePort` file locally to obtain the port. Attach only to this owned Electron instance, for example with the harness:

```js
const pinAppTab = await browser.open({ name: 'native-session-pin', app: { cdp_url: 'http://127.0.0.1:<port-from-private-DevToolsActivePort>' } });
await pinAppTab.observe();
await pinAppTab.fill('#prompt', '/session pin'); // use type/keyboard if the editor rejects fill
await pinAppTab.click('.send-button');
await pinAppTab.screenshot();
```

Do not open a separate web page with a fabricated backend: there is no standalone browser fixture. Browser control attaches to the actual Electron renderer and real preload. Keep one driver in charge; never attach while the automatic phase drives input. Quit the owned Electron window to drain the host. Manual mode does not write a passing acceptance result, automatically cold reopen, or remove its private root; use the automatic run for the reproducible two-phase proof. The exact direct binary/candidate paths are in `operator.json`; prefer the runner so environment isolation and shutdown remain owned.

## Evidence and limits

Retain `live-result.json`, `cold-result.json`, `*-native.jsonl`, `provider-requests.jsonl`, `owner.json`, `cleanup.json`, and `live-*.png` / `cold-*.png`. Results record actual receipts, safe account projections, request identity/payload and document state. Each capture records actual window bounds, content bounds, minimum size, renderer inner width/height, DPR, visual/CSS zoom, Electron zoom factor/level, and PNG pixel dimensions. Requested dimensions are not geometry evidence. Account captures wait for error-free refresh completion; final assistant captures wait for the sequence-specific response to render and the stop control to disappear.

Provider headers/tokens never enter these projections. Logs stay in the private output directory. On failure the private fixture is retained for diagnosis; remove only the recorded temporary root after draining and saving nonsecret evidence. Successful automated completion removes it. Preserve earlier run directories and their qualifications; never replace old captures with later images.

`host-errors.json` and `run-errors.json` retain original error names, messages, stacks, nested causes and aggregate errors together with every observed cleanup failure. Diagnostic serialization explicitly redacts the shared fixture's synthetic access JWT/refresh-token formats, bearer values and known local transport secrets. Both host and provider drains are attempted even after a primary failure; runner cleanup records rather than replaces that primary error. A drain/evidence failure exits nonzero and cannot produce a successful overall `cleanup.json` receipt. These files remain private evidence, not a generic-only error message.

Captures use Electron `capturePage` and inputs use `sendInputEvent`/`insertText`; this is not physical OS keyboard/mouse, CG/AX geometry validation, production vendor/auth acceptance, or independent review. Stale-selection proof is a genuine preload/API refusal, not an artificially delayed UI response. Account refresh is explicit refresh/reopen, not a claim that already-mounted idle account views automatically refresh after a native command. Draft model ownership is checked without sending that alternative model to any provider. Native busy/no-model/no-account/read/output/flush/dead-owner faults and extension/custom shadow precedence belong to the native fixture and Main's focused gates, not this App scenario. Immediate restart before an assistant turn is not claimed to persist a command-only choice.

