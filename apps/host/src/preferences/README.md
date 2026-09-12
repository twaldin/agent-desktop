# Shared app preference state

`PreferencesStore` uses the existing host SQLite `metadata` table under the fixed `preferences.v1` key. It adds no separate database. Legacy-only state keeps its existing format; the first v2 keymap write raises the host schema fence to14 in the same transaction. Construct it with the already leased `HostStore`; it must not open another production host store or perform host recovery itself.

The API is synchronous:

```ts
const preferences = new PreferencesStore(hostStore);
preferences.snapshot(); // { version: 1, records: [...] }, sorted by key
preferences.get("theme.mode"); // full record or undefined, including tombstones
preferences.put({ key: "theme.mode", value: "dark" }); // returns assigned record
preferences.put({ key: "theme.mode", deleted: true }); // explicit reset tombstone
preferences.merge(receivedSnapshot); // { changedKeys, snapshot }
```

`get` and snapshots return fresh values; changing them does not change stored data. The transport must validate peer authorization separately. Snapshot metadata is not an authentication mechanism. Relay records unchanged: the record actor is its originating host, not necessarily the transmitting peer. `merge` parses an unknown input and rejects unsupported versions, unknown fields and invalid values atomically. Emit UI invalidations for `changedKeys`, not for repeated identical snapshots.

Each local change receives `(counter, actor host UUID, unique operation UUID)`. The comparison uses that tuple in order, with locale-independent string comparison and no wall clock. A local write increments the durable maximum observed counter. Receiving a snapshot advances that counter even when an incoming record does not replace the local value. One immediate SQLite transaction commits the clock and all merged keys, including when two connections access the same host database.

This is a map of last-writer-wins registers. Concurrent edits to different keys survive independently. Concurrent edits to the same key pick the same winner on all replicas; an entire `theme.tokens` map or notification settings object is one such value. This conflict policy is for app preferences. It does not replace the separate conflict-preserving draft protocol or imply file/session migration. Unique operations or identical revisions reused with different currently known payloads are rejected. Normal record delivery is idempotent and order-independent.

Snapshots include tombstones. Missing keys are not deletions, and tombstones must not be dropped just because all currently online peers have seen them: an offline peer can still have an older live value. An explicit later write can restore a deleted preference. There is no central owner or global always-online service. These tests establish merge behavior on local temporary databases; they are not evidence of physical tailnet replication.

## Versioned keyboard preferences

The v1 API and `/v1/preferences` routes retain their existing allowlist. `snapshotV2()` / `mergeV2()` expose the full v2 snapshot, including `general.commandKeymap` and reset tombstones. A v1 projection omits that key without deleting it from storage. Peer exchange selects v2 only when authenticated health explicitly advertises `preferencesSyncVersion:2`; failures never trigger a downgraded write.

`mutateCommandKeymap(mutation, definitions)` performs the expected-revision check and complete binding edit inside the existing metadata transaction. Definitions belong to the installed application, never the requesting client; Linux hosts use macOS binding comparison for the supported desktops. Mutations enter through `preferences.keymap.mutate` on `/v11/commands`, with the existing original-ID command receipt rules. Call the `PreferencesSync` wrapper so successful changes invalidate and synchronize. A post-save notification failure reports an uncertain outcome rather than a definite rejection.

Stored v1 bytes are read without migration. The first v2 value or tombstone persists schema14, and later legacy writes/reset cannot lower it. Old schema<=13 binaries must not open a migrated database. Structurally valid future command entries replicate intact, while edits through a registry that does not know them fail closed. The live keymap and its revision are one register; revision checking prevents silent stale edits on a host, while concurrent disconnected hosts still use the existing deterministic register merge.

Pure parser, in-memory transaction and intercepted-network tests cover the new source. Real SQLite migration/rollback, HTTP receipt/restart, physical replication and installed/UI behavior remain unverified under the launch hold; written durable tests are not executed proof.

## Allowlist and rendering contract

