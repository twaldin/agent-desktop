# Desktop agent app: discovery

Status: decisions agreed; implementation underway under [the completion contract](../GOAL.md). See [current evidence and remaining work](status.md).

## Requested outcome

- A usable desktop app reproducing the useful functionality and visual details of Codex desktop, including rounding, padding, icons, and persistence of the new-task project, prompt, and settings.
- Exclude OpenAI application authentication and pets. Further exclusions require a concrete inventory and a decision; "anything non useful" is not a license to silently omit features.
- The same projects and sessions across devices on the user's tailnet, with native Tailscale integration.
- Customizable colors, fonts, backgrounds, blur, and opacity, exposed through configuration and/or settings. The full practical theme-token scope is agreed below.
- Prefer oh-my-pi (omp.sh) for its provider logins and multi-account support, subject to source inspection and a real integration proof.
- Expose all OMP extra settings and model features through native UI, alongside the Codex baseline. A raw configuration editor alone does not satisfy this requirement.
- Plan for maintaining small-detail Codex parity and handling OMP breaking changes/Codex updates after the milestone; include this explicitly in the design and handoff.
- After the interview, create a detailed, resilient completion goal and carry the spike through real account login, agent work, and use across devices.
- Choose the simplest design that satisfies the agreed behavior. Do not substitute mock functionality or silently lower the parity target.

## Design tree

Ask one decision at a time. Confirmed answers belong here; recommendations are not decisions.

1. Session ownership and availability — core decision confirmed
   - Projects are directories on a home machine. Their sessions live on that machine.
   - Every connected device can see and control those sessions through the app and tailnet, conceptually like SSH plus tmux.
   - Work waits when its home machine is offline. Automatic migration and an always-on central host are not required.
   - Closing a client window should detach from the running work; machine sleep/offline is a separate state.
   - Both connected clients may send, steer, stop, and answer approvals immediately. The owner orders commands, deduplicates retries, and resolves each approval once; no explicit controller handoff.
   - Offline clients retain readable cached history and editable drafts. Sending requires reconnection; do not automatically submit queued prompts on reconnect. Preserve conflicting draft edits rather than silently overwriting them.
   - Still specify crash recovery and pending command/interaction behavior.
2. Meaning of native Tailscale integration — transport choice confirmed
   - Use each machine's existing Tailscale connection. Discovery and connection belong inside the app; no manual SSH commands.
   - Do not require a separate embedded Tailscale identity/login.
   - One shared app workspace across the user's connected personal/work hosts. Projects, sessions and credentials retain host ownership; separate personal/work app profiles are not required.
   - Discovery is not authorization for arbitrary tailnet peers. Design host authentication for the user's connected hosts while preserving this shared workspace experience.
3. Platform and delivery scope — platform choice confirmed
   - First milestone: macOS desktop app, macOS and Linux host services. Linux/Windows desktop apps are not required for this milestone.
   - Private use first. Deliver reliable, installable builds for the user's machines; public/open-source distribution is outside this milestone.
   - Physical acceptance targets: twaldin-home and twaldin-work as desktop clients, plus deckbox as a Linux host.
   - Both Macs are arm64 and have OMP 18.1.10, Bun 1.3.14 and running Tailscale 1.98.10. Authenticated SSH to work succeeds as twaldin; its noninteractive PATH omits OMP, so use explicit runtime paths. Home can be verified locally.
   - Authorized SSH identities: twaldin@twaldin-work and tim@deckbox. Deckbox is Ubuntu 24.04 x86_64 with Bun 1.3.14, OMP 18.1.10, Tailscale 1.102.2 and user systemd/linger available. Use explicit runtime paths; preserve tailnet policy.
4. Reference and parity contract — feature boundary confirmed; acceptance details pending
   - Reference: installed Codex 26.901.41600, build 7982. Inventory screens, actions, states, shortcuts, persistence, and edge cases.
   - First milestone retains the full local development experience: drafts, sessions, terminal, files, Git/worktrees/reviews, browser panels, plugins/MCP, automations, and associated settings and interactions.
   - Exclude the proposed hosted layer: ChatGPT history, cloud-run tasks, realtime voice, hosted connectors, and public conversation share links. Also exclude OpenAI application authentication and pets as originally requested.
   - These exclusions do not remove OpenAI/ChatGPT as an OMP model provider or its provider login.
   - Still define measurable visual/behavioral acceptance and the relationship of an intermediate usable checkpoint to final milestone completion.
5. Harness and provider accounts — scope confirmed; implementation proof pending
   - Expose all OMP providers and accounts, with OMP's native account selection and switching. No app-maintained provider shortlist or replacement routing algorithm.
   - Use OMP's provider registry and provider-specific login callbacks; preserve its local/broker authentication mechanisms.
   - SDK and broker source investigation supports feasibility. A real openai-codex/gpt-5.4-mini turn now created and read back a file through native tools on home; this does not establish every provider or login callback.
   - Each host uses its existing native OMP account setup, including a broker where configured. Expose account management in the app; do not establish a required shared broker.
   - Source support must not be reported as live verification for every provider.
