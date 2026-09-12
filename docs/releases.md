# Releases

The canonical public repository is [twaldin/agent-desktop](https://github.com/twaldin/agent-desktop). Its original local history is preserved without squashing or rewriting.

Every successful push to `main` creates an immutable `dev-<commit>` prerelease. Pull requests run the same checks and packaging without publishing. A `v*` tag creates a named milestone prerelease; all releases remain prereleases while the full acceptance contract is incomplete.

The GitHub Actions workflow installs the checked-in lockfile with Bun 1.3.14, typechecks the owned source, builds the pinned terminal runtime on macOS ARM64 and Linux x64, and runs the owned test suites. It then packages a macOS ARM64 desktop and a host archive containing both terminal runtimes. Failed checks prevent publication; private `.data` capsules never supply CI inputs.

Those native build jobs are gated by the repository variable `ENABLE_NATIVE_RELEASE_BUILDS=true`. Until explicitly authorized, the pipeline publishes source-only prereleases and clearly labels them as such. This gate preserves the existing runtime/install hold; it must not be bypassed to claim a successful binary release.

Downloads include the desktop ZIP, host archive, build commit metadata and SHA256SUMS. The desktop is ad-hoc signed, not notarized. Packaging does not constitute physical-device, provider, native-browser, visual parity or full-GOAL acceptance. See [status](status.md).

## Publish a milestone

After reviewing and validating the milestone, commit the intended changes and push `main`. Tim has authorized milestone commits and pushes. Preserve Git author configuration, existing history and unrelated working changes; never force-push or include private evidence.

For a named milestone:

```sh
git tag -a v0.1.0-alpha.2 -m "Describe the completed milestone"
git push origin main v0.1.0-alpha.2
```

Use a new version for each milestone. Tags must point to commits in `main`. The workflow publishes only after checks pass and never replaces existing release assets. GitHub source archives remain available alongside built assets.

## Scope of release automation

CI runs in disposable GitHub-hosted machines. It does not alter retained desktop/host installations, use personal provider credentials, or authorize real browser sessions. Project-wide native and physical acceptance holds continue until separately resolved.

Development packages preserve upstream OMP and dependency notices. Codex is an OpenAI product; this independent project does not ship the private reference application or its captured assets.
