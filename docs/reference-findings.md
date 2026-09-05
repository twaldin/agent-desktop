# Reference and harness findings

These are read-only discovery findings, not implementation or acceptance results. Decisions are tracked in [discovery.md](discovery.md).

## Codex reference

Installed reference: version **26.901.41600**, build **7982**, bundle ID `com.openai.codex`, located at `/Applications/ChatGPT.app`. Chromium base is 152.0.7977.64; declared macOS minimum is 13.0. `app.asar` SHA-256: `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`.

The original `app.asar`, reference metadata, archive inventory and draft-persistence evidence are preserved in the ignored workspace directory `.reference/codex-26.901.41600/`. The archive was verified against the SHA-256 above so an installed-app update does not silently change the baseline. This is local reference material, not application source or distributable output.

Temporary extracted evidence is under `/tmp/codex-reference-26.901.41600/`: `package.json`, `app-initial-5b0a474bff5e.css.readable.txt`, `.vite/build/main-C5K7o1Hr.js`, and `webview/assets/`. The archive inventory contains 8,930 files; no source maps were found. These temporary paths must not become build dependencies; the preserved archive can regenerate them.

The package uses Electron/Chromium, React, Tailwind and Vite/Rolldown, with native PTY, SQLite, filesystem and language-server integration. It uses a customized Electron shell. A replacement cannot assume stock Electron provides every native behavior.

CSS preserves concrete layout values and platform-specific overrides: the base spacing token is .25rem, sidebar preferred width is 275px with bounds, and single-line composer radius is 5.5 spacing units. Matching appearance requires preserving the selector cascade and platform distinctions, not simply collecting one set of CSS variables. Named icon chunks include SVG geometry; fonts and static assets are also packaged. No decision to distribute extracted code/assets has been made.

### Initial parity surface to inventory

| Area | Observable behavior and states to capture |
| --- | --- |
| Sidebar/projects | Ordering, pinning, sections, search, rename, archive/unarchive, delete, project identity and host state |
| New conversation | Home/panel composer, provisional identity, project/model/reasoning/permission selection, attachments, mentions, drafts, navigation and restart persistence |
| Running sessions | Streaming, tool output, queue/steer/interrupt, approvals/questions, retries/errors, fork/resume/rollback, compaction, goals, usage |
| Source control | Branches, worktrees, dirty files, conflicts, handoff, missing workspaces, diffs, review comments, PR operations, progress and retry |
| Panels | Terminal/PTY, editor, files, language services, browser, artifacts, layout, focus and keyboard shortcuts |
| Integrations | Remote connections, automations, hooks, MCP, skills/plugins, notifications, settings |
| Hosted capabilities | ChatGPT conversations, cloud environments, voice, connectors, sharing, billing/account functions: require explicit scope decisions or replacements |
| Appearance | System/light/dark, accent/background/foreground/contrast, translucent sidebar, UI/content/code fonts and styles, sizes, smoothing, code themes, reduced motion, pointer cursor, theme import/export |

Theme additions need an explicit contract for blur radius, opacity and background customization. Native macOS vibrancy and Windows Mica are different effects.

The preserved `.reference/codex-26.901.41600/` now includes `VISUAL-REFERENCE.md`, `visual-token-inventory.json`, `visual-source-manifest.json` and `theme-defaults.json`. The static inventory contains 4,480 custom-property declarations, 1,696 unique properties, 24 font faces and 117 property registrations across 204 CSS sources. It preserves selectors, nesting, at-rules, importance, raw values and source order. Source bytes were checked against the pinned archive, and all 66 font-resource references resolve. These include implementation-level CSS properties as well as theme controls; counts are not counts of required user-facing settings. Inline/JavaScript-generated styles and native window materials are outside this inventory, which is not a computed-style or screenshot reference.

Useful source anchors within the extracted package:

- `webview/assets/app-initial-86767c3d23e5.js`: project/thread/turn operations, files/PTY and streamed notifications.
- `.vite/build/main-C5K7o1Hr.js`: owning app-server instances and remote SSH bootstrap through a Unix socket/proxy.
- `webview/assets/new-thread-panel-page-fdb6e758bd9d.js`: new-thread panel.
- `webview/assets/local-remote-dropdown-42370c8e4577.js`: worktree and handoff states.
- `webview/assets/general-settings-611c673c036d.js`: appearance settings.

The installed app and user data were not changed; credentials and conversation databases were not read. The computer-use tool refused live access to Codex for safety reasons. No alternative UI channel was attempted. Draft persistence lifecycle, live interaction behavior and screenshot fidelity remain unverified. Static findings alone do not establish parity.

### Narrow draft-persistence follow-up

Source inspection traced rich prompt drafts to `composer-prompt-drafts-v2`, with a home base key `new-conversation` that does not contain a project ID. Project selection is stored separately. Updates synchronize between windows through the local main process and persist in the configured Codex home's `.codex-global-state.json`. The observed renderer and disk debounce intervals are 250 ms and 500 ms respectively. No user state file was read.

Accepted submission clears the captured draft only if it still matches, protecting newer edits made while sending. Complete queue/error/unknown-delivery behavior remains unverified. New-chat model/reasoning selection writes selected-host configuration; existing chat selection updates next-turn thread settings. Execution mode has separate per-project persistence.

Ordinary attachments used retained memory in the traced paths; their restart restoration was not established. PR attachments and response annotations have explicit durable stores. Sidebar width, expansion, collapsed sections and sorting use local persisted atoms shared between windows, which does not establish cross-machine synchronization. Some packaged components are unreachable legacy code; the new-thread-panel component redirects unconditionally to `/`.

Temporary detailed evidence: `/tmp/codex-reference-26.901.41600/draft-persistence-findings.md` and `draft-persistence-evidence.txt`. These are static observations; the new app's explicitly requested cross-device draft behavior is an addition requiring its own acceptance tests.

