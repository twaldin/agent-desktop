# Maintaining parity and OMP compatibility

Status: the user selected pinned tested versions, on-demand change reports and compatibility tests, followed by explicit update adoption. The static report CLI is implemented. Candidate execution, migration tests and adoption remain separate explicit steps. There is no recurring automation or update staging inside the app.

## Run the on-demand report

From the repository root:

```sh
bun scripts/upstream-report.ts --out .data/upstream-maintenance/check-2026-09-05
```

This creates private JSON and Markdown reports at the requested prefix, refusing to overwrite existing files. Without `--out`, the report goes to stdout; `--format json` selects machine-readable output. `--help` lists every option. No package script or dependency is required beyond the pinned Bun runtime.

The default installed reference is `/Applications/ChatGPT.app`, whose bundle identifies itself as `com.openai.codex`. Use `--codex-app /path/to/Codex.app` for another installed location. The tool reads the system plist parser's output and streams the archive hash; it does not open or control the app. It checks the preserved baseline's archive/source hashes before using them.

The report compares:

- Codex bundle identifier, version/build, Chromium version and minimum OS; whole `app.asar` hash; exact archive resource paths, sizes and declared integrity. Unpacked/native resources and member payload integrity are outside the archive-header check.
- Configured OMP dependency pins and Bun pin against the accepted baseline; actual resolved local package manifests; the Bun executable running the report. Resolving transitive OMP packages starts at the real coding-agent directory to avoid unrelated ancestor installations. This does not identify the runtime of an already running desktop or a remote host.
- The preserved OMP source manifest against actual installed settings, SDK, RPC, session, registry, extension and related source files. Where complete source bytes match, the preserved descriptors remain source-supported. Thirteen provider interfaces are checked as exact complete declaration snippets because their full source blobs were not preserved. Missing or changed source prevents a descriptor-agreement claim.

Checks have four statuses: `unchanged` within their stated scope; `changed` requiring review; `unknown` for unavailable/unperformed checks; and `invalid` for malformed inputs, inconsistent attribution or failed baseline/source integrity. Exit **0** means no observed drift, even when unknowns remain; **2** means observed drift; **1** means an invalid check or input. These are evidence statuses, not a compatibility or parity certification. Individual files are checked for changes during reading; the report is not an atomic snapshot of an updater changing multiple files.

## Compare explicit candidate evidence

Candidates must already exist locally. The tool never downloads, installs, imports, runs an extractor from, or executes them.

```sh
bun scripts/upstream-report.ts \
  --codex-candidate /absolute/candidate-reference \
  --omp-candidate-inventory /absolute/candidate-inventories \
  --omp-candidate-package /absolute/unpacked-coding-agent-package \
  --out .data/upstream-maintenance/candidate-review
```

All candidate options are independent and optional:

| Input | Expected evidence and comparison |
| --- | --- |
| `--codex-candidate` | A separate `.app`, or a directory containing any of `reference-metadata.json`, `app.asar`, `visual-token-inventory.json`, `theme-defaults.json`. JSON shapes match the pinned `.reference/codex-26.901.41600` files. Absent artifacts remain unknown. Metadata/inventory version and build contradictions are invalid. |
| `--omp-candidate-inventory` | `settings-inventory.json`, `model-capabilities-inventory.json`, `provider-options-inventory.json`, in the preserved release format. Optional `source-manifest.json` and `sources/` copies allow digest and commit-consistency checks. Missing individual inventories remain unknown; duplicate identities and malformed structures are rejected. |
| `--omp-candidate-package` | An already unpacked `@oh-my-pi/pi-coding-agent` package containing `package.json` and published source paths. The tool compares version/source bytes and never resolves or installs its dependencies. Supply separate descriptor inventories for meaningful field deltas. |

JSON deltas retain added/removed/changed identities, before/after facets, exact input hashes, JSON pointers, native source URLs and line numbers. Setting comparisons include types, default expressions/literals, enums, credential/UI metadata and complete descriptor expressions. Model/provider comparisons include fields, optionality, full interface declarations and configuration-schema expressions. A full declaration change can be a comment or formatting change; the tool does not evaluate TypeScript, resolve inheritance/type aliases, or infer runtime guards.

