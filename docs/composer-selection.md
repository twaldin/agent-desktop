# Composer selection reconciliation

Release 10 implements the model/reasoning portion of [composer-parity.md](composer-parity.md). The installed checks below extend through release 11; they do not close the remaining composer scope.

## Owning workspace and native defaults

`POST /v1/models/composer` accepts `{target?: WorkspaceTarget, refresh?: boolean}`. A target contains a catalog `projectId` or `sessionId`; the owning host resolves its cwd. Raw cwd values and unknown targets are rejected. The existing authenticated Settings HTTP path bounds inputs, returns `Cache-Control: no-store`, and avoids credential/event/command journals. The desktop calls `getComposerCatalog(target?, refresh?, hostId?)`.

The existing discovery worker performs the read through `OmpRuntime.getComposerCatalog`. Worker protocol 2 remains intact. Refresh uses a fresh native settings/model/auth discovery context. The operation creates no session, writes no configuration, invokes no provider prompt and does not execute session extension factories. Native discovery itself retains its normal provider metadata behavior.

`omp-settings/composer.ts` calls the pinned OMP 18.1.10 helpers at release commit `f241301c83726afe75a847e919b89977a54dafbe`:

- `config/model-resolver.ts`: `getModelMatchPreferences`, `resolveAllowedModels`, `resolveModelRoleValue`, `pickDefaultAvailableModel`. Configured role aliases/patterns and the enabled-model allowlist are resolved natively; the fallback uses native configured/concrete authentication checks.
- `thinking.ts`: `parseConfiguredThinkingLevel`, `concreteThinkingLevel`, `resolveThinkingLevelForModel`, `resolveProvisionalAutoLevel`. A configured default-role suffix wins over model default thinking, then the native settings default. The `auto` result is provisional, not a fixed prediction of each turn.
- `sdk.ts:1508`, `sdk.ts:1595`, `sdk.ts:2650`: native session startup establishes the corresponding role/thinking/fallback precedence and retries after extension/model discovery.

The public catalog projects only model identity, display name, input types, limits, reasoning levels, native authentication/availability flags, disabled-provider state and thinking defaults. URLs, headers, credential objects and secrets are not copied.

The result explicitly declares `resolution: "native-registry-preview"`. Actual session startup remains authoritative and can register extension-defined models absent from a metadata-only discovery context. Projectless preview uses the host discovery cwd; a new projectless session later receives its own private cwd. Path-sensitive startup or extension behavior can therefore differ. A null draft does not force the preview's model onto that session.

## Current session versus draft selection

| State | Result |
|---|---|
| Fresh existing-session draft | Seeds its project and leaves `model: null`; the next prompt follows the session's current native model. |
| New-chat draft with null model | Shows the selected project's resolved native default and exposes its reasoning levels without storing a model override. |
| Explicit draft model | Preserved through native Settings/account events and navigation; submission sends the captured choice. |
| Legacy non-null session draft | Preserved conservatively. Release 9's automatically seeded model is indistinguishable from a user-selected model in its saved schema. No migration guesses intent. |
| Saved draft model differs from current native session | Displays both selections and a “Follow current session model and reasoning” action. That explicit action clears the model/thinking override through the existing draft revision path. |
| Existing worker model definition differs from refreshed catalog | Matching `getSessionControls().capabilities` wins for current-session reasoning. A running worker retains its loaded native model definition until reopened. |
| Draft edited while submission is pending | Existing captured submission and revision logic remains authoritative; later edits survive acceptance of the earlier snapshot. |

`ComposerCatalogState` belongs to one host plus catalog target. Host/project/session changes create a different context. Native settings/account invalidations trigger refresh; late results after invalidation, disconnect or unmount cannot replace newer context. Current-session model changes refresh its native controls. Errors remain visible and retain loaded metadata and saved choices. There is no fallback to the host-wide `state.models` catalog. A mounted disconnected view keeps its last loaded catalog; remounting offline may have no catalog, but the persisted draft choice remains visible.

## Rolling desktop/host versions

A release 10 desktop can query an older host. `main/composer-transport.ts` negotiates while HTTP status is still structured, before Electron strips custom Error properties. Only a parsed HTTP 404 without an unrelated error code triggers the older `/v1/models/capabilities` endpoint, with the **same owning endpoint, target and refresh value**.

This compatibility result declares `resolution: "legacy-capabilities"`, `cwd: null`, and `default.source: "unknown-older-host"`. Authentication, disabled-provider state, availability and the new-chat native default remain unknown. The UI labels unknown availability and the unresolved default, preserves existing session controls and offers an owning-host upgrade notice. Explicit models still expose the older endpoint's supported reasoning selectors.

Authentication/authorization failures, 400/500/503 responses, unrelated coded 404 responses, malformed bodies, connection failure and failure of the compatibility endpoint remain errors. They do not trigger a global catalog fallback or fabricate a default. Missing support in an older desktop preload gives a clear desktop-update error instead.

## Validation and remaining acceptance

- Actual Bun discovery-worker/native registry test: two temporary project contexts resolve different configured model roles and high/low thinking; a third context inherits the global role. Disabled-provider state and an unmatched enabled-model allowlist are verified. Global/project files remain unchanged, credential fields are absent and no native session JSONL is created (10 assertions).
- Worker runtime plus lifecycle suite: 21 passing tests / 19,268 assertions, including the new metadata test and existing protocol-2 startup, acknowledgement, disposal, crash isolation, native account/interaction and resume contracts. No provider inference.
- Settings HTTP fixture uses the actual worker and temporary native stores. Composer route, no-store response, catalog target validation, rejected raw cwd/unknown target/non-boolean refresh and credential exclusion pass.
- Final renderer selection/draft/submission plus real HTTP transport run: 26 passing tests / 152 assertions, including older-host compatibility and unsafe-fallback rejection. Renderer cases use controlled transport and static React markup; they are not installed UI acceptance.
- `bun run typecheck` passes after the compatibility additions.

Installed Home 10 against Work 9 verified older-host compatibility labels and preserved existing mini/auto controls. A real native Settings thinking change refreshed Home's composer; restoring the original control left its exact draft unchanged. Home 11 then verified actual catalog search and keyboard selection, a saved 5.5 draft override while the session stayed on mini, the explicit follow-current action, and restoration of the original draft values. No provider turn ran in these checks. Evidence: `.data/ui-acceptance/release10-work9-composer.json`, `release10-composer-thinking.json`, `release11-model-override.json`, and `release11-model-follow-current.json`.

Actual project-default changes, native Settings model changes against both kinds of draft, broader reconnect cases and the complete geometry matrix remain separate acceptance work. [model-picker.md](model-picker.md) records the new searchable controls. Owner/workspace summaries, pending-session ownership, permission/account intent, attachments, queue controls and history/keyboard behavior remain in the parity audit.
