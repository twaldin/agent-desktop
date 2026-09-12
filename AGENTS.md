# Agent Desktop working rules

Follow `GOAL.md` and the agreed decisions in `docs/discovery.md`. This is an independent desktop recreation powered by OMP; a source checkpoint does not establish native, installed, physical or full parity acceptance.

## Git and releases

- The public repository is `twaldin/agent-desktop`. Use the authenticated `twaldin` GitHub account and preserve the configured Git author identity.
- Preserve local commit history. Do not squash, rebase published history or force-push without an explicit request.
- Tim authorizes committing and pushing completed milestones. Keep commits coherent, preserve unrelated work, and check staged content for credentials/private evidence before every push.
- Push completed milestones to the repository; the release workflow creates an immutable development prerelease for each successful `main` commit. Version tags `v*` create named milestone prereleases after the same checks pass.
- Keep `.data`, `.reference`, credentials, installed dependencies and personal runtime state private. Do not force-add ignored evidence or vendor reference bundles.
- Do not describe an unsigned or unverified build as stable. Keep release notes explicit about failed or missing acceptance gates.
- Tim explicitly authorized CI dependency installation, builds and tests, and installation/runtime testing on Home and Work on September 11. Use isolated candidate app/data directories and preserve existing retained instances and recovery paths. This authorization does not claim native or physical acceptance has passed.
- Native CI jobs require `ENABLE_NATIVE_RELEASE_BUILDS=true`; Tim has authorized enabling it. Disabling it intentionally produces source-only prereleases, which must be labeled accurately.

## Implementation

- Choose the simplest complete design and reuse existing code and platform features.
- Preserve original frozen review evidence and rejected verdicts. Corrections have their own exact scope and review evidence.
- Run relevant controlled tests and required checks. Never conceal a failing check, substitute private `.data` inputs into a clean build, or claim a skipped test passed.
- Use harness-native agents for concrete independent work, with clear file ownership and authored-versus-independent-review attribution.
- Delegate routine builds, CI monitoring and straightforward build fixes to Luna or Sol, as Tim requested. Keep independent reviewer family/model requirements unchanged.
- Regenerate dependency patches against their pinned published package and verify clean installation; follow `patches/README.md` rather than accumulating unchecked overlapping installer patches.
- For future unfrozen work, use manageable feature batches that complete a concrete user flow. Define acceptance cases and dependencies, then obtain separate independent Standards/Spec reviews. Root owns integration; the supervisor owns review/evidence/publication. Pipeline the next disjoint implementation with frozen review work; do not restart or retroactively merge existing review pairs.
