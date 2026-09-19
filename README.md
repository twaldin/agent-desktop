# Agent Desktop

An independent Codex-style macOS desktop powered by **oh-my-pi (OMP)**, with machine-owned sessions and an existing-Tailscale transport. Electron, React, TypeScript and Bun form the desktop and host services.

**Development prerelease: incomplete and not production-ready.** This project is not affiliated with OpenAI. The agreed milestone is in [GOAL.md](GOAL.md); [status](docs/status.md) distinguishes working slices from remaining parity and acceptance work.

[Releases](https://github.com/twaldin/agent-desktop/releases) · [Build status](https://github.com/twaldin/agent-desktop/actions/workflows/release.yml) · [Release process](docs/releases.md)

The public repository preserves the original local commit history. Private reference captures, review packets, credentials and installed runtime data are excluded. Some historical evidence links point to private `.data` files and are not reproducible public build inputs.

Requires the pinned Bun 1.3.14. Use each machine's normal OMP account configuration.

The native terminal needs the pinned private tmux bundle. On a macOS arm64 development machine, build it once with `bun scripts/build-tmux.ts .data/build-tmux-macos runtime/tmux/darwin-arm64` after dependency installation. The work and output directories must be new; reviewed rebuilds use new directories. The host verifies the bundle and never uses the user's system tmux. Without it, native terminal controls report the missing runtime while ordinary development-host features remain available.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
bun run test
bun run build
```

The development app uses `.data/dev` and a detached host process. Closing the window leaves native work alive. Stop an idle development host through its recorded PID when switching to the installed service; only one app host may use port 47827 on a tailnet node. Do not delete native OMP data to reset the UI.

`bun scripts/capture-desktop.ts` builds and captures this app at three window sizes and three zoom factors; measurements accompany the images. These captures are not Codex reference evidence. `bun scripts/acceptance/live-host.ts` is an explicit live-provider/file-tool check and is intentionally separate from routine tests.

[Host installation and recovery](docs/host-installation.md) describes the versioned macOS/Linux service artifacts. The desktop packager consumes that host archive: `bun scripts/package-desktop.ts /absolute/host-package.tar.gz`. Installed-artifact verification is still underway.

Release builds target macOS ARM64 for the desktop and macOS ARM64/Linux x64 for host services. Desktop packages use ad-hoc signing and are not notarized. CI never updates an existing user installation. Native browser, first-Send, cross-device and visual acceptance remain separate requirements.

Run `bun scripts/upstream-report.ts` for a read-only report against the pinned Codex/OMP references. It reports unknown coverage and observed changes separately; it does not adopt updates. See the [maintenance procedure](docs/upstream-maintenance.md) for candidate inventories and report files.

## Saved-reset ownership

The host's [native reset-policy owner](apps/host/src/native-reset-policy.ts) shares `SessionUsageService.admissions` with manual resets. SQLite retains original pass and attempt provenance, exact credential/credit/request binding, consent and settings-readback checkpoints. Compatible automatic work joins the original settlement; unresolved outcomes fence the account across restarts. Finishing a native pass or starting disposal does not imply that an admitted consume physically completed.

`workerLost(epoch)` is nonterminal: a possibly-live original worker can still settle. Only the parent supervisor may call `workerExited(epoch)` after observing actual process exit or confirmed kill. That distinct terminal receipt releases host waiters with an unknown outcome and no native observation; disconnects, deadlines and merely sending a kill signal do not qualify. Failed exit journaling is reported separately and never permits replay.

The owner accepts complete native plans of at most `NATIVE_RESET_MAX_ACTIONS` (128) actions. Larger plans are durably rejected before consent or admission, never truncated or retried as a smaller plan. Pass records have a 1 MiB byte limit; default history limits are 256 passes, 256 account identities and 1,024 attempts. Unresolved account authority and unverified Yes/settings evidence are not evicted to make room. Capacity refusal is explicit, not permission to forget a fence.

Pass start records only origin identity and the shared admission revision before report I/O. Planning then atomically seals the complete ordered plan with the native planner's 64-character report revision; admission copies that sealed value into the existing canonical attempt evidence and never accepts a replacement. Retained version-1 pass rows remain byte-preserved in the original metadata namespace, count toward capacity, and cannot plan, join or admit as newly sealed work. Pass inspection labels them `legacy`; their original canonical attempts remain available through attempt inspection.

This module is not yet wired to native worker callbacks. That adapter must use each original pass's actual AgentSession/Settings instance, verified settings flush/readback, and the synchronous native consume guard. Worker/protocol integration, child-session propagation, host-owned refresh cadence and full `/usage` acceptance remain separate work. Constructing or reopening the host owner never selects, persists settings, contacts a provider, or replays a consume.
