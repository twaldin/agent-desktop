---
name: verify-ui-parity
description: Verify agent-app UI parity with the Codex reference bundle. Use when verifying a Codex-parity implementation, reviewing a parity claim, or comparing real app screenshots against the captured baseline.
---

Parity is checked against the **real running app**, one scoped feature/state at a time, with the reference bundle as the visual oracle and `GOAL.md` as the spec. Tests, DOM dumps and source traces support a claim; only captures of the actual surface, exercised by hand and paired with the capture of the *same state*, prove it.

## Reference bundle

Resolve the bundle root in this order:

1. `.data/codex-screenshots/` under the repo root (the bundled copy; ignored, private).
2. The directory containing this skill's `.agents/` folder (the skill ships inside the bundle).

All paths below are relative to that root.

| File | Authoritative for |
| --- | --- |
| `INDEX.md` + `index.html` | Reading order and offline searchable gallery; displayed thumbnails are not measurement originals. |
| `CAPTURE-QUALITY-REVIEW.md` | The visual audit's actual scope, corrections and limits; not an exhaustive pixel certification. |
| `manifest.json` | The capture inventory: `id`, `title`, `navigation`, `notes`, `png`, `accessibility`, `width`/`height`, `capturedAt`; top level records the captured `version`/`build` and `windowLogical`. Read counts and ids at run time. Titles and notes were audited; an id slug may still name an *attempted* action, so trust title/notes, not the slug. |
| `NN-section/NN-name.png` + `.ax.txt` | Original capture bytes and the role/name accessibility tree at that instant. AX carries no bounds. PNG and AX are sequential, not atomic. |
| `capture-environment.json` | Verified display, window frames, union/downscale facts, fixtures created, end state, safety boundaries, uncaptured frontier. |
| `geometry-report.json` | Per-file record: IHDR, sha256, capture class, `mapping` (screen origin, `savedPxPerPt`, main-window block, crop), alpha/corner probes, calibration pair metrics. Read `files[].mapping` before touching any pixel coordinate. |
| `COMPARISON.md` | Coordinate spaces and affine mappings, registration constraints, per-class outlier treatment, workflow, metrics, tolerances, dynamic-region masks, boundary probing, pass/fail record shape. Follow its formulas; do not restate them. |
| `DESIGN-SYSTEM.md` + `design-measurements.json` | Tokens, surfaces, radii, typography with per-record evidence kind (`export`/`pixel`/`estimate`/`ax`). |
| `INTERACTIONS.md` + `interaction-states.json` | Which states exist, what moves between them, which are native facts versus backend-fed; per-state `compareWith` pairs and pointer bounds. |
| `COVERAGE.md`, `PUBLIC-COVERAGE-REVIEW.md` | Which surface/state families have evidence, which are partial, blocked or excluded, and the exact frontier. |
| `dark-theme-export.txt`, `light-theme-export.txt` | Exact theme strings at capture time. |
| `user-supplied/` | Four user originals with their own `manifest.json` and `source-machine-app.json`; evidence class U (below). |

Facts that bound every claim:

- **Build.** The helper captures are Codex **26.901.31953 / 7868**; the app pins **26.901.41600 / 7982**. No helper capture of 7982 exists. A difference may be upstream drift: classify it as expected only with evidence, otherwise as a mismatch. The user originals' source machine currently has 7982 installed, which corroborates them as 7982-era material but does not establish the running build at each original's capture instant.
- **Evidence classes** (as used in `INTERACTIONS.md`): **P** bundle capture, state visible in the PNG; **A** AX label only, not visually rendered; **U** user original, no AX, no frame geometry; **I** inference; **R** capture requirement with no evidence. A parity claim rests on P (or U for the badge combinations only U shows); A and I never prove appearance.
- **Geometry is per file.** Most captures are the exact 1440x1000 pt main frame at 2 px per pt; the rest are unions, separate windows, or helper-downscaled files with their own origin and scale (`geometry-report.json` `captureClasses` and `files[].mapping`, `COMPARISON.md` §2–4). There is no bundle-wide scale factor and no transcript preview is evidence.
- **Theme.** Dark unless the section is `13-light-theme/` or `notes` records a temporary preference.
- **Privacy.** Captures contain private chat, project, PR and account context. Screenshots, AX dumps, originals, candidate captures, reports and private excerpts stay inside the repo's ignored `.data/`; never copy them into tracked files or publish them. The generic project-local workflow skill is the deliberate exception: it may be tracked and contains no private capture excerpts.

