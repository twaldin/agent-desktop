# Managed OMP runtime

Normal app and interactive OMP configuration remain unchanged. A managed caller may opt out of automatic dotenv reads by setting `PI_DISABLE_DOTENV=1` before any SDK import and launching Bun with `--no-env-file`. Both are needed: Bun loads files before JavaScript, and pinned OMP normally has its own eager loader. The app-owned pi-utils18.1.10 patch also honors Bun's flag. Explicit `parseEnvFile` remains available.

Workers receive the explicit selected agent directory before import. A managed desktop launch passes the Bun flag through when the environment opt-in is present. These changes do not create or select a shared managed profile, modify authentication, or scrub explicitly supplied ticket/provider environment variables. Callers launching the host programmatically must establish the opt-in before starting that process, not inside `startHost` after imports. Normal host service definitions are not silently converted to managed profiles.

## CLI artifact

Build on the target platform with Bun1.3.14:

```
bun --no-env-file scripts/package-managed-omp.ts /absolute/new/runtime managed-18.1.10-VERSION
```

The output is a new, uninstalled directory. It contains its own Bun, frozen production dependencies with both native patches, and `bin/omp`. A sibling receipt hashes regular files and records symlink targets. The builder refuses an existing output directory and uses dependency copies rather than cache hardlinks. macOS ARM and Linux x64 each need their own target build and verification; a macOS executable is not a Linux artifact.

Set `PI_CODING_AGENT_DIR` to an explicit absolute managed profile path before invoking `bin/omp`. The wrapper preserves real HOME and the supplied environment, puts its own bin first on PATH, sets `PI_SUBPROCESS_CMD` to itself, and invokes its own Bun with both dotenv controls. It validates owned package locations and exact versions before importing native CLI code. Missing dependencies never fall back to personal OMP. Profile contents/auth ownership and dispatch authorization remain the caller's responsibility.

The entry uses `pi-coding-agent/src/cli.ts`. Published `dist/cli.js` embeds an old pi-utils implementation and would miss a dependency-source patch. The wrapper calls native `runCli`; it does not emulate lifecycle or tool execution. Worker-thread CLI dispatch remains native.

## Model policy boundary

Composer and session controls use native non-persistent model/thinking changes. They persist conversation history and host session metadata, so reopening that conversation restores its choices. They do not update global/project `modelRoles` or `defaultThinkingLevel`; those remain deliberate NativeSettings writes. A native lifecycle regression selects another model/effort, reopens it, verifies a fresh session still uses project defaults, and checks both config files byte-for-byte. There is no invented `modelRoleStorage=session` value.

## Python and selected-account CLI commands

The launch environment is not a promise that every native tool inherits every variable. Pinned OMP's Python runtime applies its own allowlist: it retains `PI_` variables but excludes `GH_TOKEN` and `OMP_TICKET_*`. A CLI invoked inside Python can therefore use its machine-local default account instead of the launch-selected account. Use native Bash for authenticated CLI and ticket-control commands, and verify the selected identity there. Preserve the Python filter; do not copy credentials into the kernel to hide this distinction.

The coordinating managed-runtime task reproduced this with a fresh owned Python kernel and direct CLI under the same selected launch environment: the identities differed and Python lacked both selected GitHub and ticket variables, while the managed profile variable remained correct. This is coordinator-reported runtime evidence, corroborated by the pinned `eval/py/runtime.ts` source; this app task did not repeat an authenticated identity call or inspect credentials. No stale-kernel reuse is needed to explain that result. Runtime code and managed artifacts remain unchanged.

## Evidence limits

The initial isolated checks cover CLI version, patched SDK loading, helper command resolution, worker discovery and native model lifecycle without provider calls. They do not prove interactive terminal behavior, live managed reviews, installed desktop/main behavior or cross-platform deployment. Existing personal accounts/configuration and previously frozen runs remain untouched.
