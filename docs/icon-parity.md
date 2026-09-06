# Icon parity: source 13

Thirteen of the 15 glyphs in `renderer/Icons.tsx` now use the confidently identified static SVG artwork from Codex **26.901.41600 / build 7982**. The component API, `currentColor`, caller CSS dimensions and theme scaling remain intact. This corrects artwork geometry; it does not establish installed-window or whole-window parity. Refresh and the generic permission shield remain unchanged pending control/state mapping.

## Source and mismatch map

`I` below is `/tmp/codex-reference-26.901.41600/webview/assets/app-initial-86767c3d23e5.js`; `P` is the sibling `app-primary-139889e10fbd.js`. Locations are zero-based Unicode character offsets in those exact files. Both JS files, `permissions-mode-dropdown-176cd475c4d1.js` and `app-initial-5b0a474bff5e.css` were byte-compared successfully against the preserved `.reference/codex-26.901.41600/app.asar`. The named registry includes native canvas, ink bounds and SVG body; no bundle executable code was copied or run.

The old component applied a 20×20 canvas and 1.45-wide rounded stroke to every glyph. The chosen reference artwork instead uses filled paths with native 16/20 canvases, including explicit even-odd holes. Filled dots previously inherited an extra stroke. Per-glyph native canvases now survive rendering, and only the two unchanged approximations retain the old stroke.

| Own glyph | Source artwork / location | Correction and confidence |
| --- | --- | --- |
| compose | `square-and-pencil-light-16`, I:5262040 | Rounded pad/pencil contour. Actual New chat call maps through `cD` at P:2991971; 16px sidebar icon. |
| search | `magnifying-glass-lg-light-16`, I:5131953 | Larger, differently centered lens and shorter handle; traced sidebar Search at P:2974940. |
| folder | `folder-light-16`, I:5076994 | Adds reference horizontal seam and curved tab transition. Closed-folder artwork is definite; open/remote variants remain separate. |
| chevron | `chevron-right-md-light-16`, I:5015536 | Native contour and optical offset. Right-pointing artwork is definite; rotating it does not establish the separate down-chevron variants. |
| arrow | Inline `g6`, I:8416476 | Actual composer Send glyph: longer shaft and wider head. `UT` at P:7269495 maps to this 20×20 SVG, not the similarly named Lucide chunk or small annotation arrow. |
| stop | Inline `kLs`, I:9616215 | Actual composer stop is a filled square spanning 4.5–15.5, radius 1.25, on a 20×20 canvas; previous square was 5–15, radius 2. `HT` is selected in the stop branch at P:7272273. The registry's outlined `stop-light-20` is a different icon. |
| more | `ellipsis-horizontal-light-16`, I:5049793 | Removes inherited stroke; restores centers near 3.334/8/12.667 and 2.384px dot diameter. Traced sidebar/menu use; a separate 20px asset exists for some toolbar uses. |
| archive | `archive-light-16`, I:4925575 | Native lid/body contour and inset handle; traced archive sidebar and task actions. |
| close | `xmark-md-light-16`, I:4018645 | Smaller native X footprint and contour; traced dialog/alert close usage. A separate 20px artwork exists. |
| terminal | `terminal-light-16`, I:5282968 | Square enclosure and smaller prompt/cursor replace the rectangular terminal. Artwork identity is definite; exact per-tool/header size and variant use are not fully traced. |
| check | `checkmark-md-light-16`, I:5008821 | Restores steeper long arm and asymmetric check shape; traced selected-option menus at P:2201871. |
| sidebar | Inline `h$`, I:7277703 | Actual open-sidebar chrome outline/divider from the branch at I:7286712. A separate closed/sidebar-unread glyph remains unwired. |
| plus | `plus-md-light-16`, I:8199408 | Correct light contour/extent; actual sidebar Add project asset at P:2993950. Larger/smaller plus variants exist elsewhere. |
| refresh | Deferred | `arrow-rotate-counterclockwise-light-16` (I:4942399) is used for Reset, while `arrows-clockwise-rotate-lg-light-16` (I:4953332) and Lucide reload variants also exist. Do not assign one indiscriminately to reset/reconnect/retry. |
| shield | Deferred | Permission dropdown `Wt` at offset 27695 maps auto/granular/read-only to a **hand**, full access to an **exclamation shield**, and other policies to other glyphs. Full-access SVG is P:7523184; hand is P:7291977. Our single generic shield cannot reproduce those states without a policy-aware caller change. |

