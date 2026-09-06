# UI parity workflow

The supplied private reference bundle is the default visual and interaction baseline. Follow the project [verify-ui-parity skill](../.agents/skills/verify-ui-parity/SKILL.md), the bundle's reading guide and comparison rules. [GOAL.md](../GOAL.md) determines scope and the OMP-backed behavior.

Keep two linked inventories: scoped application surfaces and applicable OMP capabilities. For each surface, identify the real native state, operation and ownership that supplies its behavior. For each native capability, identify its functioning UI entry point. Similar labels or a successful screenshot do not prove this mapping.

## Private work ledger

Place source/reference audit findings in JSON arrays under a private audit directory. Each finding has `id`, `sections`, exact manifest `referenceIds`, `classification`, `summary`, `currentEvidence` (source paths and lines), `requiredBehavior`, `backendMapping`, `evidenceLevel` and `priority`.

Generate the complete capture and transition checklist:

```sh
bun scripts/parity/inventory.ts .data/codex-screenshots .data/parity-audit-2026-09-05
```

The script validates exact capture IDs, retains every reference record and uncaptured requirement, fingerprints input files, and writes `ledger.json` and `ledger.md` beside the findings. Other JSON evidence belongs in subdirectories; top-level JSON arrays are audit inputs. Outputs and reference contents must remain private under `.data/`.

The ledger deliberately does not calculate a parity score. A source finding only links a known gap; remaining details still need inspection. An excluded backend setting can coexist with an in-scope visual surface, so no whole screenshot is silently removed. Keep expected OMP differences narrow and reasoned.

## Closing a gap

Fix the state model or backend bridge before presenting a working control. Exercise the actual app at observed, matching geometry/theme/scale, save native window originals and accessibility snapshots, and compare the same state using the reference's per-file mappings and tolerances. Keep structural, interaction, layout and pixel findings separate. Preserve earlier failure evidence.

Controlled Electron component checks can catch layout and input regressions. Native OMP contract checks prove native behavior. Neither is a substitute for paired visual evidence, installed-artifact verification or physical multi-host acceptance. Keep those claims separate when recording progress.
