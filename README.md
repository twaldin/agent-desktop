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
