# Running the complete test inventory

Use `bun run test`. Bare `bun test` bypasses the package script and uses Bun's repository discovery, which currently triggers the native-worker failure described below.

```sh
bun run test --list
bun run test
bun run test apps/host/src/server.test.ts -- -t 'legacy clients cannot strip'
bun run test -- --timeout=60000
```

`scripts/test.ts` discovers `.test.ts` **and `.test.tsx`** suites under `apps`, `packages` and `scripts`, sorts the complete list, and supplies absolute file paths to the pinned Bun executable. Native `Bun.Glob` enumerates one directory level at a time; dependency, fixture, private, dot and symlink directories are pruned before traversal. Exact optional file selections must belong to that inventory. Filename filters, missing files and duplicate selections are errors. Ordinary `bun test` flags are validated and forwarded as argv, including name patterns; no shell evaluates them. Optional flag values use `--flag=value`. An empty inventory cannot fall back to repository discovery.

## Verified runtime condition

On macOS arm64 with Bun **1.3.14** and OMP **18.1.10**, the same isolated server test consistently failed when its filename was passed as a search filter and passed with an explicit `./` path. All 35 HTTP assertions passed in the failing run; teardown then reported a child exit before its disposal acknowledgement. Captured child stderr was `warn: Unable to start IPC socket`. The child loaded its entry module, found no connected daemon when sending `ready`, and failed closed. Diagnostic descriptor metadata showed fd 3 was a FIFO in the failed child and a socket in the successful child. [Bun's warning site](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/VirtualMachine.zig#L4017) is failure to adopt the inherited IPC descriptor.

The smaller reproduction imports the native SDK and launches a plain advanced-IPC Bun child; it does not import the host or worker adapter. The repository-search form exits 1 without a ready message, while the explicit-file form exits 0 with the actual ready message. Plain Bun IPC without the SDK import passed both forms. Native test/headless detection was true in both, and setting the explicit native test marker did not resolve the failure.

This establishes a launch condition and a reliable explicit-file invocation. **The underlying reason the descriptor is lost is still unresolved.** No application shutdown, acknowledgement, timeout, retry, native dependency or installed runtime behavior was weakened to make tests pass. Linux reproduction is not claimed.

## Evidence and coverage

The first inventory comparison loaded the same **76 suite files** in both runners: 72 `.test.ts` and four `.test.tsx`. Both inventory-only runs used a never-matching name pattern and reported the same 16 conditional skips. This checked file inclusion without claiming that the full tests had executed. The package runner then passed the original focused server case (1 test, 35 assertions), and isolated runner checks passed directory pruning, exact file selection and argv handling (2 tests, 10 assertions). Full native-enabled regression follows the normal source-freeze gate.

Private evidence lives in `.data/worker-runner-inventory-comparison.json`, `.data/worker-runner-focused-green.log`, `.data/worker-runner-contract.log`, and `.data/worker-fast-stop-stderr-red.log`. The application-free source and red/green output are in `.data/worker-ipc-differential-H2wlEz`; `.data/worker-ipc-differential.ts` recreates it using an isolated native profile, removes its temporary root test file, and retains the result under a fresh private directory. Diagnostic preload/wrapper files remain private and are never loaded by the package runner.
# Clean installation inputs

Typechecking pins `@types/node` to 24.13.3 for Bun and Electron. Without this direct dependency and override, a checkout under a home directory could inherit an unrelated ancestor installation while a clean stage loaded conflicting Node declarations. Verify in a fresh directory outside that ancestor tree when changing dependency resolution.

The complete suite also reads the private preserved `.reference` inventories and archive. A source-only Git archive omits these inputs; make them available read-only to the isolated test stage. Missing reference files are failed test setup, not skipped parity evidence. Tests that mutate inventory fixtures use separate temporary copies.
