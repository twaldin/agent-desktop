import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface HostStateCompatibility {
  /** Null means that no host database exists yet. */
  checkedSchemaVersion: number | null;
  supportedStateSchemaVersions: number[];
  legacyManifest: boolean;
}

/** Missing metadata belongs to the historical schema-1-only artifacts. */
export function supportedHostStateSchemaVersions(manifest: unknown): { versions: number[]; legacy: boolean } {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid host artifact state-schema metadata.");
  const declared = (manifest as { stateSchemaVersions?: unknown }).stateSchemaVersions;
  if (declared === undefined) return { versions: [1], legacy: true };
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > 32
    || declared.some(value => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)
    || new Set(declared).size !== declared.length) throw new Error("Invalid host artifact stateSchemaVersions: declare a nonempty list of distinct positive SQLite schema versions.");
  return { versions: [...declared], legacy: false };
}

/** Read the latest committed schema, including WAL state, without migrating or creating a database. */
export function checkHostStateCompatibility(manifest: unknown, dataDirectory: string): HostStateCompatibility {
  const { versions, legacy } = supportedHostStateSchemaVersions(manifest);
  const path = join(dataDirectory, "state.sqlite");
  try { if (!statSync(path).isFile()) throw new Error("Host state database is not a regular file."); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { checkedSchemaVersion: null, supportedStateSchemaVersions: versions, legacyManifest: legacy };
    throw error;
  }
  const db = new Database(path, { readonly: true });
  let schema: number;
  try { schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; }
  finally { db.close(); }
  if (!versions.includes(schema)) throw new Error(`Host state schema ${schema} is incompatible with this artifact (supported: ${versions.join(", ")}). Use a compatible host release; no database downgrade or backup restore was performed.`);
  return { checkedSchemaVersion: schema, supportedStateSchemaVersions: versions, legacyManifest: legacy };
}
