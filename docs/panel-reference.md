# Panel reference: pinned Codex 26.901.41600

The review surface is **`@pierre/diffs 1.3.5` with Shiki and Codex-specific themes/CSS**, inside a shared tab-and-dock controller. The supplied screenshots expose three connected gaps in our app: a plain-text diff cannot reproduce this renderer, fixed Files/Changes/Worktrees tabs cannot reproduce the panel controller, and the terminal has extra chrome and fixed placement. Preserve our real Git operations and native shared terminal while replacing their presentation and layout seams.

This is static evidence and an implementation map, not a completed parity claim. No Codex process was controlled, executed, or captured for this investigation. No production code changed.

## Evidence and coordinates

The pinned ASAR SHA-256 is `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`. Source member paths below are relative to `.reference/codex-26.901.41600/full-package-v1/tree/webview/assets/`. The complete extraction manifest retains ASAR offsets and integrity hashes. This trace independently verified **21 selected member hashes** against the original ASAR inventory.

Minified-source coordinates below are zero-based Unicode-character offsets, not line numbers. `.data/panel-reference-2026-09-05/evidence.json` contains corresponding UTF-8 byte offsets, searchable needles, excerpts, full source hashes and screenshot metadata. These are locators into original bytes; expected images were not regenerated.

| Source alias | File | SHA-256 |
|---|---|---|
| I | `app-initial-86767c3d23e5.js` | `fb72076ee44f6596f8dafa9a3effe37a3527a87db21fde8b4042233957b554bb` |
| P | `app-primary-139889e10fbd.js` | `5f2eb43484da39a9459a918c52cb6d0ff8df6ea8184d23bfc448f0702a86d010` |
| IC | `app-initial-5b0a474bff5e.css` | `3c3865c9f704dee3c444905a7625e757cd25c967a765d3f7710d8c14f46bd783` |
| Review | `thread-side-panel-tab-content-7515757cf21d.js` | `8d044ca9814dd5721211ed03a9982d6655aa09a44bda9d4f9d951d7213cba039` |
| Diff | `code-diff-7411c3d4b634.js` | `fb26f8fa88fc97269e39e0f3ab89d73ef950bebfdac909858ede1ded03bc82bf` |
| Actions | `file-bcf12151b97b.js` | `5d8ec0bc0d0b9e85be16a9c6e0a4abef015c53c24403cc183dbd82db8f54544d` |
| Chrome | `thread-app-shell-chrome-cb4a05d7bec7.js` | `b49d9aab67b32c5b36b9cab9384cafceea3b63d597913913e872ef2a78952ed3` |
| Terminal | `terminal-panel-4d55ad90ad36.js` | `55a75f12dbdfb1877c325669d682815414daa39efe86792b84582626006d9ac0` |

User-provided files in `.reference/user-supplied/`:

| Capture | Pixels / SHA-256 | Directly visible evidence |
|---|---|---|
| `2026-09-05-115043-codex.png` | 1810×2252 / `3fef481c34e4aa43fb3a30df7ad4dc21231f1c0b1205ac8409506d3b7d0e82c1` | Review tab, Last Turn source, +1470/−150 totals, unified added-file diff, syntax colors, gutter/bar, unwrapped long lines, split-toggle tooltip, file-tree and commit controls. |
| `2026-09-05-115052-codex.png` | 1038×380 / `b66367b0940096d806e830fa6e59141920b3ba9b1806b8d22b05f6e325a7b5ae` | Pressed plus button and Terminal/Side chat/Browser/Files menu with shortcuts. |
| `2026-09-05-115107-codex.png` | 3058×2224 / `055e1b76470a37c038d5cbf4aac4da082af25b064abcb8edc307801af5a49f5c` | Conversation left, Review right, terminal dock below both; one terminal pill/tab row, plus and far-right hide/close control. |

All PNGs report approximately 144 DPI. A 2× capture scale is consistent with the earlier full-window pair and source geometry, but these cropped captures do not establish browser zoom, full viewport dimensions or all preference values. Split layout, dragging, keyboard navigation, persistence, loading motion and hidden menu states below are **source-backed**, not directly demonstrated by these still images. Do not compute a whole-window similarity score across their different contents/crops.

## Libraries: exact declarations and limits

