# Private host installation

The host artifact contains maintained TypeScript sources, shared protocol, the unchanged workspace manifests, frozen Bun lockfile and explicitly supplied private tmux runtime bundles. It includes the desktop workspace's manifest to keep dependency resolution exact; desktop code, development dependencies, user settings, credentials, sessions and `node_modules` are excluded. Production installation resolves the pinned native packages on each target architecture. No service runs from the development checkout.

Create a fresh immutable release only after the complete source passes its relevant tests and typecheck:

```sh
bun scripts/package-host.ts --version VERSION --out /absolute/path/agent-desktop-host-VERSION.tar.gz --tmux-bundle /absolute/native/darwin-arm64 --tmux-bundle /absolute/native/linux-x64
```

The command returns the archive SHA-256 and writes a sidecar checksum. Transfer the archive and checksum to the selected machine through its authenticated SSH connection, verify the checksum there, and extract it into a temporary directory to access the installer. The installer validates archive paths and manifest file hashes again. Do not weaken SSH host verification.

Run the target's existing Bun 1.3.14, supplying its actual path:

```sh
/absolute/path/to/bun /temporary/unpacked/scripts/install-host.ts install --package /temporary/agent-desktop-host-VERSION.tar.gz --bun /absolute/path/to/bun
```

Known targets: `twaldin@twaldin-work` uses `/opt/homebrew/bin/bun`; `tim@deckbox` uses `/home/tim/.bun/bin/bun`. Home uses `/Users/twaldin/.bun/bin/bun`. Installation copies the verified Bun executable into the release, runs `bun install --production --frozen-lockfile`, and imports the host/native lock library before activation. Bun and native binaries then remain independent of the checkout and later global Bun upgrades.

The installer creates `~/.local/share/agent-desktop-host/versions/VERSION` and switches a `current` symlink atomically. Each release is immutable; upgrades require a new version. Native OMP configuration and account credentials remain in their existing home-directory locations. The service uses the real user's home as its working directory and sets only its executable search path and `AGENT_DESKTOP_DATA_DIR`.

