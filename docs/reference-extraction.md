# Pinned desktop package extraction

All **8,528 packed files** from Codex **26.901.41600 / build 7982** are now available as verified, byte-exact private reference files. This includes the full shipped webview and main/preload bundles, rather than selected screenshot approximations. It recovers packaged executable JavaScript and assets; it does not reconstruct absent authored source or prove live behavior. No extracted application code was executed, and the reference files are excluded from production/distribution. [Pinned metadata](../.reference/codex-26.901.41600/reference-metadata.json), [verified manifest](../.reference/codex-26.901.41600/full-package-v3/manifest.json).

## Reproduce and locate evidence

```sh
bun scripts/reference/extract.ts --output .reference/codex-26.901.41600/new-private-extraction
bun test scripts/reference/reference-extraction.test.ts
```

The default archive is `.reference/codex-26.901.41600/app.asar`, **296,204,754 bytes**, SHA256 `077cc65356aeae34c5d8b4de0b4cc383f6fb137ed1d69a9b3dfe69ffafa058ab`. An explicit `--archive` requires its exact `--sha256`. Output must be a fresh directory. The maintained extractor reuses [the existing ASAR header parser](../scripts/upstream-artifacts.ts), verifies the archive before/after, validates paths/ranges/collisions, verifies each packed file and every declared block, then verifies the written file. Archive symlinks are not recreated, unpacked siblings are not implicitly read, and extracted files receive no executable permission. [Extractor](../scripts/reference/asar-extract.ts).

Final reference: `.reference/codex-26.901.41600/full-package-v3/`:

- `tree/`: all packed paths and original bytes; do not open its HTML as an application.
- `header.json`, `manifest.json`: source order, relative/absolute ASAR offsets, sizes, SHA256, executable/link declarations, extraction and integrity status.
- `index.json`: 7,697 text-source records, module imports/exports, asset-reference candidates, source-map results, 42 package metadata records, font/native/license members.
- `features.jsonl`: searchable feature leads with exact source SHA256, zero-based UTF-8 byte offset/length, and short neighboring excerpts.
- `tool-provenance.json`: hashes of the executed scripts and Bun parser version.

Independent full runs produced identical member-set SHA256 `570dbacc60d9bb08f21cdb1181bb1cbf7b7ca0a9df85e1e8f5bc3c6184bc0a71`. Earlier `full-package-v1` retains an initial source-map classification limitation; `v2` corrected sibling map resolution and TS loaders. `v3` is the final reference. Raw member bytes and their manifest identities agree across these runs. [Validation](../.reference/codex-26.901.41600/full-package-v3/validation.json).

Focused validation: **9 tests, 53 assertions, zero failures**, plus clean repository typecheck and diff whitespace check. Tests cover unsafe paths/collisions, malformed/bounded/overlapping entries, wrong archive/member/block hashes, output reuse, unpacked/symlink exclusion, supplement version gating, Unicode byte offsets, inline-map recovery paths and actual Bun parsing without module execution. The real pinned run independently checks every original inventory row and every packed payload; fixture tests do not substitute for it. [Test log](../.data/reference-extraction-tests.log).

## Recovered surface

| Surface | Verified contents |
| --- | --- |
| Webview | **7,974 files**, all packed: 6,956 `.js` + 1 `.mjs`, 204 CSS, 1 HTML entry, 65 fonts, 688 images/SVGs, 31 WASM, 3 MP4, 15 WAV, 9 document fixtures, 1 license |
| Main/preload | **20 JavaScript files**, including main, workers, preload, browser-page preload, capture helper, bootstrap and window lifecycle bundles |
| Package/dependencies | Remaining **534 packed files**; package metadata, declarations, dependencies and supporting resources |
| External declarations | **402 unpacked entries**, no ASAR links; their bytes are not in `app.asar` |

Counts describe archive members, not unique components, active routes or unique font families. Most glyphs are inline SVG geometry in JavaScript; the 31 SVG files are not an icon inventory. The root package declares `openai-codex-electron`, entry `.vite/build/early-bootstrap.js`, and private workspace/file dependencies whose authored directories were not shipped. The webview entry names its startup loader, `index-d6c1adca23a2.js`, `rolldown-runtime-c05d78c594d1.js`, initial app bundle and CSS. Those entry/import edges are indexed. [Manifest](../.reference/codex-26.901.41600/full-package-v3/manifest.json), [package metadata and graph](../.reference/codex-26.901.41600/full-package-v3/index.json), [HTML](../.reference/codex-26.901.41600/full-package-v3/tree/webview/index.html).

