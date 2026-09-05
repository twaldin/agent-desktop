# Native browser viewport projection

`projectNativeBrowserFrame` is the worker-side boundary between pinned OMP browser capture and the shared browser-frame protocol. It accepts only the exact owner, tab name, and target ID requested by the worker operation. Native bytes must be a nonempty JPEG within the shared 8 MiB limit; dimensions are read from the JPEG header and the final object is passed through the shared parser before IPC.

The selected OMP patch captures the current viewport from the already-owned Puppeteer target. It does not create, activate, navigate, resize, or close a tab. The native capture rechecks the same owner and target after the screenshot. One capture may run per target, with at most eight distinct targets in flight. If a caller times out, its target remains counted until the underlying screenshot settles. cmux capture is explicitly unsupported until it has an equivalent owner-bound adapter.

This is a read-only snapshot. It does not expose browser handles or endpoints and does not provide navigation, input, streaming, or remote-control behavior.
