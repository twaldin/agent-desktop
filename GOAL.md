# Private desktop agent app: completion contract

Build a usable private macOS desktop app that reproduces the agreed local Codex experience, runs agents through OMP, and attaches to machine-owned projects and sessions across the user's existing tailnet. Complete the real functionality and detailed default appearance, including small interaction and persistence behavior. Deliver installable builds and verification on the selected physical machines.

This contract is the implementation goal, not a claim that the app exists. Usable intermediate builds are checkpoints. Completion requires the acceptance gates below; incomplete or unverified requirements stay visible.

Tim's September6 sequencing is explicit: complete the OMP-backed, faithfully reproduced Codex frontend first. Add agent-system control-center and phone web features afterward, using the same app components, contracts and visual style. Those additions must not displace or relax any core parity gate. Their coordination boundary is recorded in [agent-system integration](docs/agent-system-integration.md).

## Agreed scope

- Reference Codex 26.901.41600, build 7982, archive SHA-256 `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`. Preserve this baseline across installed-app updates.
- Reproduce the full local development experience: projects/sidebar, new conversation, drafts, streaming sessions, agent interactions, terminal, files/editor, Git/worktrees/review, browser/artifact panels, local plugins/MCP/skills/hooks, automations, notifications, shortcuts and settings. Expand these areas into a traceable feature/state inventory before declaring parity.
- Exclude pets, OpenAI application sign-in and its billing/credits, ChatGPT history, cloud-run tasks, realtime voice, hosted connectors and public conversation share links. These exclusions do not remove OpenAI/ChatGPT provider access through OMP.
- Use OMP's native permission modes with accurate labels. An additional Codex-equivalent OS filesystem/network sandbox is outside this milestone. Ordinary desktop process isolation and transport authentication remain necessary.
- Expose all OMP providers/accounts and their native selection/switching. Each host uses its native OMP configuration, including a broker where configured. Do not require a new central account broker.
- Expose OMP settings and model features through native UI in the relevant composer menus and settings pages, using advanced sections for less-used controls. A raw configuration editor alone does not meet this requirement.
- The app combines the scoped Codex application features with OMP's native harness features. Provide composer autocomplete in the reference location: `/` for commands (including app actions), `$` for skills, and `@` for files and applicable references. Preserve the owning host's actual command/extension/skill discovery and dispatch semantics. Map the floating environment card, goals, subagents, sources, changed-file totals, approval state, model state and titles to real OMP or host-service state; identify and implement missing bridges instead of assuming equivalent APIs exist. Right/bottom panels require the reference's tabs, docking, resizing and compact actions, not permanent configuration forms.
- Use Codex's equivalent presentation for OMP capabilities: the native OMP browser in browser tabs, native models in the model picker, native settings in appropriate settings pages, native goals in the goal UI, and native `btw` conversations in side chat. Preserve the actual native identity, lifetime, configuration and state semantics. A generic replacement session or unrelated browser is not an equivalent integration. Audit both directions: every scoped app surface needs its real backing behavior, and every applicable OMP capability needs a functioning UI path.
- Provide extensive theming: all practical visual tokens in a file, native settings for colors, fonts, backgrounds, blur/opacity, spacing and rounding, and an advanced token editor. The default theme is the reference-parity baseline.
- Private installation on macOS desktops and macOS/Linux hosts. Public distribution and Linux/Windows desktop clients are outside this milestone.

## Confirmed machine and state model

Projects are real directories on a home machine; their sessions, files, worktrees and execution remain there. The app/tailnet provide connection and control, conceptually like SSH plus tmux. A second clone on another machine is a distinct working directory with distinct ownership. No automatic migration or always-on central project server is required.

Use existing system Tailscale. Discover and connect to app hosts in the UI without requiring manual SSH commands for ordinary use. One shared workspace spans the user's connected personal/work hosts. Authenticate connected peers; tailnet discovery alone must not grant arbitrary peers access to the execution API.

Both desktop clients can send, steer, stop and answer approvals immediately. The host orders commands, deduplicates retries and resolves each pending interaction once. A client disconnect or closed window must not kill its host's running work.

Detached structured questions must return acceptance immediately and let the agent continue. Keep this a distinct host-owned, resolve-once path across clients; deliver answers through native steer during a turn or follow-up when idle. Preserve OMP's existing blocking asks and explicitly interactive provider/tool approvals. A suggested or preselected option is not an answer. Keep the OMP 18.1.10 pin; research about newer releases does not authorize an upgrade.

Share sidebar organisation, unsent drafts, project/model selections and app preferences. Keep each window's navigation and layout independent. Credentials and host-specific OMP configuration stay on their owning hosts; viewing or editing remote settings does not turn them into globally replicated app preferences.

Offline clients retain cached readable history and editable drafts. Sending requires reconnection; do not automatically submit offline drafts. Preserve conflicting edits rather than silently overwriting them. Show stale/offline/pending states accurately.