## Source maps, readable code and graph limits

The ASAR has **zero standalone `.map` members**. The comment-shaped scan found **5,349 `sourceMappingURL` references**, all naming missing archive members; no inline map payload or `sourcesContent` was recovered. This means the map URLs are leads, not recovered source. The tool also handles base64/percent-encoded inline maps and indexed v3 sections when supplied: recovered content uses hash-based output names, never authored paths. External map/section URLs are never fetched. [Map results](../.reference/codex-26.901.41600/full-package-v3/index.json), [map implementation/tests](../scripts/reference/reference-extraction.test.ts).

Bun **1.3.14** statically parsed **7,279** JavaScript/TypeScript files; one third-party `wl_lvgl_wasm_bg.wasm.d.ts` remains a recorded parser failure. The graph includes **21,210 static imports**, **6,119 dynamic imports**, and **2 require-resolve records**. Another 856 `require` and 30,438 asset references are explicitly lexical candidates. Bun does not expose syntax ranges here: import records therefore include all matching literal byte offsets, not invented AST positions. Computed imports, escaped/generated asset references, minified bundled module boundaries and runtime dependency injection remain incomplete. [Index](../.reference/codex-26.901.41600/full-package-v3/index.json), [scanner implementation](../scripts/reference/static-index.ts).

The authorized readability follow-up produced **23 formatted private copies: 18 JavaScript and 5 CSS files, 41,939,824 bytes / 1,212,188 lines**. They include initial/primary app JS+CSS, main/browser preload/worker, diff, panel, terminal, tab and browser chunks. The existing standard **Prettier 3.8.1** installation at `/Users/twaldin/node_modules/prettier` was identity-checked (`prettier/prettier`, MIT); its **standalone API** received explicit local Babel, Estree and PostCSS plugin objects. No project configuration/plugin discovery, application import/evaluation, dependency installation or lockfile change occurred; embedded-language formatting was disabled. [Readable tree and hashes](../.reference/codex-26.901.41600/readable-prettier-3.8.1-v1/manifest.json), [private reproducible runner](../.data/reference-readable/format.ts), [execution log](../.data/reference-readable/run-v1.log).

Each derivative was read back, every corresponding raw file remained unchanged, all formatter/package hashes remained unchanged, and all 18 JavaScript import/export inventories agree before/after. This is useful validation of a formatting operation, not a full semantic-equivalence proof. The runner records exact options, package/plugin hashes and both file hashes. It deliberately uses an explicit existing tool rather than silently adding an ancestor dependency to the maintained extraction CLI. The standalone formatter SHA256 is `3b79b5e146ba76791305382fc01bb964ea28c130e5aeaefc63038bb87bf5846f`. [Formatting evidence](../.reference/codex-26.901.41600/readable-prettier-3.8.1-v1/manifest.json).

Readable copies still cannot recover erased variable names, authored React/TypeScript, comments or module boundaries. Their line numbers are navigation aids; cite the raw member hash/offset for stable evidence. Retained `sourceMappingURL` comments refer to historical raw bundles, not valid maps for formatted copies. Bun transformation is deliberately avoided because its transform API supports macros; extraction only uses static scanning. [Installed parser API](../node_modules/.bun/bun-types@1.3.14/node_modules/bun-types/bun.d.ts), [current tooling](../scripts/reference/static-index.ts).

## Practical interaction research routes

These counts are **lexical leads**, including translations/dependencies, not completed interaction coverage. Filter `features.jsonl` by category, then trace caller, component, CSS selectors/state variants and native/host boundary. The existing [visual token inventory](../.reference/codex-26.901.41600/VISUAL-REFERENCE.md) preserves declaration order and selectors, not computed cascade values.

