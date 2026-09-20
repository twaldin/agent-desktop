# Durable browser-recovery endpoint identity

`HostStore.recordBrowserRecovery()` binds the validated reconnect endpoint recorded for each retained source and destination worker. Its durable identity includes the endpoint version, PID, instance ID, socket path, token, and the complete optional reset-policy tuple (`workerEpoch`, `rootSessionId`, `sessionFile`, and `cwd`).

An arming record may advance to ready only with equivalent endpoint identities. Reset-policy tuple object key order is irrelevant, while changing or removing a recorded tuple, or adding one to a recorded ownerless endpoint, is rejected. Legacy endpoints which remain ownerless continue to advance and reopen normally.

This Store check consumes the reconnect parser and equality supplied by the frozen worker-recovery dependency. It does not select an account, create an owner, reconnect a worker, reclaim owner capacity, or establish that a retained process is still alive.
