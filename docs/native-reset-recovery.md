# Native reset completion recovery

An automatic reset is admitted durably before native consumption. If the host restarts while the original worker is still running, the account stays `unknown` and cannot be replayed. A result arriving later may explain the observed outcome; it does not restore admission authority.

`NativeResetPolicy.reconcileCompletion` accepts an original executor result against the retained automatic attempt and its origin pass checkpoint. It verifies the worker epoch, root and native session IDs, pass, report revision, account and original redeem request. The recovered worker owner additionally checks the original root session file, cwd and complete permit. The worker connection must be authenticated and rebound to its saved original identity before constructing an owner with `context.recovered: true`; packet fields cannot grant that flag.

Reconciliation writes the sanitized observation and pass checkpoint in one store transaction. It keeps the original unknown reason and account fence, reconstructs no promise, and permits only identical retries. A conflicting result or a result after a recorded physical worker exit rejects. A failed write rolls back both records so the original result can be retried. Current live callbacks still use the existing settlement path.

The new host primitive and owner flag do not establish reconnect authentication, child quiescence, resource preservation or fresh-pass admission. Those require the separate worker reconnect and server integration. Controlled tests use actual temporary SQLite stores, close/reopen them and exercise the real owner; they do not consume provider credits or claim physical host recovery.
