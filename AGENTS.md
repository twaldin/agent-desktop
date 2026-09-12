# Agent Desktop working rules

Follow `GOAL.md` and the agreed decisions in `docs/discovery.md`. This is an independent desktop recreation powered by OMP; a source checkpoint does not establish native, installed, physical or full parity acceptance.

## Git and releases

- The public repository is `twaldin/agent-desktop`. Use the authenticated `twaldin` GitHub account and preserve the configured Git author identity.
- Preserve local commit history. Do not squash, rebase published history or force-push without an explicit request.
- Tim authorizes committing and pushing completed milestones. Keep commits coherent, preserve unrelated work, and check staged content for credentials/private evidence before every push.
- Push completed milestones to the repository; the release workflow creates an immutable development prerelease for each successful `main` commit. Version tags `v*` create named milestone prereleases after the same checks pass.
- Keep `.data`, `.reference`, credentials, installed dependencies and personal runtime state private. Do not force-add ignored evidence or vendor reference bundles.
- Do not describe an unsigned or unverified build as stable. Keep release notes explicit about failed or missing acceptance gates.
- CI packaging runs in disposable GitHub runners. It does not authorize installation, launch, provider use or changes to retained user instances. Existing physical/native acceptance holds remain in force.
- Native CI jobs require the repository variable `ENABLE_NATIVE_RELEASE_BUILDS=true`, enabled only after explicit authorization. Until then, releases contain public source archives only.

## Implementation

- Choose the simplest complete design and reuse existing code and platform features.
- Preserve original frozen review evidence and rejected verdicts. Corrections have their own exact scope and review evidence.
- Run relevant controlled tests and required checks. Never conceal a failing check, substitute private `.data` inputs into a clean build, or claim a skipped test passed.
- Use harness-native agents for concrete independent work, with clear file ownership and authored-versus-independent-review attribution.
- For future unfrozen work, use manageable feature batches that complete a concrete user flow. Define acceptance cases and dependencies, then obtain separate independent Standards/Spec reviews. Root owns integration; the supervisor owns review/evidence/publication. Pipeline the next disjoint implementation with frozen review work; do not restart or retroactively merge existing review pairs.
