# Startup questions and composer permissions

Frozen source 12 passed the final isolated Electron/native-host acceptance on 2026-09-05. Compact evidence is `.data/app-startup-acceptance-source12-final/summary.json`; raw HTTP observations, native history and six screenshots remain private beside it. The summary records source hashes, exact executed renderer/main/preload artifact hashes, native IDs, command receipts and bounds without the full model catalog. All 161 recorded source and build-file hashes matched before and after this run (`source-before.json`, `source-after.json`, `source-stability.json`). This final run includes the frozen worker IPC 3 and host permission changes that followed run 6.

The run used the real `App`, draft/submission controllers, interaction UI, production command versioning and HTTP transport, `startHost`, and OMP worker/native persistence. Its temporary HOME, native settings, project, data directory and Electron profile were isolated. A fixture IPC adapter forwarded requests to the actual host. A controlled extension asked a native `session_start` confirmation and handled a slash command; worker provider fetch was disabled before SDK import. Font enumeration and native window material were outside this fixture.

Verified outcomes:

- New chat displayed the real startup question before prompt admission. The native session identity was already discoverable; the pending snapshot retained its original prompt and Write permission choice.
- Create and prompt used the versioned permission endpoint. The host session and live native controls reported Write. One explicit Yes response produced exactly one native confirmation entry and one handled command dispatch.
- Text and an Always ask selection edited while admission waited survived acceptance. The app stayed on New chat, then saved the newer draft at revision 4 after its normal debounce. The live session retained Write.
- A second isolated client produced a real selection-only revision conflict. Only the first client's transport delivery was deliberately delayed. Both snapshots showed identical text with distinct Write/Yolo permissions; send stayed disabled until explicit “Keep my draft” saved Write against the new revision.
- A controlled catalog projection omitted permission capability to represent older metadata. The selector became disabled, retained saved Write, and showed the owning-host upgrade explanation. This is presentation evidence, not actual old-host execution.
- The integrated App shortcut listener respected composer commands, handled events, macOS Control text input, search editing, the production model dialog, and native request focus. These used controlled DOM keyboard events; the separate shortcut fixture established trusted Electron input dispatch.

The question, actions and composer controls fit at 1480×968 CSS pixels, 860×900, and a 1060×1000 content window at 125% zoom (848×800 CSS viewport). Six captures reported no horizontal overflow; pending questions stayed within the viewport. Narrow/zoom startup and wide conflict/unsupported images were visually inspected. Long project names truncated or wrapped without overlapping permission controls. Host and hidden Electron exited 0; their temporary runtime/profile were removed.

Run `bun scripts/acceptance/app-startup.ts .data/app-startup-acceptance-<label>`. The runner preserves evidence and shuts down its own host. Recreate a compact report with `bun scripts/acceptance/app-startup-summary.ts <output-directory>`.

Run 4 was the first successful native proof, before the copy clarification; its compact summary remains beside it. Earlier attempts encountered fixture issues: an Electron ESM startup wait, a stale v1 adapter after endpoint versioning, an assertion preceding the draft debounce, and an assertion for old explanatory wording. They do not establish product failures. This acceptance task changed no production source.

Not established: installed-app or cross-device acceptance, OS menu accelerators, actual IME input, native tool Deny/Cancel behavior, startup No/Cancel responses, or a real legacy host. No original Codex app, installed service, real account or provider was used.
