# Native reset-policy Settings observation

`Settings.captureResetPolicySettingsObservation()` returns an opaque synchronous
continuity guard for one native reset-policy pass. The guard belongs to the exact
Settings instance, cwd, agent directory, and reset-policy writer captured at
construction. It rejects mutation and scope history even when values return to
their originals.

The one exception is the native session's exact
`set("codexResets.autoRedeem", "yes" | "no")`. One pass may adopt that operation
once, including a legitimate same-global-value write hidden by a higher layer.
Fake adoption, a second pass, extra operations, reloads, writer changes, and use
after disposal reject. The observation tracks loaded state; immutable persisted
readback remains responsible for current file and layer evidence.

This package does not enable automatic reset policy, consume credits, access a
provider, or wire the capability into a host context. Run the focused test with:

```sh
bun test patches/omp-18.1.10/settings-reset-policy-observation/reset-policy-observation.test.ts
```

`produce.py` regenerates the complete pinned `18.1.10` patch from the exact
published-package Git tree, the prior complete patch, and the authored Settings
source/declaration pair. Its paired-file list preserves Bun 1.3.14's required
nested-file mode encoding.
