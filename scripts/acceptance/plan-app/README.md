# Actual App native Plan acceptance

This runner uses the built production Electron main/preload/renderer, real host and worker, and pinned native Plan controller, tools, artifacts and journal. An auth-free, loopback-only HTTP fixture supplies controlled chat-completions SSE that requests real `write` calls to `local://plan.md` and `xd://propose`. It does not create native receipts, substitute a host bridge, or write the plan artifact itself.

The initial author packet was static-only; Root runs 001/002 retain their original launch/failure evidence. For a subsequent run, Root must first confirm coherent native installation, typecheck and build, hold the inventoried sources, and own the native input lease. Then, from the integration checkout:

```sh
bun --no-env-file scripts/acceptance/plan-app/run.ts .data/plan-app-acceptance-001
```

Before host or surface launch, the runner reads installed Electron `path.txt`, verifies its executable is an executable regular file inside the installed `dist`, and records its hash. It launches that binary directly. Missing installation fails as a prerequisite; Electron's CLI auto-download path is never invoked. Earlier run 001 used that CLI and downloaded the binary; this correction does not rewrite or erase that evidence.

Use a fresh output directory. An optional third argument supplies the Fork harness surface-conditions JSON. The default is the explicitly named responsive Home case `home-responsive-1440x1000-at-80x60`: actual bounds x80/y60/1440×1000, viewport 1440×1000, DPR 2 and zoom 1. The running yabai executable must be on the runner PATH; no executable is installed or started by this harness. Reused `session-fork-app/geometry.swift` and `surface-guard.cjs` verify actual CG/AX bounds, viewport, display, focus, theme, yabai and zero remote peers before input/capture. No reference bundle is read.

Before shared surface acquisition, a ten-second read-only registration check binds the original CG window/PID and retries only yabai's exact missing-window response for that ID. Replacement or unrelated errors fail. The candidate requests application activation once during initial acquisition; subsequent focus loss remains a terminal guard failure, with no automatic refocus or input replay. Reserve an uninterrupted native-input window for this run. Attempts 003 (registration) and 004/005 (foreground ownership) remain separate failed evidence.

Six authored happy-path cases run across four isolated native sessions:

1. Configured native startup Plan mode, actual active → paused → off → active controls without provider requests, then a real user prompt, local artifact write and proposal tool result.
2. Embedded Pierre editor keyboard input, actual v19 edit/save, native file content and refreshed Markdown preview.
3. Keep-context approval, actual native synthetic developer admission, original session identity and preserved unsent composer draft.
4. Fresh-context approval, actual destination catalog binding and App navigation, native developer admission and preserved original draft.
5. Nonempty refinement admitted as a native user message, followed by real rewritten artifact and proposal.
6. Save to an explicit path in the private owning project, actual committed new session and App navigation, without a provider execution request.

These cases use the supplied native default execution role; they do not manipulate a native select menu. All pointer, key and text inputs are explicitly qualified Electron `sendInputEvent`/`insertText`, with read-only DOM targeting and trusted pointer delivery observation. No DOM value assignment, React callback invocation or hidden focus/activation is used. The prior Force harness's System Events select helper is not needed or claimed here. This is controlled local HTTP functional acceptance, not vendor/provider proof, all-OS or human-operated physical acceptance, installed-build acceptance, cross-device acceptance, reference parity or independent review. The reference Plan card/environment row/inline prompt layout remains unmatched; a successful dialog flow cannot waive that gap.

Opening review accepts an already-visible actual dialog, including one auto-opened during the surface checks. The final hit-test rechecks that specific completion condition; every other pointer target retains its obscuration guard. Failed target diagnostics preserve the intended element, hit element, focus and dialog rectangles. Proposal checkpoints preserve computed dialog geometry, primary foreground/background and resolved `--app-surface`/`--text`; identical foreground/background fails as unreadable. These are read-only observations, not style mutations or a complete contrast/parity audit. Run 002's stale-trigger failure remains preserved separately.

Still unimplemented here: compact approval, empty-feedback Continue planning, unknown/transport-loss and explicit no-entry retry, multiple execution-role selection, command alias/shadow collisions and cross-device acceptance. A six-case pass must retain these limits.

`fixture.ts` and `host.ts` create a filtered private HOME, agent directory, desktop profile, real disposable Git project and four real sessions. Fixture-only model configuration is `plan-ui/controlled` with `auth: none`; approval is fixture-only `yolo`. The private tailscale sentinel refuses discovery rather than fabricating peers. `worker.ts` installs a loopback-only fetch guard before loading the production worker; it wraps no native method. Main, host, worker and renderer requests are restricted to HTTP on 127.0.0.1. No retained credentials, dotenv or account profiles are inherited.

The runner hashes maintained host/shared/desktop sources, patches, selected installed native packages, built assets and declared harness inputs before and after the run. Regular files only are inventoried; nested symlinks and node_modules directories are skipped. This is an input identity fence, not a copied transitive import closure or clean-install attestation. Actual command envelopes/results, HTTP requests, native files/journals, qualified screenshots and raw failures remain in the output. Final native journals and Markdown artifacts are copied again after host/worker shutdown. Provider and host shutdown are joined independently; failed drain or evidence capture retains the private fixture and fails the run. Successful shutdown deletes its private bearer/profile data. No source is rebuilt or changed by the runner, and no prior Force scenario runs.

Author validation is limited to standalone TypeScript checking and `node --check main.cjs`; it cannot establish native execution or physical acceptance.