The ASAR itself contains no Pierre/Shiki/xterm package manifest among its 42 `package.json` files. The matching installed bundle has a static `Contents/Resources/THIRD_PARTY_NOTICES.txt`. After re-verifying the installed ASAR hash, its exact bytes were preserved at `.reference/codex-26.901.41600/panel-supplement/THIRD_PARTY_NOTICES.txt`, with a separate manifest. SHA-256: `ac698f1adf11e9b9508f2e65034adb572cdaa9807cfbe74e044402e03c796887`; 2,908,520 bytes. This is explicitly an **outside-ASAR resource**, not an invented archive member.

| Declared dependency | Notice character offset | Relevance / qualification |
|---|---:|---|
| `@pierre/diffs 1.3.5` | 2707924 | Active family independently confirmed by the `FileDiff` call chain, `<diffs-container>`, and Codex's own Pierre split-separator CSS comment. Exact declared version is the first replacement candidate to inspect. |
| `@pierre/theme 2.0.0`, `@pierre/theming 1.0.1`, `@pierre/trees 1.0.0-beta.4` | 2718938, 2729952, 2740968 | Theme/tree ecosystem is included. Do not assume every package API is active in every panel. |
| `shiki 3.20.0` | 1387294 | Shiki provider is directly called. Notices also contain `@shikijs/core`, themes and types at **3.20.0 and 3.23.0**, plus transformers 3.23.0; do not flatten these into one proven subdependency graph. |
| `@xterm/xterm 5.5.0`, fit 0.10.0, clipboard 0.1.0, web-links 0.11.0 | 448968, 446452, 445192, 447707 | Terminal constructor/addon calls match the declared library family. Our xterm 6.0.0 already implements the required terminal surface; a downgrade is not implied. |
| `node-pty 1.1.0` | 931292 | Also exact in ASAR `node_modules/node-pty/package.json`, SHA `f8b6a14f7022c14f1cd5d109486f5dacd32bffb63a9a63e38eced37dacb47439`. Our owning-host tmux implementation must preserve stronger reconnect semantics. |
| `@dnd-kit/core 6.3.1`, sortable 8.0.0 and 10.0.0 | 54468, 56917, 58143 | The tab drag implementation uses sortable/droppable primitives; two sortable versions are declared, so exact active copy remains unresolved. |
| `@radix-ui/react-dropdown-menu 2.1.16` | 172201 | Portalled menu wrapper and Radix positioning variables are directly visible. |
| `framer-motion 12.29.2` and 12.42.2; `motion-dom 12.42.2` | 662888, 664116, 911282 | Motion components/AnimatePresence are active; notices alone do not assign a specific bundled call to one duplicate version. |

Static main `.vite/build/main-C5K7o1Hr.js:1296381` defines `THIRD_PARTY_NOTICES.txt` and `BL()` searches `process.resourcesPath` first, then development asset paths. `UL()` reads it; a development-only generator is separate. No handler or generator was invoked.

## Review renderer and annotation seam

The chain is `ReviewThreadSidePanelTab` (`Gs`, Review) → review state/view (`Ms`, `Ha`) → Diff → `FileDiffPresentation` re-export → **P `vVt` (1744566), `bVt`, `AVt` (1748050)** → React diff wrapper **P `VDt` (1427268), `LDt` (1425401)** → Pierre instance.

`LDt` constructs a regular `_je` instance without a virtualization provider, or a `Dve` instance with the provider and metrics. It hydrates into a real container, updates options, renders changed `fileDiff`/annotations, updates controlled selected lines, and calls `cleanUp` on unmount. This is the seam to use instead of reparsing lines into spans. I registers **`diffs-container`** with an **open shadow root and adopted stylesheet** around 1277211. Outer app CSS alone cannot style its internals; Codex passes generated `unsafeCSS` into the renderer.