| Platform | Service | Persistent app data |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.agent-desktop.host.plist`, user GUI launchd domain | `~/Library/Application Support/Agent Desktop` |
| Linux | `~/.config/systemd/user/agent-desktop-host.service`, systemd user manager | `~/.local/share/agent-desktop` |

macOS requires the selected user's logged-in GUI domain. Linux uses the existing user manager and native `WorkingDirectory=~` to select the user's home; this setting has different quoting rules from `ExecStart` ([systemd 255 parser](https://github.com/systemd/systemd/blob/v255/src/core/load-fragment.c)). The installer never enables linger or changes unrelated services. Deckbox already has linger enabled; its unrelated degraded manager state is not repaired by this installer. Existing Tailscale remains separately managed. The CLI server enables discovery and the authenticated tailnet listener; the installer never changes tailnet policy, Serve/Funnel or firewall configuration.

## Lifecycle and recovery

Invoke the installed installer with the installed Bun:

```sh
~/.local/share/agent-desktop-host/current/bin/bun ~/.local/share/agent-desktop-host/current/scripts/install-host.ts status
~/.local/share/agent-desktop-host/current/bin/bun ~/.local/share/agent-desktop-host/current/scripts/install-host.ts stop
~/.local/share/agent-desktop-host/current/bin/bun ~/.local/share/agent-desktop-host/current/scripts/install-host.ts start
~/.local/share/agent-desktop-host/current/bin/bun ~/.local/share/agent-desktop-host/current/scripts/install-host.ts rollback
~/.local/share/agent-desktop-host/current/bin/bun ~/.local/share/agent-desktop-host/current/scripts/install-host.ts uninstall
```

Install, rollback and uninstall refuse cataloged running turns and active interactive terminals. A reachable host is checked for both terminal protocols, allowing an explicitly absent route on an earlier release; durable native ownership is checked even without a live locator. Retained final screens may close through a verified live-host shutdown, but an offline private server must first be reopened and cleanly stopped with its owning version. Stop/finish work first; explicit `stop` stops this service and its workers. Before activation or rollback, the stopped service's SQLite files are copied into a private timestamped `backups` directory beneath app data. The locator token is read only for authenticated local health checks and is never printed. Startup failure switches code back to the prior release when one exists. Rollback changes code, preserves current user data, and keeps a backup; it does not silently restore an old database over newly accepted work. A schema incompatibility requires explicit data recovery from the retained backup.

Uninstall disables/removes only this app's user service. It preserves app data, native OMP files, releases and private logs so recovery remains possible. macOS logs are under `~/.local/share/agent-desktop-host/logs`; Linux logs use the user's journal for this unit. Do not print raw account configuration or service environments while diagnosing.

`--root /absolute/directory` and `--data-dir /absolute/directory` support isolated installation checks; use the same overrides for later management commands. Do not point installation directories at repositories or at native OMP configuration.

## Validation status

Release **`spike-2026-09-05-9`** is installed on all three selected hosts. The immutable archive is `dist/host/agent-desktop-host-spike-2026-09-05-9.tar.gz`, SHA-256 `b601142b3fa91749d07175aaa407153253524b4c8a455241e794e0b958c0dea8`. It contains 89 source files plus verified private tmux 3.7c bundles for `darwin-arm64` and `linux-x64`; no system tmux fallback or user tmux configuration is used. Build pins and platform limits are in [tmux-bundle.md](tmux-bundle.md).

| Target | Installed release 9 owner | Preserved host ID |
| --- | --- | --- |
| Home | Packaged desktop's bundled host, acceptance profile | `47d53dc6-624a-4339-a277-1c664089f077` |
| `twaldin@twaldin-work` | launchd user service | `50cbb573-3b29-4674-96e6-35712501837f` |
| `tim@deckbox` | systemd user service | `5c5b327b-e25c-45c6-8648-b08f5c5bd795` |

Work and Deckbox completed guarded **8→9** upgrades. Archive/sidecar, every installed source hash, bundled Bun 1.3.14, native imports, the actual platform tmux executable, managed PID and authenticated capabilities/settings/model-definition/theme routes passed verification. Both expose all 484 settings. Later checks retained their new PIDs, with one launchd run and zero systemd automatic restarts. No active-work guard was bypassed.

Private SQLite backups passed `quick_check` and matched pre-upgrade catalogs/drafts. Work's populated four-message native history retained its exact original bytes; graceful shutdown appended only one verified `session_exit` metadata record. Deckbox's saved draft was unchanged, but it had no native history to test. Home's packaged upgrade also preserved catalogs/drafts and all original native bytes; one open session appended the same native exit metadata. An initial strict whole-file comparison caught these appends; they were checked explicitly rather than ignored. Prior host PIDs exited, and Home needed no stale-locator recovery. Evidence: `.data/ui-acceptance/installed-hosts-release9.json` and `home-release9-preservation.json`.

The final release 9 source suite passed **283 tests / 22,816 assertions**, with one Linux-only parser check skipped on macOS; typecheck passed. Deckbox independently passed the real systemd configuration suite, **7 tests / 33 assertions**, against sources matching the installed archive. The release includes the worker's explicit disposal acknowledgement and bounded kill/reap behavior; the original lost-IPC-response trace is retained in `.data/ui-acceptance/release9-worker-disposal-before.json`.

Installed terminal interaction was verified separately on Home: GUI creation and Unicode I/O, closing/reopening the UI while the same host/shell survived, authenticated Work input with duplicate receipts, visible restored output, an explicit shared-grid resize and natural exit with readable retained history. See `.data/ui-acceptance/release9-installed-terminal.json` and `release9-work-to-home-terminal.json`. This is the new `/v2` native `tmux-v1` path. Earlier `/v1` Bun PTY checks establish byte/stream behavior, not current fullscreen restoration. The 81 installed captures in `.data/visual-captures-release9/manifest.json` retain artifact fingerprints and readiness; narrow terminal views scroll the actual full grid. The remote installation checks themselves created no terminal panes; Work's graphical desktop and Deckbox's installed interactive terminal remain separate acceptance items.

### Earlier rollback and retained failure lessons

The last completed physical rollback cycle was **7→6→7** on Work and Deckbox, recorded in `.data/ui-acceptance/installed-hosts-release7.json`. Both retained host identities, exact saved-draft fingerprints, verified installed sources/runtime and valid private backups; those catalogs then had no native sessions. Release 9 has upgrade evidence, not a new rollback cycle. Uninstall has not been exercised on these physical hosts.

Earlier physical failures established requirements still enforced by the installer: systemd path quoting must use its own syntax; asynchronous launchd unload must finish before replacement; production JSON catalogs must be packaged and the installed host imported before activation. Native signal handling must own cleanup registration to avoid racing an independent exit listener. A stale locator may be archived only after its PID is dead and its ownership lease is reacquired. Those failed artifacts and diagnostics remain private evidence.

Installation success is not provider/sign-in acceptance or full UI parity. Native server recovery after direct host-process death also differs from systemd killing its whole service group: if the owning tmux server is lost, sessions become interrupted with saved history. Physical Work desktop, Applications installation, release 9 native-generation rollback/recovery and broader reference/user acceptance remain open; source changes for the next release are not present merely because their tests pass.
