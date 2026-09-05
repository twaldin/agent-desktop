# Native thinking selection persistence

Source13 records a newly created app-owned session's actual `auto` selection before returning its native file. The installed release12 observation remains a failure; this source change does not migrate older histories.

## Cause in pinned OMP 18.1.10

The upstream baseline is release commit `f241301c83726afe75a847e919b89977a54dafbe`.

1. `src/sdk.ts`, `pickInitialThinkingLevel`, gives an explicit model's own default/global thinking precedence over the default role's suffix. An explicitly selected `openai-codex/gpt-5.4-mini` starts in `auto`, with provisional concrete effort `high`, when the global default is `auto`.
2. The SDK's new-session metadata block omits the initial thinking entry for `auto`.
3. `src/session/model-controls.ts`, `applyAutoThinkingLevel`, appends `(effort, configured: "auto")` only when the resolved effort changes. Repeated resolutions of `high` therefore leave no thinking receipt.
4. On reopen, the SDK restores the model but has no explicit model option or thinking receipt. A configured default role's `:max` can now supply thinking, which Mini clamps to fixed `xhigh`.

Release12's Home acceptance session `01a0726c-b537-7000-9d3d-1002851b0a93` exhibited this chain: two native events recorded `configured: auto, resolved: high`, neither submitted command supplied a thinking override, its native history had no thinking entries, and reopen selected `xhigh`. Preserved private evidence is `.data/ui-acceptance/release12-permissions-approved.json` and `release12-permissions-after-restart.json`. Their filtered controls omitted the thinking field; the native events/history and subsequent read-only controls established the result.

## Correction and ownership boundary

`apps/host/src/omp/runtime.ts` calls the public native `SessionManager.appendThinkingLevelChange(native.thinkingLevel, AUTO_THINKING)` after successful SDK construction and before `ensureOnDisk`, only when:

- this is a new app-owned session;
- the constructed native session is actually configured as `auto`; and
- its active branch has no thinking entry already.

The entry uses native IDs, parent linkage, format and persistence. Its initial `high` is the native provisional concrete effort, not a claim that a classifier already ran. Concrete selections retain the SDK's existing entry. Later explicit edits remain native `setThinkingLevel` operations, including native suppression of repeated identical choices.

Existing files without a receipt retain native restore semantics. The app does not infer legacy intent from today's settings, append a guessed `auto`, or rewrite history. An explicit later user selection creates its own native receipt.

## Focused proof

`apps/host/src/omp/thinking-persistence.test.ts` runs the actual SDK/runtime in a child with a temporary HOME, native agent/config/session directories and inert test authentication. Network fetch and preconnect are blocked before native imports. Tests assert zero attempted fetches and unchanged native configuration.

- Before the correction, the Mini/global-auto/default-role-`:max` create→close→reopen test failed with expected `auto`, received `xhigh`; `.data/thinking-selection-source13/red.log` is retained.
- New auto persists one `(high, auto)` entry and survives reopen with the same native identity/model.
- The actual native classifier's unavailable-model fallback resolves unchanged `high` twice. A native event listener aborts before provider dispatch; both inputs are returned through `setPromptDropped`, with no user/assistant messages. The one initial receipt remains and reopen stays auto. This tests the unchanged-resolution branch, not a fabricated successful classifier response.
- Explicit `low`, native role-selected `xhigh`, subsequent concrete/auto edits, repeated selections and an unmodified-SDK legacy file cover concrete behavior, duplicate suppression and the no-migration boundary.
- `apps/host/src/omp-workers/runtime.test.ts` repeats creation/resume across replacement Bun workers and checks worker metadata, controls, native identity and the original receipt.

These are source13 native-file/worker contracts. The installed proof below is separate; no explicit correction of the release12 session was performed.

## Installed release 13 proof

Home's actual packaged composer created session `01a0729e-dd6e-7000-a520-bca904b64e6f` using the explicit Mini model and native default Auto, with no submitted thinking override. Its real provider returned the bounded requested response and called no tools. Native entry `e903a271` records `(high, auto)` before user entry `33f84a32`; the prompt admission receipt names that user entry. Both actual Mac interfaces displayed Auto.

After a clean owning-host restart, the model, Auto selection and original native receipt remained identical. The catalog/drafts and backup matched; every native file retained its original byte prefix, with only verified `session_exit` appends. The test session still contained exactly one user/assistant pair and no tool calls. Shared New chat defaults were restored deliberately at revision 21 before the restart; the older unsent draft remained exactly revision 16.

Work's renderer observer captured the disconnected banner at `2026-09-05T17:36:21.203Z` and recovery at `17:36:27.808Z`, preserving the selected session, response and Auto across all observed states. Home's OS captures and native accessibility inspection verified the restored interface. These checks do not migrate legacy histories or establish all model/default combinations.

Private evidence: `.data/ui-acceptance/release13-installed-auto-result.json`, `release13-auto-restart-preservation.json`, `work-desktop13-home-restart-observed.json`, `work-desktop13-auto-post-restart-ui.json`, `release13-home-auto-draft-os.png` and `release13-home-auto-restored-os.png`.