| Concern | Exact reference contract |
|---|---|
| Display | `diffStyle` unified/split; indicators default `bars`, preference `symbols` maps to `classic`; `disableFileHeader:true` because the app supplies its own file header. |
| Context | Hunk separators `line-info`; collapsed-context threshold 3; expand action admits 20 lines. Optional language context parser is cached by `diff-context-parser` and decorates unchanged-context headings. |
| Scrolling | `overflow:"scroll"` unless word-wrap preference changes it. Keep native line mapping and synchronized split-column behavior; a text wrapper is insufficient. |
| Selection | `enableLineSelection`, `selectedLines`, `onLineClick`, `onLineNumberClick`, `onLineSelected`, `onLineSelectionChange`, `onLineEnter/Leave`. Callbacks retain side/line identity. |
| Annotations | `lineAnnotations`, `renderAnnotation`, `onGutterUtilityClick`, `onPostRender`; custom header/prefix/filename suffix/metadata and gutter utility renderers are public wrapper slots. `controlledSelection` is set when selected-lines props are supplied. |
| Rich file states | Diff:3240 routes Markdown/image rich previews while retaining code fallback; binary, empty, deletion and rename-without-content-change have distinct states. `Diff failed to render` is a real error boundary, not a loading state. |
| Lazy work | Review:31424 uses `IntersectionObserver` with `rootMargin:"300px 0px"` before loading pending full file diffs, tied to snapshot generation/revision. Old snapshot results cannot simply overwrite the current review. |
| Metrics | `review-diff-virtualizer-metrics-92681c84005e.js`: hunk batch 32 lines, line height `fontSize × 1.8`, header height 0, hunk separator 32, spacing 0; actual computed pixel line-height/gap supersedes fallback. |
| Find | `diff-source-68c6de8a3446.js`: domain `diff`, context ID, path/hunk/side/line match mapping, cap 250 results, ensure-visible scroll before highlighting. It searches rendered shadow roots and reinstalls highlights after render. |

Diff:45432 contains the compact final props bundle, useful as an implementation checklist. Review:41351 `Ha` restores `tabState.scrollTop` and tracks per-file render refs. Mark-as-viewed intent is keyed against the displayed revision: Review:~34000 hides its action until diff-header hover/focus, uses `aria-pressed`, and changes to “Marked as viewed” with “Mark as unviewed” accessible label. New revisions should not inherit a stale viewed claim.

### Syntax and colors

`shiki-highlight-provider-f8f3365ed4af.js` creates **4 module workers**, caches **100 file/diff ASTs**, preloads TypeScript/JavaScript/CSS/HTML/Python and updates theme/word-diff options without reconstructing the panel. The highlighted worker is `worker-c95ad5902d1d.js`. Underlying defaults include preferred `shiki-js`, `tokenizeMaxLineLength:1000`, `maxLineDiffLength:1000`. The provider explicitly selects `lineDiffType:"word-alt"` when enabled and `"none"` otherwise; the UI preference defaults to off.

I:2155313 defaults both `appearanceLightCodeThemeId` and `appearanceDarkCodeThemeId` to **CODEX**. `AVt` selects the configured light/dark theme, feeds its name/type to Pierre, and registers the instance for later theme/selection updates. IC:804358 sets:

- `--diffs-font-family:var(--font-mono)`.
- `--diffs-font-size:var(--vscode-editor-font-size,12px)` and line height `×1.8` (21.6px at default size).
- `--diffs-gap-block:0`, minimum number column `4ch`.
- Addition/deletion bases use the app's Git color tokens, not a separate arbitrary green/red pair.

The **complete native TextMate rules** are in `codex-dark-c9c4e9fbc112.js` (SHA `18e559d9fc983253fb28288296bda817ee198a7363606e948c00202039ec1c0f`) and `codex-light-d03f2716c66a.js` (SHA `bddacd4d49918c829b0d87e95ffb9f8e3ddea70d61bb191c525318f004b0f92c`). Use their rule structure; the following subset explains the supplied TypeScript appearance and is not a replacement lexer:

| Token / theme value | Dark | Light |
|---|---|---|
| Editor base foreground/background | `#fcfcfc` / `#111111` | `#0d0d0d` / `#ffffff` |
| Comments and most punctuation | `#999999` | `#666666` |
| Strings | `#85df7b` | `#008809` |
| Keywords/storage | `#F67576` | `#D53538` |
| Functions/classes/types | `#B06DFF` | `#751ED9` |
| Variables/constants | `#FA994C` | `#BD5800` |
| Numbers/booleans and selected operators | `#6DCBF4` | `#0071EA` |

**P `iOt` (1439500)** overrides the renderer base background with the appropriate app surface, so the theme's editor background is not the final sampled review background. Its CSS distinguishes text cells, number gutters, hover, selected-line annotations and separators. Underlying addition/deletion text-line fills mix background/base **88/12 light, 80/20 dark in Lab**. Codex number gutters mix theme background/base **91/9 light, 85/15 dark**. Addition hover uses 80/20 light and 70/30 dark; deletion hover uses 80/20 light and 75/25 dark. Therefore one flat `diff-added` color cannot reproduce the screenshot.