External OMP sessions enter through an explicit import action. Import continues the original on its home machine and preserves history/identity. Enable writes only when the external runner has released it. The inspected OMP session implementation does not provide the claimed cross-process lock; establish a sound inactive-source/ownership contract and test it. Do not pretend a file listing proves safe live attachment.

## Stack and boundaries

Use Electron, React, TypeScript and Tailwind for the desktop, with a separate Bun/OMP host service. Keep a small workspace: desktop, host, and shared protocol/types. Use standard platform capabilities and existing libraries before introducing abstractions. Do not add a general multi-harness framework or a distributed project database.

Pin `@oh-my-pi/pi-coding-agent` to **18.1.10**, matching release commit **f241301c83726afe75a847e919b89977a54dafbe**, and start from the verified Bun **1.3.14** runtime. The earlier inspected main snapshot has later changes; its settings inventory is not the release acceptance baseline. Regenerate release coverage from the exact tag/package.

Use maintained source for the app and concentrated OMP integration code. Keep installed-package reference evidence separate from production code. Choose a public Electron version after checking its actual Chromium/native behavior; Codex's customized shell means the manifest version alone is insufficient.

The owning service manages durable catalog/state, native OMP workers, attachments, tools, Git/PTY integrations and event delivery. Worker ownership must survive desktop disconnection. Use stable host/project/session/draft/command identities, explicit protocol versions, resumable event delivery and bounded buffering. Isolate unrelated sessions from one another's failures.

Implement the smallest shared-preference synchronization that satisfies the selected behavior. Owner-host revisions and conflict preservation are appropriate for drafts; global preferences need deterministic reconciliation without a required central server. Do not spread provider credentials or host filesystem paths through generic preference replication.

Use explicit runtime paths in installed services. macOS uses launchd; Linux uses a user service where supported. Document start/stop/uninstall and preserve user data and native Git/auth identities. No agent co-author trailers or unrelated machine configuration changes.

## Build sequence

1. **Freeze evidence and coverage.** Preserve the reference, regenerate the exact OMP release inventories, and define traceable screens/states/actions, visual measurements, settings/model controls and accepted exclusions. Mark static-only or unreachable-source observations accurately. Keep feature-flag uncertainty visible. Extract and hash every available packed reference member, index source-map availability and chunk dependencies, and trace each scoped surface to its renderer, styles, state ownership and backend calls. Inventory native/unpacked resources separately. Prefer the exact identified upstream component and options when appropriate, while keeping reference files separate from maintained production code. Recovering bundled code does not itself establish that every branch is reachable or visually matched.
2. **Prove the runtime boundary.** Build a minimal real desktop/host flow using OMP: native authentication discovery, actual model response, actual tool/file change, two independent sessions, streaming, stop/steer, pending interactions and native resume. Prove that closing/reopening the UI leaves host execution intact. Test original-session import ownership rather than assuming it.
3. **Make the state durable and remote.** Implement host discovery/authentication, project/session catalog, multiple clients, command deduplication, event replay, draft/selection/sidebar/preferences persistence and offline conflicts. Prove this over Tailscale before expanding surface area.
4. **Complete the local app.** Implement the inventoried developer workflows and their failure/empty/loading states with real integrations. Add all applicable OMP controls and provider login callbacks, native permission modes, account management and model capability-aware controls.
5. **Match and customize appearance.** Reproduce measured default layout, typography, icon geometry, colors, spacing, radii, focus/hover/disabled states and menus; add the agreed theme controls without breaking baseline behavior. Validate configuration edits and retain the last valid theme on errors. Show unavailable fonts/platform effects accurately; support resetting to the baseline.
6. **Package and exercise recovery.** Produce installable macOS and Linux host artifacts. Verify service lifecycle, upgrades/rollback, independent worker failures and reconnects. Preserve completed work and report interrupted/unknown outcomes; do not blindly replay potentially completed side effects after a crash.
7. **Run physical acceptance and finish parity.** Deploy to the selected machines, run the automated acceptance matrix, fix gaps, then prepare the short user checklist for remaining real sign-ins and permitted reference visual/interaction checks. Complete all agreed gates and retain the evidence.

Use harness-native subagents for bounded parallel work, with clear ownership of files/interfaces and independent validation. Use the native goal for persistence across turns. `~/agent-system` is usage context only: do not adopt or operate its orchestration system for this build.

## Acceptance gates

