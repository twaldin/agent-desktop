# Releases

The canonical public repository is [twaldin/agent-desktop](https://github.com/twaldin/agent-desktop). Its original local history is preserved without squashing or rewriting.

With native CI enabled, every successful push to `main` creates an immutable `dev-<commit>` prerelease. Pull requests run the same checks and packaging without publishing. A `v*` tag creates a named milestone prerelease; all releases remain prereleases while the full acceptance contract is incomplete.

The GitHub Actions workflow installs the checked-in lockfile with Bun 1.3.14, typechecks the owned source, builds the pinned terminal runtime on macOS ARM64 and Linux x64, and runs the owned test suites. It then packages a macOS ARM64 desktop and a host archive containing both terminal runtimes. Failed checks prevent publication; private `.data` capsules never supply CI inputs.

Public CI uses portable fixtures for the static upstream comparison tools. The separately named `bun run test:reference` suite retains the exact private `.reference` archive assertions and requires those original local captures. It is not run or credited by public CI; those reference-acceptance checks remain separate from release readiness. No reference application archive is published with this repository.

Those native build jobs are gated by `ENABLE_NATIVE_RELEASE_BUILDS=true`, explicitly authorized by Tim on September 11. If disabled, the pipeline performs source archival only and publishes clearly labeled source-only prereleases. It does not claim those releases passed native build or test checks.

Successful native builds include the desktop ZIP, host archive, build commit metadata and SHA256SUMS. Source archives have separate SOURCE-SHA256SUMS. The desktop is ad-hoc signed, not notarized. Packaging does not constitute physical-device, provider, native-browser, visual parity or full-GOAL acceptance. See [status](status.md).

Host artifacts declare support through state schema 28, including existing Goal drafts and durable Processes operation receipts. The installer keeps its strict compatibility guard: unknown newer state is refused without downgrade or restore. Older immutable artifacts retain their original declarations; publishing a correction does not rewrite them.

## Current named milestone

[v0.1.0-alpha.2](https://github.com/twaldin/agent-desktop/releases/tag/v0.1.0-alpha.2) points to `9208455`. Both platform suites, desktop/host packaging and packaged startup checks passed. The earlier failed `v0.1.0-alpha.1` remains unchanged.

## Publish a milestone

After reviewing and validating the milestone, commit the intended changes and push `main`. Tim has authorized milestone commits and pushes. Preserve Git author configuration, existing history and unrelated working changes; never force-push or include private evidence.

For a named milestone:

```sh
git tag -a v0.1.0-alpha.3 -m "Describe the completed milestone"
git push origin main v0.1.0-alpha.3
```

Use a new version for each milestone. Tags must point to commits in `main`. With native CI enabled, the workflow publishes only after checks pass. Interrupted uploads resume through a draft; existing tags and asset bytes are verified and never silently replaced. GitHub source archives remain available alongside built assets.

## Scope of release automation

CI runs in disposable GitHub-hosted machines. It does not alter retained desktop/host installations or use personal provider credentials. Tim also authorized installation and runtime testing on Home and Work; those checks use isolated candidate locations and preserve existing retained instances. Execution authorization is separate from passing the project's native and physical acceptance gates.

Development packages preserve upstream OMP and dependency notices. Codex is an OpenAI product; this independent project does not ship the private reference application or its captured assets.
