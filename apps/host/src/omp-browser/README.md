# Native browser viewport projection

`projectNativeBrowserFrame` is the worker-side boundary between pinned OMP browser capture and the shared browser-frame protocol. It accepts only the exact owner, tab name, and target ID requested by the worker operation. Native bytes must be a nonempty JPEG within the shared 8 MiB limit; dimensions are read from the JPEG header and the final object is passed through the shared parser before IPC.

The selected OMP patch captures the current viewport from the already-owned Puppeteer target. It does not create, activate, navigate, resize, or close a tab. The native capture rechecks the same owner and target after the screenshot. One capture may run per target, with at most eight distinct targets in flight. If a caller times out, its target remains counted until the underlying screenshot settles. cmux capture is explicitly unsupported until it has an equivalent owner-bound adapter.

This is a read-only snapshot. It does not expose browser handles or endpoints and does not provide navigation, input, streaming, or remote-control behavior.

## Original-owner observation

`WorkerBrowserObservations` loads the pinned native `inspectTabForOwner` only inside the existing worker. Both session and browser-only owners expose the same operation through worker protocol41. The daemon preserves worker PID and owner/name/target; the child copies the selector, checks the original owner object/id after module loading and native completion, and validates the native projection. Missing capability, invalid/foreign result or failed read is an error, never absence. Cmux is positive-only until its original-server absence authority is established.

At most eight distinct reads are retained, one per selected target. Loading and dispatched reads remain counted until settlement. Retirement suppresses held-import dispatch, drains already sent reads and exposes their operational errors; a successful read after retirement is rejected to the caller. Child disposal starts close and observation drains together and settles both before native owner/runtime cleanup. No extra IPC timeout releases the bound while native work continues. Existing process emergency exit remains a last-resort failure boundary, not successful drain proof.

This is an internal worker operation. No host HTTP/observer registration, historical recovery, native close event, UI deletion or new owner acquisition is authorized by it. Controlled class and selected parent/child tests do not establish worker/native IPC execution. Native capture identity/drain reviews remain separate prerequisites.
