import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { browserCloseIdentity, type BrowserCloseOwner, type BrowserCloseRequest, type BrowserCloseReceipt } from "../../../../packages/shared/src/browser-close";

export const closeOwner: BrowserCloseOwner = { kind: "session", sessionId: "session" };
export const closeInput: BrowserCloseRequest = { requestId: "close-one", controlEpoch: "epoch-one", observedAt: 1000,
  target: { workerPid: 42, name: "original-tab", targetId: "original-target" } };
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** Disposable SQLite and canonical filesystem only. No host, worker, SDK or socket starts. */
export function closeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-close-records-")));
  const store = new HostStore(root), db = new Database(join(root, "state.sqlite"));
  store.upsertSession({ id: "session", hostId: store.host.id, projectId: null, cwd: root, title: "Session", status: "idle",
    sessionFile: join(root, "never-opened.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false });
  const session = store.getSession("session");
  const schema = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const metadata = () => db.query("SELECT key,data FROM metadata ORDER BY key").all();
  const completed = (owner = closeOwner, input = closeInput): BrowserCloseReceipt => ({ ...browserCloseIdentity(store.host.id, owner, input), outcome: "completed", released: true });
  const draft = (): BrowserCloseOwner & { kind: "draft" } => {
    const saved = store.putDraft({ id: "draft", text: "keep unsent", projectId: null, model: null }, 0);
    if (!saved.ok) throw new Error("Could not save fixture draft");
    store.draftBrowserOwners.claim({ id: "session", draftId: "draft", draftRevision: 1, projectId: null, cwd: root });
    return { kind: "draft", ownerId: "session", draftId: "draft", draftRevision: 1 };
  };
  return { root, store, db, session, schema, metadata, completed, draft,
    cleanup: () => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