## Spec first

`GOAL.md` decides what parity means. Before comparing anything, apply it:

- **Excluded surfaces are not targets.** A reference capture of an excluded surface is context, not a requirement.
- **OMP is the backend.** Provider, model, account, permission-mode and host labels come from OMP's registry and native configuration. Compare the control's structure, geometry and states; expect labels and lists to differ.
- **A matching screenshot proves appearance at one instant.** It proves nothing about the backend contract (session ownership, streaming, stop/steer, approvals, persistence, reconnection). Those gates carry their own acceptance evidence; a parity report that mentions them cites that evidence or marks them unverified.

## Workflow

Run the steps in order. Each ends on a criterion you can check; a step is not done until it holds.

### 1. Select the scope

Pick one feature or state family. From `COVERAGE.md`, `interaction-states.json` and the manifest, list every `id` whose title/navigation covers it, its evidence class, and the states the spec requires that the bundle lacks (loading, empty, error, denied, missing resource, conflict, hover/focus, keyboard path).

Done when: a written list exists with each state marked `reference capture <id> (class)` or `no reference capture`, exclusions removed.

### 2. Establish the baseline

Record, from observation, the values `COMPARISON.md` §5.1 names: app commit/build fingerprint, both app versions, window size and origin in pt, display and backing scale, `devicePixelRatio`, zoom factor, theme, contrast, accent, font families and sizes, translucency, animation and caret handling. Match the reference conditions in `capture-environment.json` and the theme export for the chosen theme.

Done when: every value is recorded as observed on the running app, none assumed from defaults.

### 3. Run the app

Read the current `package.json` scripts, `README.md` and `scripts/` for how the app and its host are started and captured today; commands change, so look them up each run. Use the development data directory and a disposable project.

Done when: the app window is open at the baseline geometry with the baseline settings verified on screen.

### 4. Exercise the real UI

Reach each selected state through real interaction following the manifest `navigation` and the `INTERACTIONS.md` trigger for that state: open menus, type into the composer, hover with a real pointer, exercise the relevant backend path. Capture idle and hover, selected and unselected, key and not-key, running and stopped as separate states, exactly as the bundle pairs them (`compareWith`). Use disposable resources; disconnect/delete or permission-denial scenarios need explicit authorization.

Done when: every state in the scope list was reached in the running app, or is marked unreachable with the reason.

### 5. Save candidate originals

For each state, save a native window capture (window-id capture, the same kind the reference used; `COMPARISON.md` §5.2) and an accessibility snapshot, named by manifest id, into a new `.data/` subdirectory for this scope and date. Verify IHDR against the applicable window or union frame and the observed saved scale; record every auxiliary frame and identify helper downscaling rather than assuming the backing scale survived. Resampled files are layout references only. Keep originals unmodified; derived crops live beside them with their rectangles.

Done when: every candidate has an original PNG with verified IHDR, an AX snapshot and a pair record (`COMPARISON.md` §5.3).

### 6. Align

Both sides must share the saved pixel grid, logical viewport, DPR, fonts, theme and state (`COMPARISON.md` §3). Take the reference side's origin, scale and crop from `geometry-report.json` `files[].mapping`; a crop needs a recorded origin and size derived from a measured boundary, a translation is computed (phase correlation on a static region) and recorded, never eyeballed. Files whose mapping says `resampled` are layout references only.