The same function fixes split separator duplication, rounds line-info separator ends at 8px, styles real gutter utility buttons, prevents reserved scrollbar gutters from narrowing every split pane, and overlaps consecutive colored markers by 1px to close fractional-pixel seams. Keep those fixes with the renderer adapter, not global selectors that recolor arbitrary code.

## Review toolbar and saved options

The supplied tooltip “Switch to split diff” identifies the **unified** state. Actions `St` at 21972 changes its label/icon with mode and emits the requested side; Review maps that to unified/split (75271). `Ct` around 22700 is the common toolbar button: 16px icon class, `aria-label`, `aria-busy`, `aria-pressed`, ghost versus active-ghost state, uniform toolbar sizing. The ellipsis “Review options” is `bt` around 13680.

| Visible or reachable control | Source label/state / locator |
|---|---|
| Source dropdown and totals | Review:59140 onward: Last Turn, Uncommitted, Unstaged, Staged, Commit/Committed/Commits and branch option, filtered by source capabilities. Do not label an ordinary working-tree patch “Last Turn” without a real turn snapshot. |
| Split/unified | Actions:21972; “Switch to split diff” / “Switch to unified diff”; screenshot confirms the first label. |
| File jump | Actions:11153; “Jump to file”, filtered paths, “No matching files”. |
| Wrap | Actions:14241/14383; “Disable word wrap” / “Enable word wrap”. |
| Expansion | Actions:14631/14809; “Collapse all diffs” / “Expand all diffs”. |
| Rich preview | Actions:23706/23871; “Disable rich preview” / “Enable rich preview”. |
| Full file context | Actions:24642/24813; “Don't load full files” / “Load full files”. |
| Word differences | Actions:25587/25735; “Disable word diffs” / “Enable word diffs”. |
| Whitespace | Actions:26130/26274; “Show white space” / “Hide white space”. |
| Refresh/copy | Actions:14033/26589; “Refresh” / “Copy git apply command”, disabled when appropriate source data is unavailable. |
| Commit or push | Directly visible in both Review screenshots; Review:~80200 mounts Git actions with owning root, conversation/worktree context, `surface:"review-toolbar"` and compact state. Current app only has real local commit; do not render a working push action before its backend exists. |

Persistent preference keys are traced at I:7930150 onward: `editorDiffViewMode` defaults unified; `hideDiffWhitespace` false; `wrapCodeDiff.2` false; `wordDiffsEnabled.2` false; `diffRichPreview` false; `diffViewThreadSettings` carries route-specific settings whose rich-preview fallback is true. These are separate scopes, not one contradictory boolean. `review-preferences-model-adfaa83cc3d7.js` also persists `load-full-files` true and `review-filter-generated-files` false. Our app should adapt these intents to its validated preferences/window state instead of copying Codex's internal storage keys blindly.

Loading/error states have real distinctions: loading snapshot/full file, too-large diff, unavailable old diff, no changes, no Git root, binary/empty file and render failure. P:1439500 injects the exact skeleton: base description color at 10%, highlight at 16%; background rows sized `calc(100% - 24px) × 22px`, positioned 12px/8px, filled through 82% width. Its overlay is inset 8px/12px, masked to **14px ink / 8px gap**, traverses −100%→100% in **3000ms linear infinite**, and disables animation under `prefers-reduced-motion:reduce`. This state was not captured in motion by the user.

## Tabs, menu, docking and resizing

I:3910740 onward constructs distinct **right** and **bottom** controllers from the same controller factory. They retain ordered tab IDs, active tab, open state, focus behavior and tab-specific state. `oN` chooses the controller; `sN` finds an existing tab across controllers; `O5n` activates and restores focus; `D5n` hides a panel and restores prior/composer focus. Hiding and closing a tab are different operations.

`Chrome bs` (44768 vicinity) renders the unified strip. It has an accessible horizontal tablist, stable tab/button/panel IDs and a horizontally scrolling tab container (`data-app-shell-tab-strip-controller`). It retains tab widths temporarily during repeated close actions so the close target does not run away under the pointer. Minimum strip allocation is 90px per tab, maximum 240px, 1px separators, with additional room while renaming. This is allocation geometry, not a claim that every visible pill is 240px wide.

