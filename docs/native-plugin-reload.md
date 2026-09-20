# Native plugin reload

Desktop sessions execute OMP's `/reload-plugins` command through the original native session. The command invalidates plugin-root and filesystem discovery caches for that session's working directory, refreshes task agents, skills, file slash commands and capabilities, then reconnects the session's MCP servers. The durable command receipt is written only after those steps finish.

`/plugins` and `/plugins list` inspect the configured user and project plugin registries. `/plugins enable <name@marketplace>` and `/plugins disable <name@marketplace>` update the selected native registry and run the same reload before reporting success. A registry write can complete before a later reload fails; the error is reported without claiming that the earlier mutation was rolled back.

Reload preserves the active session and its already-created extension runner. Extension factories, custom hooks, custom tools and custom command handlers therefore keep their current lifetime. Plugin-panel changes and newly discovered extension factories apply to new sessions. Existing extension or custom commands still take precedence over builtins with the same command name.

The desktop host runs this work against its isolated `agentDir` and the session's exact `cwd`. It rejects overlapping plugin reloads and reloads while prompts, interactions, queued messages, interrupts or other MCP mutations are active. Session disposal waits for an admitted reload before releasing the original native session.