Done when: each pair is registered (identical IHDR after recorded crops) or marked `incomparable` with the constraint it violates.

### 7. Compare

Per pair, in this order:

1. **Structure**: diff the AX trees (roles, names, order, states).
2. **Layout**: dump `getBoundingClientRect()` for the structural elements and compare with the native boundaries in pt (`COMPARISON.md` §5.7).
3. **Pixels**: flatten alpha identically, mask the dynamic regions §5.6 lists plus anything whose scroll offset was not recorded, and compute the §5.5 metrics per static region against its tolerances. Every mask and threshold is written into the pair record.

Done when: every registered pair has structural, boundary and per-region pixel results with masks and tolerances recorded.

### 8. Inspect and classify each difference

Look at every failing region and every structural or boundary delta. Sort each into one class:

| Class | Meaning |
| --- | --- |
| Structural mismatch | Missing, extra or misordered element, role or state; wrong control kind. |
| Interaction mismatch | A state the reference reaches that the app cannot, or reaches differently (menu contents, focus, keyboard path, loading/error behaviour). |
| Visual mismatch | Geometry, spacing, radius, colour, typography, icon or motion divergence in a static region. |
| State mismatch | Candidate and reference are different states (hover vs idle, key vs not-key, selected vs unselected); re-pair, do not tolerate. |
| Expected difference | Data and content (titles, timestamps, usage meter, account, project names); OMP-native labels, providers, permission modes and hosts; agreed theming additions recorded as intentional; upstream 7868→7982 drift with evidence; native macOS/Chromium popups, vibrancy and translucency; text anti-aliasing floor. |

An expected difference needs its reason; without one it is a mismatch. Masks and tolerances describe measurement limits, never a way to make a mismatch disappear.

Done when: every difference has one class and one sentence of evidence.

### 9. Report

Write the report next to the candidates with:

- The scope list from step 1 and the baseline from step 2.
- One pass/fail line per pair in the `COMPARISON.md` §5.8 shape.
- Mismatches grouped by class, each pointing at the pair, region and evidence.
- Expected differences with reasons.
- Each claim labelled `live verified`, `automatically tested`, `supported by source`, `user verified`, `failing` or `blocked`.
- Limitations: states without a reference capture (class R), states proven only by A or U, incomparable pairs, unrecorded conditions, build drift, anything only proven by fixtures.

Done when: a reader can reproduce every number from the saved files and the report never states more than the evidence carries.

### 10. Iterate

Fix only the mismatches attributed to the app, then rerun steps 3–9 for the affected pairs only. A recapture supersedes its earlier record; keep the earlier evidence.

Done when: remaining mismatches are listed as remaining work, not hidden.

## Guardrails

- Side effects run only inside a disposable project and the development data directory. Sends to real providers consume real quota: send the smallest prompt the state needs, never loop sends to reach a state.
- Provider safety checks, permission grants, login callbacks and destructive-tool gates require the user's explicit interactive approval. Capture the pending state; do not answer those gates on the user's behalf.
- Never kill a shared host, delete native OMP data, alter network policy or reset user preferences to obtain a clean state; use a fresh profile/data directory instead.
- This bundle is the default Codex reference. A live installed-Codex comparison requires user authorization and matching build/geometry evidence; the presence of the app grants no permission to inspect its private data.
- Other agents may be editing source while you verify. Verification writes captures and reports; source changes belong to the fix step and its owner.

## Completion

The scope is verified when all hold:

- Every in-scope state was exercised on the running app and has a candidate original with verified IHDR, an AX snapshot and a pair record.
- Every pair is registered or explicitly `incomparable`, and each is paired with the reference capture of the same state.
- Every difference is classified with evidence; no unexplained mask or loosened tolerance.
- The report separates mismatches from expected differences, labels each claim's evidence level, and names the evidence class of each reference used.
- Backend behaviour visible in the captures is cited from its own acceptance evidence or marked unverified.