## Size and state limits

These are source-established defaults, not measurements of live Codex. P:2610909 gives sidebar icons `icon-xs` inside a 16px leading slot; `Zdn` at P:2610360 renders the static icon in this pinned build despite the presence of Lottie chunks. CSS declares `icon-xs` and `icon-primary-action` as 16px by default, with browser-specific overrides. The main composer uses the 20×20 send/stop artwork at the `icon-primary-action` CSS size (P:6442369). Sidebar chrome uses a 20×20 SVG at `icon-xs` (I:7286432).

Own caller dimensions were deliberately retained: New chat 16px; sidebar Search 17px; project folders 17px, breadcrumb 16px and composer folder 15px; project chevron 12px and model chevron 14px; send/stop 20px; general action icons 20px or small 17px; model check 16px; open-sidebar icon 16px. Theme scaling can change these. Relevant rules are `styles.css:65–99,130,256`, `model-picker.css:4,12,25` and `theme.css:15`.

Next measured caller pass should align Search/project/send sizes, wire open/closed folder and sidebar variants, use dedicated down-chevron and policy icons, and choose 16/20 optical variants where actually used. The supplied screenshot supports the general silhouettes and distinct open/closed folders, but has unknown original zoom/settings and different window content. No pixel score is derived from it. Composer loading, morphing, resume, cloud and keyboard-shortcut states also remain outside this static glyph comparison.

## Validation

`bun run typecheck` passes. A hidden sandboxed Electron 44.2.0 window rendered the actual before/after React components beside independently extracted static SVG bodies at fixed 16px and 20px sizes, in dark and light colors. All **52 matched cells** have identical reference/after raster pixels and correct measured dimensions; every before cell differs. This verifies the chosen artwork rendering and `currentColor`, not the correct choice of artwork/size for every caller.

Private evidence: `.data/icon-parity-source13/summary.json`, `references.json`, `result.json`, `dark.png`, `light.png`, and the small reproduction harness (`bun .data/icon-parity-source13/run.ts`). Source hashes, exact spans, bounds, Electron/Chromium versions and the 1080×870 CSS viewport / 2160×1740 raster are recorded. Both final sheets were visually inspected. The first crop calculation mistakenly used CSS coordinates on the 2× raster; its retained result is explicitly excluded, and the final comparison scales by the measured image/viewport ratio. The isolated profile was removed. No installed application, provider or live Codex UI was operated.

## Source 18 browser glyph

The Browser dock and chooser use the preserved `globe-light-16` artwork, extracted as static SVG from `full-package-v3/tree/webview/assets/app-initial-86767c3d23e5.js` at character offset 5,095,668. Its native 16×16 canvas and filled even-odd path are retained. This identifies the glyph geometry; it is not a new whole-app or browser-toolbar parity score. No archived executable code was run.

The Source 18 browser toolbar now uses separate `browserBack`, `browserReload`, `browserExternal`, and `browserOptions` variants. Pinned static tracing resolves Back/Next to `arrow-left-lg-light-16` (Forward mirrors it), Reload to both paths of `arrows-clockwise-rotate-lg-light-16`, external-open to the inline 16-point arrow, and Options to the complete three-path 21-point artwork rendered at 16 points and rotated vertically. Generic refresh/reset callers remain unchanged. Complete private definitions and caller traces are in `.data/browser-toolbar-pinned-source.json`; toolbar component/native acceptance is in `.data/browser-toolbar-controls-fourth/` and `.data/ui-acceptance/native-browser-toolbar-first/`. Those captures are not an exact-reference raster certification.

## Source 21 question card

The detached question header uses the pinned `chat-bubble-questionmark-light-16` artwork (primary bundle character offset 6,897,600; the native async-question header calls this asset). Its alternative-response row uses `pencil-light-16` rather than the new-chat compose artwork. Both retain their native 16-point canvas. Exact static bodies, source hashes and extraction offsets are private in `.data/question-card-compact-21/static-icons.json`. Controlled component captures exercise the actual card, not a registered native-window comparison.

## Source29 environment project card

The project card uses the pinned settings caller's notebook glyph (`zp` export, `S8o`, initial bundle character offset8,804,021). All three filled paths and the16-point canvas are retained. The settings caller selects this icon for an ordinary project. Controlled environment-settings captures exercise the artwork in the actual React component; its use is source-supported, without a new native pixel-equality claim.