| Area | Required evidence |
| --- | --- |
| Real harness | Installed app creates/resumes native OMP sessions, streams a real provider response, performs an actual tool/file operation in a disposable project, and accurately stops/steers/queues work. Multiple sessions remain independent. |
| Accounts | Complete OMP registry surfaced; native local/broker configuration honored; all callback types bridged to real controls; existing account metadata and selection shown accurately. Real account login/use/switching tested where accounts are available; deterministic failure tests clearly separate from live provider evidence. Never exhaust real quotas merely to test rotation. |
| OMP UI coverage | Every setting/model/provider capability in the pinned inventory is mapped to a functioning control, accurate read-only capability, or explicitly justified applicability category. Missing descriptors cannot silently remove a feature. Terminal-specific controls and extension-defined surfaces require explicit handling; raw text alone cannot substitute for required native UI. |
| New conversation | Rich prompt, target host/project, model/reasoning/permissions and attachments persist through the agreed navigation/restart flow. Switching laptops continues unsent work. Accepted submission clears only the submitted revision; edits made during sending survive. Pending/error delivery cannot silently discard or duplicate work. |
| Shared control | Both Macs control the same owning-host session. Concurrent sends are ordered, retries deduplicated, approvals/questions resolved once, and stale commands rejected or reconciled visibly. |
| Disconnection | Client closure does not terminate running work. Reconnection restores history/state without duplicate events or commands. Offline history/drafts work; conflicting edits are recoverable. Host and worker failures are distinct from client disconnection. |
| Ownership/import | Projects, sessions, files and worktrees stay on their owners. External import preserves identity and refuses unsafe competing writers. No silent replacement session/worktree to make a broken flow appear successful. |
| Developer workflows | Each inventoried local terminal/file/editor/Git/worktree/review/browser/artifact/plugin/MCP/skill/hook/automation/notification/shortcut flow works against its actual backend, including relevant empty, busy, denied, missing-resource, conflict and error states. |
| Appearance | Default screens and interactions are compared to the pinned reference at recorded viewport, scale, theme and font conditions. Include fine spacing, rounding, icons, menus and input/focus behavior. Record intentional OMP/theming changes; do not hide unrelated differences with masks, broad thresholds or recreated expected output. |
| Theme behavior | Native editor and theme file agree; live changes and restart/cross-device persistence work; practical tokens are exposed; invalid edits retain a usable last-good theme; resets work. Fonts/background assets and platform effects are handled honestly. |
| Installation | macOS clients and macOS/Linux services launch from installed artifacts with documented paths, survive ordinary UI lifecycle, and have tested stop/uninstall/upgrade/rollback behavior that preserves user data. |
| Maintenance | On-demand source/reference and capability change reports, pinned dependencies, focused integration/migration tests and an explicit upgrade procedure. No silent adoption of upstream changes. |

Turn these areas into concrete test cases and coverage records while implementing. Passing a broad area label is not enough if its scoped subfeatures remain incomplete.

## Physical test targets and user participation

- `twaldin-home`: current local macOS arm64 desktop/host, user `twaldin`.
- `twaldin@twaldin-work`: macOS arm64 desktop/host; authenticated SSH verified.
- `tim@deckbox`: Ubuntu 24.04 x86_64 Linux host; authenticated SSH verified. Bun/OMP are in `/home/tim/.bun/bin`; user systemd is available and linger is enabled. Its user manager reports `degraded`; inspect relevant failures before attributing issues to the app or changing anything unrelated.

All three machines have OMP 18.1.10 and Bun 1.3.14. Respect configured authentication and host verification. Do not alter tailnet policy or broaden access to work around an error.

The user agreed to a short hands-on acceptance step after the build and automated evidence are ready. Prepare precise steps for any required provider sign-ins and reference visual/interaction checks. Current computer-use tooling refuses live access to Codex; do not bypass that restriction or claim live comparisons from static package evidence. User-provided/permitted reference evidence is required for the corresponding final gate.

## Evidence and completion rules

- Tests exercise production paths. Fixtures, fake provider responses, multiple windows on one computer and source inspection each have legitimate uses, but do not count as real provider or physical cross-device acceptance.
- No inert controls, hard-coded successful transcripts, fabricated account/host status, hidden TODOs, silent feature removal, swallowed errors or disabled verification to obtain a passing result.
- Distinguish supported by source, implemented, automatically tested, live verified, user verified, failing and blocked. A narrow success must not be reported as full parity.
- Preserve failure evidence and fix causes. Rerun relevant checks after changes; broaden testing only for unresolved risk. Back up existing data before migrations and verify recovery before applying them to user data.
- Maintain a concise current status with completed work, remaining scoped work, evidence locations and external inputs needed. Keep raw logs and execution chatter out of user-facing reports.
- Use the supplied private `.data/codex-screenshots/` reference bundle and project `verify-ui-parity` skill as the default comparison workflow. Inventory every recorded capture/state/transition and the uncaptured frontier; keep private reports and candidate originals under `.data/`. Record the bundle-versus-pinned build difference, per-file geometry and evidence class. Source-level gap discovery does not establish visual parity, and a missing reference capture does not remove a required feature.
- Complete the native goal only when the scoped functionality and accepted visual behavior are delivered, the physical acceptance run and required user checks pass, and no required work remains. Use goal-blocked status only under the harness's actual repeated-blocker rule. Do not lower scope or mark completion merely because work is long or a checkpoint is usable.

Supporting decisions and evidence: [discovery](docs/discovery.md), [reference findings](docs/reference-findings.md), [maintenance workflow](docs/upstream-maintenance.md).