- `theme.mode`: system, light or dark.
- `theme.material`: none, sidebar, under-window or hud. `theme.opaqueWindows` stores the requested opaque-window choice; platform support, focus and display constraints determine the effective local backdrop. Those effective conditions are not replicated.
- `theme.tokens`: CSS custom properties from the single `THEME_TOKEN_DEFINITIONS` registry in shared `preferences.ts`. The registry includes colors, font families/sizes/weights, line heights, spacing, radii, border/icon size, opacity and blur. Add practical tokens there as their rendering controls are implemented. A registry entry is not a claim that the current UI already consumes it.
- `theme.background`: none, literal color, ordered gradient stops, or a SHA-256 asset reference with fit/opacity/blur. Never a file path, arbitrary stylesheet, URL or embedded file. Asset transfer, existence/digest checks and local rendering remain separate responsibilities.
- `general.notifications`, `general.reduceMotion`, `general.sendBehavior`: bounded explicit app choices. Native host OMP preferences, models, provider accounts, credentials and paths are not accepted here.
- `git.branchPrefix`: a validated branch-name prefix ending in `/`, or an empty string. Sharing it does not create or switch a branch.
- `connections.keepAwakeWhilePluggedIn`: a boolean request, defaulting to false when absent or deleted. Each desktop applies it using its own AC status, committed local device-access policy and host connection. It neither grants access nor replicates an OS power assertion.
- `sidebar.section.<UUID>`: a bounded display name and numeric sort position.
- `sidebar.project.<UUID>` / `sidebar.session.<UUID>`: host UUID, section UUID (or `pinned`/null) and numeric sort position. These reference catalog entities; merging does not create, move or copy projects/sessions. Use the entity UUID to break equal position ties. If a referenced section is missing/deleted, render the entity in the default section without deleting the entity record.

Window navigation, expanded/collapsed state and panel/sidebar widths stay local. They are not synchronized theme tokens. Sidebar grouping, membership and ordering are shared. Native permissions or account configuration must stay outside this schema.

The shared token parser validates bounded literal forms and numeric ranges, rejecting URL/injection forms and unknown properties. The desktop must also verify concrete CSS property support and retain a usable last-good rendered theme before activating theme-file edits. Font names do not install fonts; availability and actual platform blur/transparency remain device-specific. A background asset reference does not prove that its bytes are present.

The wire format is bounded to 10,000 records, 64 KiB per value and 8 MiB per snapshot. Limits fail explicitly, without partial merge or silent tombstone pruning. Revision counters are positive safe integers; exhaustion fails rather than wrapping. Adding schema fields requires an intentional compatibility decision; an older app rejects unknown fields instead of silently changing their meaning.

## Verification

Run `bun test apps/host/src/preferences/store.test.ts apps/host/src/store.test.ts`. The preference tests use real temporary SQLite host stores and cover same-database connections, stable actor/revision restart, three-store partitions, all six delivery permutations, repeated delivery, deterministic concurrent rename/delete, tombstone persistence and explicit restoration, identity-only sidebar metadata, untouched drafts/catalog, atomic invalid-batch rejection, operation-id tie breaking, payload field-order independence, cloned read results and bounded schema/counter failures. Existing host-store tests additionally exercise recovery, durable command claims after SIGKILL and draft conflict retention.

`general.bottomPanel` (boolean, default true) controls the header launcher; `general.defaultTerminalLocation` (`bottom` or `right`, default `bottom`) sets default terminal placement. Disabling the launcher temporarily routes default terminal openings right without overwriting that stored choice or moving existing tabs. Both use the existing replicated preference records.


Number shortcut targets use inner keymap value version 2, with `primaryNumberShortcutTarget` beside `overrides` under the existing revision. Reads retain legacy inner-v1 bytes. A `number-target` mutation preserves explicit overrides, including unknown future command IDs; ordinary binding edits still require the installed registry and resolve its defaults from the saved target inside the transaction. Reset-all clears overrides while retaining an explicitly stored target. Legacy inner-v1 reset tombstones keep their existing behavior.

The first inner-v2 write or merge raises the SQLite downgrade fence to15 atomically with metadata; reset and later legacy writes cannot lower it. The host advertises `numberTargetVersion:1` for the existing v11 command owner. Clients gate initial target edits and original-ID retries on that capability. Old hosts reject the unknown edit; old inner-v1 clients cannot interpret the new value and require an update. There is no transformed same-revision fallback.

Preference transport3 uses `/v3/preferences/merge` with the existing snapshot2 envelope and inner-v2 values. Authentication and the merge engine are unchanged. Once a local inner-v2 keymap exists, outbound exchange to older peers is declined and the existing unsynchronized-host error is retained; no lossy projection claims number-target delivery. Update all connected hosts for full preference exchange. Older inbound v1/v2 records retain the existing whole-record deterministic merge semantics, including concurrent disconnected edits. This is not field-level merging.