CSS comparisons retain duplicate declarations, source filenames, per-file order, selector ancestry and at-rules; fonts and shipped appearance defaults remain separate entries. Hashed filename changes can create resource additions/removals and token declaration changes. Values remain unresolved CSS, and default expressions remain shipped declarations. Candidate manifests/inventories are self-declared evidence; matching copies do not authenticate their provenance or prove that a separately supplied package generated them.

## Validation checkpoint

The 2026-09-05 read-only local report found **41 unchanged, 0 changed, 6 unknown, 0 invalid** checks: Codex 26.901.41600/build 7982 still matches the pinned archive hash, six resolved OMP packages report 18.1.10, and the report runs under Bun 1.3.14. Private evidence is `.data/upstream-maintenance/local-final-2026-09-05.json` and its Markdown counterpart. The six unknowns are new visual/default extraction, an independently accepted lockfile digest, unavailable packaged `docs/sdk.md`, runtime/migration compatibility, and live reference behavior. No account, provider, machine configuration or installed application was changed. The separate CLI run against the preserved main snapshot produced one changed setting and exit 2; evidence is `.data/upstream-maintenance/preserved-main-2026-09-05.json`.

`bun test scripts/upstream-report.test.ts` covers the real 484→485 preserved release/main setting delta (`retry.waitForUsageReset`, default `false`), unchanged real model/provider inventories, real pinned archive/header reads, deliberate type/default/optional/configuration/cascade/font changes, malformed/duplicate inputs, failed candidate source integrity, inventory-only input and a candidate executable that must never run. These static/fixture checks do not replace real candidate runtime or provider acceptance.

## Keep a reproducible working baseline

- Pin the Codex reference version, build and archive hash. Preserve local reference evidence independently of the installed app's updates; keep packaged reference material out of application source and distributable output.
- Pin the OMP package and runtime versions. The initial examined pair is OMP 18.1.10 and Bun 1.3.14.
- Maintain separate records for reference behavior, implementation coverage, test evidence, and intentional changes such as OMP controls and cross-device drafts. Unknown or untested behavior remains visible.
- Record source provenance for visual tokens, icons, typography, menus and state transitions. CSS selector order and platform overrides must survive extraction.
- For private dependency builds, capture package manifests and issuer-specific dependency links alongside source files. Check successful resolution traces as well as `listFiles`: TypeScript can deduplicate an externally resolved package and hide that lookup from the listed file set. Verify the staged graph from a directory outside the repository before calling it relocatable; source compilation remains separate from dependency adoption and installed-runtime acceptance.

## Review a Codex update

1. Identify and preserve the new reference's version and hash without replacing the working baseline.
2. Compare resource, visual-token, settings and feature/state inventories. Treat static changes as leads for inspection, not proof of visible behavior.
3. Obtain reference evidence for changed screens and interactions through permitted routes. Current computer-use tooling refuses live access to Codex; that limitation must remain explicit until a permitted route or user-provided evidence is available.
4. Review every changed area as an intentional exclusion, required parity change, or unresolved item. Existing accepted OMP additions cannot excuse unrelated regressions.
5. Update implementation and rerun the affected visual and behavioral tests. Retain the old reference until the new baseline is accepted.

## Review an OMP update

1. Stage the candidate separately from the working installation.
2. Compare SDK/RPC exports and events, settings descriptors, model capability metadata, login callbacks, session format, account/broker behavior, permissions and extension interactions.
3. Require every added or changed setting/capability to have an explicit native UI mapping and validation. Record applicability accurately; do not silently hide new fields or present ignored controls as supported.
4. Run focused integration contracts against the real candidate runtime: persistence/resume, streaming/cancellation, pending questions and approvals, concurrent sessions, login callback types, account selection, tool execution and imports. Test doubles can exercise failure paths but are labeled and do not count as real provider acceptance.
5. Exercise migration against copies of representative data, preserve unknown configuration fields, and verify rollback before changing existing user data. Credentials and host-specific execution configuration retain their native OMP ownership.
6. Run the cross-device smoke flow and real account flows available for validation; record any provider flow that remains unverified.
7. Adopt the candidate explicitly and retain a recoverable prior version/data snapshot. Never let a dependency install silently move the tested runtime version.

## Keep the scope small

Start with a repeatable check/report/upgrade procedure and focused compatibility tests. Do not build a general plugin compatibility framework, distributed release service, or speculative multi-harness abstraction. Add automation only when its intended behavior and maintenance value are established.
