import { afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BrowserCreationRecords } from "../browser-creation-records";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
/** Real SQLite for route fixtures. Persistent HostStore/reopen behavior has separate tests. */
export function testBrowserCreationRecords(hostId = "owner") {
  const db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return new BrowserCreationRecords(db, hostId, () => db.exec("PRAGMA user_version = 16"));
}
