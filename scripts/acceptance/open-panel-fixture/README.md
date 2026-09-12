# Open panel acceptance

Run `bun scripts/acceptance/open-panel-fixture/run.ts .data/open-panel-run` from the repository. Add `--git` for the Review/order/singleton cases. Each output directory must be new.

The fixture mounts the production App in Electron, creates a disposable authenticated host and session, and uses the production WindowStateStore. Electron pointer and keyboard input exercises the empty launcher, shared menu glyphs, Files, Browser new-tab draft, Side chat draft, menu dismissal/focus, hide/reopen, Review in both regions, document reload, and the projectless unavailable state. Source fingerprints before/after, screenshots, geometry, IPC calls, failures, and cleanup outcomes remain in the requested output directory.

The IPC adapter is fixture-owned. Host reads and commands reach the real service; optional APIs remain absent. Terminal is intentionally unavailable without a configured terminal bridge. Browser URL submission and provider requests are not exercised; the native worker rejects provider fetches and the host permits only loopback fetch. This does not prove Electron production IPC, native browser/terminal behavior, external OAuth, MCP app/artifact producers, physical multi-host operation, or pixel parity. The candidate dependency installation must be qualified separately.

The host/profile/project are isolated and removed only after a clean host shutdown. Failed startup/cleanup directories are retained. Existing user instances and configuration are untouched.