The compact pill renderer **I `TUa` around 7199440** is `h-7`, `max-w-39`, `rounded-lg`, 8px horizontal/4px vertical padding. Its 16px icon and truncating text share the pill. The close button is absolutely placed at the inline end, appears with hover/focus when inactive, and avoids reserving permanent blank width. `data-app-shell-tab-close-button` has “Close {title} tab”. Selected/presented, preview, suspended, disabled, highlighted, renaming and closing states remain separate. Tab thumbnails use a delayed hover portal and stop being interactive while dragged/active; they are not screenshots captured by this investigation.

**Keyboard behavior:** I `WUa` (7215926) uses Left/Right with RTL reversal, Home/End, skips disabled tabs, activates/focuses the destination, and supports Delete to close with a post-close focus fallback. Middle-click closes a closable tab without activating it. Preview tabs can be pinned by double-click; the source has a 500ms custom double-click guard. Shortcut hints are shown conditionally while the configured modifier is held.

`Chrome cc` (71058 vicinity) is the add-menu trigger. It is a portalled start-aligned panel-width menu; `data-state=open` gives the plus a 5% text-color background and normal text color. If only one action is available, it can invoke that action directly. Browser selection may defer until menu close to avoid focus races. `Ua` constructs actions from capabilities, owning host/route, access and destination; an already-open singleton Review tab is omitted. Thus screenshot menu membership is a real state, not a universal hardcoded four-item list.

| User screenshot action | Visible Mac shortcut | Source intent |
|---|---|---|
| Terminal | Control + backtick | `toggleTerminal`; new terminal in chosen panel/controller. |
| Side chat | Option + Command + S | `openSideChat`; unavailable on some route kinds. |
| Browser | Command + T | `openBrowserTab`; deferred menu focus where needed. |
| Files | Command + P | `searchFiles`; existing file tab can be reused. |

The terminal registration **I `TKi`/`DKi`/`AKi` around 5893350** accepts left/right/bottom destinations, uses tab ID `terminal:<id>`, and serializes a version-1 durable route `{cwd,hostId,sessionId}`. It restores the existing session ID. File tabs likewise retain owning `hostId`, path and line/column; they deduplicate by identity rather than creating a new editor per click. The supplied bottom terminal spans the left conversation and right review; it is not nested solely inside the conversation column.

Source topology restoration at P:2601165/2607381 carries `{bottom:{activeTabId,open,tabIds},right:{activeTabId,open,tabIds},focusArea,rightPanelFullWidth}` plus durable tab route descriptors. Only valid/restorable tabs are retained and ordered. This documents the restoration data shape; the exact topology disk-storage adapter was not established in this bounded trace.

| Layout behavior | Source / exact rule |
|---|---|
| Right pane size | I:3697280 onward, `app-shell:right-panel-width:v3`: persisted normalized ratio with legacy-pixel migration, minimum 320px; ordinary layout reserves 352px for main content, unified mode reserves 320px. Default width starts from 600 with aspect/available-space adaptation. |
| Bottom pane size | I:7293190 `kqa/Aqa/jqa`, `app-shell:bottom-panel-height`: default 280px, clamp 160px through half shell height. |
| Pointer resize | I `VKa` (7270284): 16px hit area centered on edge, axis-correct row/column cursor, touch-action disabled while dragging, thin gradient handle shown on hover/active/focus. |
| Keyboard resize | A real separator has orientation/current/min/max ARIA, tab stop, Home/End and axis arrows when resizable. Non-keyboard separators do not falsely advertise those semantics. |
| Tab movement | I:7327800 onward: transfer phases detached/preparing/restoring/restored, cancellation and stale tab-ID guards; ordering follows pointer midpoint and RTL. Chrome context actions include “Move to left pane”, “Move to right pane”, “Move to bottom pane” when accepted by the tab type. |
| Drag preview | `data-app-shell-tab-drag-preview` is inert/aria-hidden; destination overlays have allowed left/right/bottom regions, not arbitrary nested docking everywhere. |
| Motion | Strip transition `fHa`: 180ms, cubic-bezier(.23,1,.32,1); legacy tab layout 150ms. Reduced motion or active dragging suppresses layout animation. App-shell size spring is duration .5, bounce .1; do not approximate every transition with one CSS duration. |

