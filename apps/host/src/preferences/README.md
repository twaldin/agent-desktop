# Shared app preference state

`PreferencesStore` uses the existing host SQLite `metadata` table under the fixed `preferences.v1` key. It adds no database or schema migration. Construct it with the already leased `HostStore`; it must not open another production host store or perform host recovery itself.

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

## Allowlist and rendering contract

- `theme.mode`: system, light or dark.
- `theme.tokens`: CSS custom properties from the single `THEME_TOKEN_DEFINITIONS` registry in shared `preferences.ts`. The registry includes colors, font families/sizes/weights, line heights, spacing, radii, border/icon size, opacity and blur. Add practical tokens there as their rendering controls are implemented. A registry entry is not a claim that the current UI already consumes it.
- `theme.background`: none, literal color, ordered gradient stops, or a SHA-256 asset reference with fit/opacity/blur. Never a file path, arbitrary stylesheet, URL or embedded file. Asset transfer, existence/digest checks and local rendering remain separate responsibilities.
- `general.notifications`, `general.reduceMotion`, `general.sendBehavior`: bounded explicit app choices. Native host OMP preferences, models, provider accounts, credentials and paths are not accepted here.
- `sidebar.section.<UUID>`: a bounded display name and numeric sort position.
- `sidebar.project.<UUID>` / `sidebar.session.<UUID>`: host UUID, section UUID (or `pinned`/null) and numeric sort position. These reference catalog entities; merging does not create, move or copy projects/sessions. Use the entity UUID to break equal position ties. If a referenced section is missing/deleted, render the entity in the default section without deleting the entity record.

Window navigation, expanded/collapsed state and panel/sidebar widths stay local. They are not synchronized theme tokens. Sidebar grouping, membership and ordering are shared. Native permissions or account configuration must stay outside this schema.

The shared token parser validates bounded literal forms and numeric ranges, rejecting URL/injection forms and unknown properties. The desktop must also verify concrete CSS property support and retain a usable last-good rendered theme before activating theme-file edits. Font names do not install fonts; availability and actual platform blur/transparency remain device-specific. A background asset reference does not prove that its bytes are present.

The wire format is bounded to 10,000 records, 64 KiB per value and 8 MiB per snapshot. Limits fail explicitly, without partial merge or silent tombstone pruning. Revision counters are positive safe integers; exhaustion fails rather than wrapping. Adding schema fields requires an intentional compatibility decision; an older app rejects unknown fields instead of silently changing their meaning.

## Verification

Run `bun test apps/host/src/preferences/store.test.ts apps/host/src/store.test.ts`. The preference tests use real temporary SQLite host stores and cover same-database connections, stable actor/revision restart, three-store partitions, all six delivery permutations, repeated delivery, deterministic concurrent rename/delete, tombstone persistence and explicit restoration, identity-only sidebar metadata, untouched drafts/catalog, atomic invalid-batch rejection, operation-id tie breaking, payload field-order independence, cloned read results and bounded schema/counter failures. Existing host-store tests additionally exercise recovery, durable command claims after SIGKILL and draft conflict retention.
