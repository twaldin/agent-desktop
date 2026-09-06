# Native Plugins and MCP configuration

The desktop reads the owning host’s pinned OMP plugin and MCP registries through its separate discovery worker. Settings writes use native configuration APIs and formats; they do not invoke a global OMP binary, start an agent session, connect an MCP server, or enter the session command journal. The executable/runtime pin remains OMP 18.1.10 and Bun 1.3.14. Native profile/account ownership is unchanged.

Plugins include user and project packages, linked installs and marketplace entries, disabled entries, project shadowing and project overrides. User settings expose the native typed schema, declared features and defaults. Secret settings return only whether a value is configured; replacement and reset are explicit. Project settings/features without a safe native scoped writer are visible but read-only, rather than writing a same-name user plugin. Marketplace enable changes target the selected registry scope.

MCP configuration includes disabled and shadowed discovery sources, plus native saved allow/deny overrides. The UI can add a native user/project server, toggle it, or remove a server from an OMP-owned configuration file. Third-party configurations remain unchanged; their toggles use native user allow/deny overrides. Commands, environment values, headers and authentication fields are not returned in catalog responses. Advanced add settings accept the native configuration object; the selected command/transport fields take precedence.

The HTTP routes accept existing catalog project/session IDs, never arbitrary filesystem paths. Mutations require an opaque revision, recheck current configuration under native advisory locks, and reject stale requests. Configuration reads are bounded, nonblocking descriptor reads; malformed files, final-component links, nonregular files and unstable reads fail closed. Installed package-directory links remain supported. Native processes that ignore advisory locks can still race native non-atomic plugin writes; this adapter does not claim a filesystem transaction across all external OMP processes. Multi-file MCP enable changes likewise use separate native atomic file replacements, not a cross-file transaction. After an interrupted save, reload and inspect the actual state before making another change.

## Current scope and limits

These are saved-configuration controls. Changes apply to new sessions. The UI does not claim existing-session connection state or coordinated live reload. Plugin install/uninstall, marketplace acquisition, native live reload, MCP connection/OAuth flows and session resource/tool inspection remain part of the broader milestone. Native slash commands for those workflows remain unavailable until their execution and lifecycle contracts are implemented; opening a settings page does not count as executing them.

The renderer uses the reference’s centered Plugins settings canvas, tabs/search, list/detail navigation and a separate MCP-add view. OMP scope and schema controls differ where required. The captured reference includes more tabs, argument/environment row editors, native artwork and additional detail states. Those remaining differences are not pixel-parity passes.

## Validation

Focused tests exercise actual pinned registry files and discovery workers, including masked secrets, project/user ownership, disabled/shadowed entries, stale concurrent writes, malformed configuration, FIFO/link refusal and HTTP input validation. No provider or MCP connection is required for these tests.

`scripts/acceptance/integrations.ts` renders the production settings components in a hidden, sandboxed Electron window against a disposable real OMP discovery worker through a capability-scoped HTTP bridge. It exercises explicit secret replacement, enum selection and MCP creation and saves screenshots and source hashes. It bypasses desktop main-process IPC and does not count as a packaged installation, native OS-window verification or matched Codex pixel comparison. The script’s private output records every assertion and failure; a source-only pass never supersedes frozen Work evidence.
