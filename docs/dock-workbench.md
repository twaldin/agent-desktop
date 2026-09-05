# Docked workspace: source 16

Review, Files, Worktrees and individual native terminals now use the same right/bottom tab model. Each tab names its owning host and project/session; terminal tabs additionally retain the native terminal ID. Window navigation remains independent of these owners.

- Add selects an existing matching tab wherever it lives. Explicit move changes its dock; pointer movement commits on release, with Escape/cancel retaining the original placement. Close removes the tab, while Hide retains the dock and its selection. Neither action stops a shell. Terminal actions separately stop a shell for all viewers or forget a stopped terminal.
- Window persistence stores both regions, order, selection and sizes, plus Environment visibility. Legacy panels migrate after their workspace is resolved. A saved native selection restores that exact ID without creating a shell; a missing selection opens an empty chooser. Missing/offline owners remain selected rather than falling back to a local workspace.
- Workspace panes share the existing editor/Git state and a counted subscription. Closing one pane does not stop updates to another. Moving a terminal detaches/reopens its viewport on the same native ID and does not request a new grid size.
- Bottom placement spans the conversation and right panel. The narrow side panel overlays the conversation. Environment stays above that overlay so it remains usable at narrow sizes and browser zoom.

The floating Environment card uses actual workspace Git status and the [native activity bridge](session-activity.md). Its changed-file count is unique paths in Git status, not a claimed last-turn diff. Commit opens the existing staged, revision-guarded dialog. Branch copying, file browsing and native terminal opening have real handlers. Agent/job details are read-only.

Sources are a bounded projection of available transcript records: durable image blocks and explicitly successful completed native `read` results, deduplicated by path. Failed/proposed reads, arbitrary project files and streaming images without a durable entry do not become sources. File links resolve against the owning session cwd and retain host boundary enforcement; images use the existing owner-bound media loader and preview. This is not an exhaustive consumed-sources registry.

## Evidence

- `scripts/acceptance/workbench-dock.ts`: controlled native bridge, production hook; restoration without creation, native IDs, hide/move, late response after navigation, legacy migration, unknown outcomes and wrong-target rejection. `.data/workbench-dock-acceptance/run1/result.json` records five workflow groups.
- `scripts/acceptance/dock-panel.ts`: production components; cross-dock pointer release/cancel, close without dragging and translated resize cancellation. `.data/dock-panel-acceptance/current/result.json`.
- `scripts/acceptance/environment-card.ts`: production card; actual Electron light/dark modes, computed-color difference, narrow fitting, source expansion, all callbacks and disabled commit states. `.data/environment-card/current/result.json` and PNGs. Host/activity values are controlled.
- `scripts/acceptance/app-dock.ts`: production App; four integrated workflow groups, owner-bound activity queries, retained route, and wide/narrow/150% captures. Run 3 preserves real failures for menu dismissal and Environment hit testing. Run 4 verifies their fixes, with stable listed source hashes.
- `scripts/acceptance/attachment-ui.ts`: seven existing attachment workflow groups still pass after adding source previews, with stable listed source hashes. `.data/attachment-ui-acceptance/source16/result.json`.
- `scripts/acceptance/composer-ui.ts`: six existing composer workflow groups still pass after integration, with four viewport captures. `.data/composer-ui-acceptance/source16/result.json`.

The final full suite (`.data/source16-full-tests-final.log`) passes 471 tests and 24,176 assertions, with 17 explicit skips and no failures. All 351 recorded source hashes were stable throughout; typecheck and build pass. The initial failure is retained in `.data/source16-full-tests.log`, with its shutdown fix explained in the activity contract.

Those controlled checks are source-level tests and hidden Electron captures. Separate Home release 16 acceptance now verifies the actual Environment-to-Review action, split/unified option changes, identity-preserving movement into the bottom dock, and a rendered native repository diff. `.data/ui-acceptance/home16-installed-ui/` contains the result and actual Electron viewport images. No provider ran; physical cross-device docking and live reference parity remain unverified.

Installed narrow-window inspection exposed header controls covered by the open side dock. `.data/app-dock-acceptance/narrow-header-red/result.json` independently reproduces failed hit tests at narrow and 150% layouts while the card itself remains clickable. The next source correction reserves the header's height above the overlay and fills each dock's allocated height. `.data/app-dock-acceptance/narrow-header-fixed3/result.json` passes all four workflow groups and three viewport/zoom captures, including header hit-testing and allocated bottom height, with stable source hashes; release 16 does not contain this correction.

## Remaining work

Browser and side-chat tabs, native goal controls/restoration/continuation, child-agent navigation, full source/attachment coverage, and exhaustive reference interaction/animation/icon parity remain open. The Environment header glyph is currently an approximation; other inherited icon variants retain the limitations in [icon parity](icon-parity.md). Pane scroll/focus behavior across parent remounts needs further parity testing. Files and Worktrees still contain the earlier content UI inside the new dock. The exact Codex branch/environment selection menus and push workflow are not claimed by branch-copy and staged-commit actions.

Build 16 is packaged at `out/desktop-release16/Agent Desktop.app`; signing, native imports, tmux validation and all 106 host-manifest file hashes pass. Host archive SHA-256: `30ec5af2d3faf246536e2280c057311fd1604c3dc5f64f50f76069948769942d`. It supports state schemas 1–3. Home and Work now run desktop/host 16, with Deckbox host 16. Guarded installation, backup integrity and preservation evidence are recorded in [status](status.md); installed acceptance does not establish full feature or visual parity.
