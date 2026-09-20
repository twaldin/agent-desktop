# DAP configuration inspector

The fragment adds read-only `inspectAdapterConfigs(cwd, roots?, replacement?)` to the pinned coding-agent `src/dap/config.ts` and its matching public declaration. It reuses native normalization, merging, built-ins and command resolution. Source metadata, ignored invalid overrides and accepted field/default-key provenance support the desktop editor. Explicit roots avoid rebinding native preloaded roots. A replacement previews one admitted source without writing or launching anything.

`apply.py <owned-accepted-package-copy>` applies only these two files on the accepted package. Never run it on shared installed dependencies. `produce.ts` delegates to the existing full-package producer:

```sh
bun patches/omp-18.1.10/dap-inspection/produce.ts <published-package> <accepted-package> <authored-package> <net-patch-output> <private-evidence-output>
```

First verify the exact published 18.1.10 archive against the frozen lock SRI and reconstruct the accepted baseline with its complete patch. Compare every baseline member, byte and mode. The caller must verify that only DAP source/declaration differ with full before/after manifests. The producer regenerates the full net patch with the existing paired nested-file mode encoding. Fresh frozen installation must match the entire intended package, including directories and CLI 0755; exclude only the documented Bun marker. Preserve the actual producer, argv, stdout/stderr, status and maps. The current implementation leaves LSP and every other native fragment unchanged.

The inspector bounds reads to regular files of at most 1 MiB, reports incomplete inspection errors, and does not change the original native loader. It follows symlinks to observe native effective values; mutation admission is independently restricted to local canonical sources by the host. Inspection does not initialize a DebugTool, adapter or session.