6. Execution and integrations — unresolved
   - Tools, permissions, terminal, files, Git/worktrees/review, browser/computer use, plugins/MCP, automation, and other reference features.
   - External CLI/runner sessions should be an opt-in import option, not automatically included in the sidebar.
   - Import continues the original session on its owning host, preserving history and identity; the app may control it once the external runner releases it.
   - Proving that the original is inactive and avoiding competing writers is a required integration check. An existing cross-process OMP lock/attach mechanism has not been verified.
   - Use OMP's native permission modes, accurately labeled. An additional Codex-equivalent OS filesystem/network sandbox is explicitly outside this milestone.
7. Shared state — boundary confirmed
   - Share sidebar organisation, unsent drafts, project/model selections, and preferences across clients.
   - Each window's navigation and layout remain independent.
   - Verify cross-device continuation of an unsent prompt, including project/model selection, and preserve conflicts after offline edits.
   - Host-local projects/sessions retain canonical ownership. Shared global preferences need a design compatible with no always-on central project server.
8. Themes — breadth confirmed
   - Expose all practical visual tokens in a theme file, with native settings for colors, fonts, backgrounds, blur/opacity, spacing and rounding, plus an advanced token editor.
   - Default appearance is the Codex parity baseline; customization is an intentional departure selected by the user.
   - Still specify config format, cross-device font/background behavior, platform-effect limits and invalid-config recovery as part of the implementation contract.
9. Evidence and delivery — unresolved
   - Real login and model/tool execution; two physical devices; reconnect/restart/crash tests; visual and interaction comparisons.
   - The user agreed to a short hands-on acceptance step for required provider sign-ins and reference visual/interaction checks beyond current tooling. Prepare the working build and automated evidence first, then supply a precise short checklist.
   - Still write the concrete acceptance contract and record independent versus user-verified evidence and failures accurately.
10. OMP feature UI and ongoing parity — explicitly added by the user
   - Full native UI coverage of OMP settings and model features is required, not only the features that have Codex UI equivalents.
   - Proposed approach: use OMP metadata where available and explicitly map the remaining controls and interactions; track coverage against the pinned upstream surface.
   - Proposed maintenance: pin reference and harness versions; keep a traceable Codex visual/behavior inventory, OMP capability coverage, integration/migration tests, and explicit upgrade reviews.
   - Integrate OMP-only settings and model options into related composer menus and settings pages, with expandable advanced sections for less-used controls.
   - Record these intentional OMP additions separately from unintended Codex parity drift; do not use them to waive unrelated differences.
   - Keep tested versions pinned. Provide on-demand change reports and compatibility tests, then explicitly adopt updates. Automatic upstream checks/candidate staging are not required.
   - Do not create recurring Codex update automations unless separately requested.
11. Technology stack — explicitly raised by the user
   - Compare GPUI/Rust, Tauri and Electron against the observed installed Codex stack and OMP runtime.
   - Installed package is `openai-codex-electron`; source metadata and bundled assets establish Electron/Chromium, React, TypeScript, Tailwind and Vite/Rolldown, plus native integrations. OpenAI uses a customized Electron shell.
   - Selected: Electron + React/TypeScript/Tailwind UI and a separate Bun/OMP host service.

## Initial observations

- Workspace started empty; it is now an initialized Git repository with the implementation in progress.
- Local `omp`, Bun, Node, Git, and Tailscale executables are present. `omp --version` reports 18.1.10 and `bun --version` reports 1.3.14, matching the examined OMP release and its minimum Bun runtime. Presence/version alignment alone does not prove integration behavior.
- Selected physical targets are twaldin-home, twaldin-work and deckbox; their users and runtimes were verified.
- Installed reference package investigation is read-only and excludes credentials and user conversation data.
- The computer-use tool refused access to `com.openai.codex` for safety reasons. No alternate live UI control or capture channel will be used to bypass that restriction. Static package evidence does not count as live interaction or screenshot verification.
- The user identified `~/agent-system` as context for how this app will be used, explicitly not the work system for this build. Inspect its usage patterns only; use harness-native goals and subagents to build this project.
- Usage documentation describes machine-owned native auth, execution, sessions, and worktrees; coding conversations belong in real project directories. External runners can create and resume durable OMP sessions. The selected app model is one shared workspace with machine-owned projects and credentials.
- Installed reference: Codex 26.901.41600, build 7982, bundle `com.openai.codex` at `/Applications/ChatGPT.app`; app.asar SHA-256 `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`. Static reference extracted to `/tmp/codex-reference-26.901.41600` (temporary evidence, not a durable source dependency).
- OMP was initially inspected at main snapshot `5964a0f7649275bcde818f20073193fd032451f2`, which differs from the release despite sharing its version string. The canonical npm/tag 18.1.10 source is `f241301c83726afe75a847e919b89977a54dafbe`; `.reference/omp-18.1.10-release/` records the exact release inventory. Its SDK requires Bun >=1.3.14. A daemon must own runtime workers independently of desktop client connections.

## Research notes

See [reference and harness findings](reference-findings.md) for source-backed capability findings, the initial parity surface, and unverified boundaries.

## Sources

- [Tailscale tsnet](https://tailscale.com/docs/features/tsnet): embeds a tailnet node in a Go program; distinct from application session replication.
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve): shares a local service within a tailnet.

## Completion discipline

The native completion goal and [GOAL.md](../GOAL.md) preserve every agreed requirement and distinguish implemented, verified, failing, and blocked work. Simulations and local multi-client tests can support testing but cannot stand in for real provider access or a physical cross-device acceptance run.
