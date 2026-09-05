# Agent Desktop

Private macOS desktop with machine-owned OMP sessions and an existing-Tailscale transport. The agreed milestone is in [GOAL.md](GOAL.md); [status](docs/status.md) distinguishes working slices from remaining parity and acceptance work.

Requires the pinned Bun 1.3.14. Use each machine's normal OMP account configuration.

The native terminal needs the pinned private tmux bundle. On a macOS arm64 development machine, build it once with `bun scripts/build-tmux.ts .data/build-tmux-macos runtime/tmux/darwin-arm64` after dependency installation. The work and output directories must be new; reviewed rebuilds use new directories. The host verifies the bundle and never uses the user's system tmux. Without it, native terminal controls report the missing runtime while ordinary development-host features remain available.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
bun test
bun run build
```

The development app uses `.data/dev` and a detached host process. Closing the window leaves native work alive. Stop an idle development host through its recorded PID when switching to the installed service; only one app host may use port 47827 on a tailnet node. Do not delete native OMP data to reset the UI.

`bun scripts/capture-desktop.ts` builds and captures this app at three window sizes and three zoom factors; measurements accompany the images. These captures are not Codex reference evidence. `bun scripts/acceptance/live-host.ts` is an explicit live-provider/file-tool check and is intentionally separate from routine tests.

[Host installation and recovery](docs/host-installation.md) describes the versioned macOS/Linux service artifacts. The desktop packager consumes that host archive: `bun scripts/package-desktop.ts /absolute/host-package.tar.gz`. Installed-artifact verification is still underway.

Run `bun scripts/upstream-report.ts` for a read-only report against the pinned Codex/OMP references. It reports unknown coverage and observed changes separately; it does not adopt updates. See the [maintenance procedure](docs/upstream-maintenance.md) for candidate inventories and report files.