Shared primitives matter at this scale. `zN` (I:4000940) owns disabled/loading/focus-ring/uniform toolbar geometry; `MV` (4811676) owns delayed tooltip/focus behavior (default delay 700ms, overridable); `QK` (6150996) owns Radix menu portal, edge collision/positioning and zoom. Default IC tokens are toolbar 46px, small toolbar 36px, pane toolbar 40px and ordinary transition 150ms. The generic spinner `LN` (4000116) uses `motion-safe:animate-spin` and a negative timestamp-derived phase, so concurrent spinners remain aligned; the diff skeleton is the distinct three-second effect above.

## Terminal surface without weakening owning-host behavior

Terminal:~11530 creates xterm with transparency, blinking bar cursor, configured code family/size, letter spacing 0 and line-height **1.2**. It loads fit, OSC52 clipboard and web-link addons; theme changes refresh existing rows. `terminal-panel-93f9fc5719bf.css` maps background/foreground, active/inactive selection and all 16 ANSI colors through `--vscode-terminal-*`, keeps xterm/viewport transparent, and uses 10px scrollbars with normal/hover border tokens.

Terminal `xe` (7992) intercepts Command-T for a new terminal, copy/paste/Insert variants, and Mac Command-arrow/Backspace/Delete shell editing bytes. Ordinary input and terminal-generated responses take separately tagged paths. ResizeObserver fits the visual terminal and resizes the owned session; cleanup of an explicitly identified session unregisters the viewer and preserves alternate-screen state rather than closing that session. The source has distinct crash/reload UI and cwd-mismatch/new-terminal actions. These are behavior references, not evidence that Codex's transport meets our cross-device terminal contract.

Our production `NativeTerminalPanel.tsx` already supplies real xterm 6 plus host-owned, bundled private tmux. Its replay recovery, explicit input receipts, attachment ownership, same-grid revision acknowledgements, parser-response isolation, hidden-grid handling and natural-exit history must remain correct during any panel redesign. In particular, **docking or hiding one client must not resize every other client's terminal behind its back or close its shell**. Reference visual fit behavior needs an honest adaptation to the accepted shared grid.

## Concrete implementation map

| Current source seam | Required next change and acceptance |
|---|---|
| `WorkspacePanel.tsx:93` `Changes`, especially line 102 `<pre>` | Adapt real Git data to Pierre 1.3.5 file diffs; expose unified/split, proper old/new line mapping, actual syntax themes, gutter/line distinctions and context expansion. Preserve Git revision checks. Exercise added/deleted/renamed/binary, CRLF/no-final-newline, large diff, whitespace and failed-load cases with real temporary repositories. |
| `WorkspacePanel.tsx:30` fixed tablist | Move Files/Review/Terminal into a small shared panel-tab controller with stable owner/target IDs, closable tabs, accessible keyboard/middle-click behavior and the real conditional add menu. Files must open the requested existing file/editor state. Browser/side chat need actual capability work before enabled menu entries. Worktrees remain useful content, not a fake native Review mode. |
| `window-state.ts` and renderer window-state restore | Extend validated local per-profile route/layout state with right/bottom topology and bounded sizes; preserve offline remote owner and existing terminal IDs. Do not replicate viewport geometry through tailnet preferences. Test close/reopen, drag-cancel, stale async restoration and missing/offline owner. |
| `styles.css:369`, workspace layout and `:484 .terminal-dock` | Replace the fixed 46vw workspace and clamped terminal height with measured draggable panes. Bottom spans conversation and review; narrow widths must retain reachable tabs instead of silently hiding the only route to content. |
| `NativeTerminalPanel.tsx:62–64`, `terminal-panel.css` | Consolidate the permanent “Terminal / Connected · tmux” header plus second tab row into reference-like pill strip/add/hide controls. Keep real status/errors legible without extra idle chrome. The user should not need to understand tmux to use the terminal. |
| `native-terminal-panel.css` / `NativeTerminalView` | Preserve native bytes/TUI recovery while changing geometry and shared theme tokens. Test both clients during dock changes, smaller viewport, hide/show, detach/reconnect and shell exit; no synthetic refresh/restarted shell as a visual shortcut. |

Begin with the renderer adapter and panel controller as separate bounded changes, then integrate the native terminal into that controller. Add source-driven states to the app's controlled fixtures and compare matching crops against the supplied images. Static extraction removes avoidable screenshot requests, but does not replace actual interaction/restart/remote-ownership acceptance or establish visual parity for states never exercised.
