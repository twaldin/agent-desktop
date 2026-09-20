# Native context-maintenance App acceptance

This author acceptance runner starts the production StrictMode renderer, Electron main process, authenticated disposable host, worker, and pinned native SDK. A loopback-only controlled provider supplies compaction responses; disposable native history is seeded through `SessionManager` while the host is stopped.

It covers persisted `/shake` output across a cold host/App reopen, visible compaction provider failure, stopping a held soft compaction through the production Stop control, worker settlement, and a subsequent prompt. Synthetic Electron input is used and does not establish physical-input or reference-UI parity.

Run with a new evidence directory:

```sh
bun scripts/acceptance/context-maintenance-app/run.ts .data/context-maintenance-app-001
```