| Category | Matches / files | Starting point within `tree/` |
| --- | --- | --- |
| Menus | 2,032 / 183 | `webview/assets/app-initial-86767c3d23e5.js`; main `main-C5K7o1Hr.js`; initial CSS menu-row selectors at byte 4,267 |
| Spinners | 49 / 17 | Initial CSS `--animate-spin:spin 1s linear infinite` at byte 50,649; initial/main app component callers; HTML startup loader |
| Diff/review | 231 / 22 | `sq-AL-91bf3534a206.js`, `sw-TZ-53221c55d8ff.js`, `worker-c95ad5902d1d.js`, initial app bundle; distinguish language data hits from actual diff component |
| Browser | 92 / 16 | `open-tab-13b1288c093f.js`, `open-handler-37981f12ebed.js`, browser-page preload and main bundle; main byte 9,365 includes thread browser-tab persistence key |
| Panels | 157 / 36 | `thread-app-shell-chrome-cb4a05d7bec7.js`, initial/primary app bundles and associated CSS |
| Terminal | 285 / 27 | `xterm-window-zoom-8e1879947ab1.js`, matching CSS, `terminal-panel-93f9fc5719bf.css`; trace PTY bridge separately |
| Hover/tooltips | 25,374 / 616 | Initial/primary component callbacks plus CSS hover/focus/media conditions; many hits are translated labels |
| Animations | 690 / 69 | Both app CSS files, `tab-content-2118f80d9ec4.css`, keyframes and reduced-motion branches |
| Composer images | 542 / 131 | Initial JS `Yda` at byte **6,705,882**, removal `P5r` at **4,940,482**, plus composer CSS |

[Full feature leads](../.reference/codex-26.901.41600/full-package-v3/features.jsonl). Concrete diff/panel behavior and dependency attribution are maintained in [panel-reference.md](panel-reference.md).

One immediately actionable finding: image tile `Yda` uses `size-20` normally, `size-[54px]` when compact, and `object-cover`; removal defaults to a 16px button inset 4px with a 12px glyph. Radius is contextual: `rounded-lg` is overridden inside the default-spaced attachment tray by `max(0px, composer-border-radius − 8px)`, with `superellipse(1.5)` when supported. Therefore tile dimensions alone do not settle radius or the active layout. Initial JS byte 6,708,446 / 4,940,482; initial CSS byte 710,804; primary CSS byte 47,248. [Initial JS](../.reference/codex-26.901.41600/full-package-v3/tree/webview/assets/app-initial-86767c3d23e5.js), [primary CSS](../.reference/codex-26.901.41600/full-package-v3/tree/webview/assets/app-primary-7fe7c6486695.css).

## Installed bundle supplement and remaining opacity

The separate, read-only installed-package inventory verifies that `/Applications/ChatGPT.app/Contents/Resources/app.asar` matches the pin before and after collection. It records **6,615 leaf entries** (6,589 regular files, 26 un-followed symlinks), hashes **1,319 selected artifacts**, and copies only **8 small metadata files**. Large framework/native/plugin binaries are inventoried rather than copied. This is not an atomic snapshot of all files. [Supplement manifest](../.reference/codex-26.901.41600/bundle-supplement-v1/manifest.json), [reproducible inventory CLI](../scripts/reference/inventory-bundle.ts).

The supplement identifies the native executable, Codex Framework/Sparkle, native helpers, plugins, `busy-bar.asar`, scripting definition and owl metadata. It also proves a `pty.node.dSYM` DWARF payload exists; absence of web source maps must not be generalized to absence of app debug symbols. Those native bytes were not decompiled, and the extra nested archive was not recursively extracted. [Supplement](../.reference/codex-26.901.41600/bundle-supplement-v1/manifest.json).

All 402 declared unpacked paths are present in the installed bundle: **395 match their ASAR declarations; 7 native/executable payloads differ**. Their actual and declared hashes are preserved separately; packaging/signing is a possible explanation, not a verified cause or an integrity pass. [Comparison](../.reference/codex-26.901.41600/bundle-supplement-v1/unpacked-integrity-comparison.json).

`THIRD_PARTY_NOTICES.txt` is outside the ASAR (2,908,520 bytes, SHA256 `ac698f1adf11e9b9508f2e65034adb572cdaa9807cfbe74e044402e03c796887`). Its declarations include **@pierre/diffs 1.3.5**, **@pierre/theme 2.0.0**, **@pierre/theming 1.0.1**, **@pierre/trees 1.0.0-beta.4**, **shiki 3.20.0** (line 28,787), and **@xterm/xterm 5.5.0** (line 9,314). This supplies declared versions absent from packed package metadata. The notice says these packages “may be included”; actual call-site evidence is still needed to attribute an individual minified component. [Preserved notices](../.reference/codex-26.901.41600/bundle-supplement-v1/metadata/Contents/Resources/THIRD_PARTY_NOTICES.txt), [panel attribution](panel-reference.md).

Remaining limits: native framework behavior, OS compositing/font metrics, platform differences, feature flags, backend contracts, hosted services and active user state require separate evidence. Static branches can reveal exact handlers, geometry, animation and persistence intent; their presence does not prove which state is active or demonstrate usable parity. Original Codex live UI was not accessed. No credentials, conversation databases, provider requests, app restart, installed mutation or production reference-asset inclusion occurred.
