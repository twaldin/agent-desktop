# Native plugin reload App acceptance

This controlled runner starts the production StrictMode App, authenticated disposable host and real native worker with isolated user and project plugin registries. It submits `/reload-plugins` and explicit `/plugins enable|disable` commands through the real composer, checks durable transcript output and registry state, restarts the host, and confirms cold catalog agreement. No marketplace acquisition, provider, account, retained profile or external network is used.

Run with a new evidence directory:

```sh
bun scripts/acceptance/plugin-reload-app/run.ts .data/plugin-reload-app-001
```
