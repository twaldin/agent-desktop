# Native `/usage` command App acceptance

This controlled acceptance runner starts the production host, worker, Electron main process, and renderer with a disposable HOME, agent directory, project, native authentication database, and local-only provider transport. It exercises composer submission through the production App and native OMP `/usage` handler. The saved reset endpoint is a fixture and never reaches a provider or retained account.

The runner is author acceptance evidence. Its IPC adapter exposes the same production host transports used by the desktop preload; it is not physical keyboard or official-reference acceptance. Extension precedence is covered by focused production tests unless a controlled native extension is explicitly installed in this fixture.

Run with a new evidence directory:

```sh
bun scripts/acceptance/usage-command-app/run.ts .data/usage-command-app-001
```