## OMP

Official source: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). Investigation pinned to commit `5964a0f7649275bcde818f20073193fd032451f2`, release [v18.1.10](https://github.com/can1357/oh-my-pi/releases/tag/v18.1.10). Temporary checkout: `/tmp/codex-parity-omp-investigation`. OMP has an MIT license; preserve its notices.

### Runtime and sessions

The [SDK](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/sdk.md) supplies session creation, event subscriptions, tools, extensions, MCP, auth/model wiring and persistence. It requires Bun >=1.3.14. Multiple concurrent SDK sessions require a private `AgentRegistry` per session.

[RPC](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/rpc.md) provides stdio JSONL commands and streamed state. It is not an attachable daemon: closing stdin disposes the session. A persistent app host service must own workers, serialize client commands, broadcast state and retain pending interactions independently of desktop connections.

[Session storage](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/session.md) uses append-only JSONL trees with a mutable branch pointer. New ordinary sessions may remain in memory until an assistant message or `ensureOnDisk()`. Completed messages persist; streaming partial text does not. Upstream flush does not call `fsync`. Reconnection to a surviving worker, recovery after worker death and power-loss durability are separate guarantees. The desktop must persist its pre-send drafts and selection state separately.

Follow-up inspection found no cross-process exclusive ownership lock in the examined session implementation. A comment claims `open()` acquires one, but the inspected open/file-switch paths do not; `FileSessionStorageWriter` opens an ordinary append descriptor, and the manager's persistence queue is instance-local. Native file-lock utilities elsewhere are not connected to this path. The confirmed opt-in import must preserve the original identity without competing writers. App workers can coordinate with each other; unrelated CLI writers require a cooperative ownership mechanism or an explicit inactive-source constraint. This is an integration proof requirement, not an established upstream guarantee.

Built-in [collaboration](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/collab.md) has restricted guests and a per-session relay. It does not provide the equal desktop control or project catalog required here.

### Accounts and login

The [broker and gateway](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/auth-broker-gateway.md) already centralize refresh-token ownership and expose authenticated APIs. The broker can distribute access credentials; the separate gateway keeps provider access tokens away from callers. OMP account selection includes affinity, ranking, rotation and persisted quota blocks. Reuse this behavior.

The app needs a GUI bridge to OMP login callbacks, including URL, device-code and interactive-input flows. RPC login alone has limitations for input requested before an auth URL; broker-backed storage rejects local login writes. A broker-host login operation is needed when broker configuration is used. Browser callbacks to localhost need forwarding when the login happens on a remote execution host. The existing broker CLI already documents SSH forwarding for these callback ports.

Provider implementations span browser OAuth, device-code and pasted-token/key inputs. Their presence in the registry does not prove live provider acceptance. Expose the complete OMP surface and separately record which real account flows have passed testing. No account login, inference, refresh or rotation was performed in discovery.

Local setup inspection: the default `/Users/twaldin/.omp/agent/config.yml` has no broker URL selection, and the current tool process has no broker/profile/agent-directory override selected. Under the examined upstream resolver this selects local auth. A broker-token file exists, but presence alone does not select broker mode; its contents were not read. This says nothing about other running processes, shells, profiles or machines. Broker placement is a pending user decision.

Broker APIs use bearer credentials and delegate transport protection to Tailscale/WireGuard/TLS. Account-pool filtering is routing policy, not authorization. Ordinary local credential SQLite contents are protected by filesystem permissions; OS Keychain encryption was not verified. App viewers do not need provider tokens simply to control remote sessions.

### Execution permissions

[OMP approval modes](https://github.com/can1357/oh-my-pi/blob/5964a0f7649275bcde818f20073193fd032451f2/docs/approval-mode.md) supply tool gates and overrides. They do not establish a Codex-equivalent OS sandbox. Default mode is `yolo`; shell restrictions do not cover every alternative execution route. The app's permission/sandbox contract still needs a decision and evidence.

## Usage context

The user supplied `~/agent-system` only to explain intended use; its work system is not part of this build. Narrow documentation inspection covered its README and referenced OMP runner docs. It confirms machine-owned project directories, sessions, worktrees, execution identities and credentials; background runners may create/resume native OMP sessions. Native harness goals and subagents will be used for implementation.

## Provisional architecture recommendation

One persistent service per home machine; that machine owns its project/session catalog, runtime workers and durable state. Desktop clients discover hosts through existing Tailscale, attach, and reconnect. Use a pinned OMP integration with one owner per live session and each host's native account setup, including a broker where configured. No automatic migration or central always-on project host is required. App preferences and drafts are shared; window navigation/layout stay local, and offline draft conflicts must be preserved. Authentication and shared-preference replication still need concrete implementation designs.

### Desktop stack comparison requested by the user

The inspected package names itself `openai-codex-electron`. Its manifest lists Electron 42.3.0 and Vite 8.1.5, while the running-shell metadata declares Chromium 152.0.7977.64. OpenAI uses a customized shell; selecting the manifest's Electron version alone does not guarantee the same actual Chromium engine or native integration.

Recommendation pending user choice: Electron, React, TypeScript and Tailwind for the desktop, with a separate Bun/OMP host service. [Electron embeds Chromium and Node](https://www.electronjs.org/docs/latest/), matching the reference's rendering approach and supporting browser-backed panels. It incurs the footprint of those bundled runtimes. [Tauri uses WebKit on macOS](https://v2.tauri.app/reference/webview-versions/), introducing another rendering engine to reconcile with the reference. [GPUI is a Rust UI framework](https://gpui.rs/), requiring translation of web components and styling to a different UI system. The relative implementation-effort assessment is an engineering inference, not a measured benchmark.
