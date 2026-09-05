import { MAX_IMAGE_ATTACHMENT_BYTES } from "../../../../packages/shared/src/attachments";

export type AttachmentCacheKey = { hostId: string; sha256: string };
export interface AttachmentCache {
  put(key: AttachmentCacheKey, bytes: Blob | Uint8Array): Promise<void>;
  get(key: AttachmentCacheKey): Promise<Blob | null>;
  /** Ends this instance and aborts its unfinished transactions. Reopen with a new instance. */
  close(): void;
}

export const ATTACHMENT_CACHE_MAX_BYTES = MAX_IMAGE_ATTACHMENT_BYTES;
const STORE = "bytes";

function snapshotKey(key: AttachmentCacheKey): [string, string] {
  if (!key || typeof key.hostId !== "string" || !key.hostId.length || key.hostId.length > 200
    || key.hostId.trim() !== key.hostId || /[\u0000-\u001f\u007f]/.test(key.hostId)) {
    throw new Error("Attachment cache requires an explicit owning host ID.");
  }
  if (typeof key.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(key.sha256)) {
    throw new Error("Attachment cache requires a canonical SHA-256 hash.");
  }
  return [key.hostId, key.sha256];
}

async function verify(blob: unknown, expectedHash: string): Promise<Blob> {
  if (!(blob instanceof Blob)) throw new Error("Stored attachment is not binary data.");
  if (blob.size > ATTACHMENT_CACHE_MAX_BYTES) throw new Error("Attachment exceeds the 20 MiB local cache limit.");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const actualHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (actualHash !== expectedHash) throw new Error("Attachment bytes do not match their SHA-256 hash.");
  // Content type is supplied by the separately validated metadata, never trusted from this cache.
  return blob.slice(0, blob.size, "application/octet-stream");
}

/** Binary, device-local storage. Owner keys prevent accidental cross-host substitution, not same-origin access. */
export function createAttachmentCache({ databaseName = "agent-desktop-attachments" }: { databaseName?: string } = {}): AttachmentCache {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  const transactions = new Set<IDBTransaction>();
  const requireOpen = () => { if (closed) throw new Error("Attachment cache is closed."); };

  function openDatabase(): Promise<IDBDatabase> {
    requireOpen();
    if (database) return database;
    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => { settled = true; reject(error); };
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => fail(request.error ?? new Error("Attachment database could not be opened."));
      request.onblocked = () => fail(new Error("Close older app windows to open the attachment database."));
      request.onsuccess = () => {
        const db = request.result;
        if (settled || closed) { db.close(); fail(new Error("Attachment cache is closed.")); return; }
        settled = true;
        const release = () => { if (database === attempt) database = undefined; };
        db.onversionchange = () => { db.close(); release(); };
        db.onclose = release;
        resolve(db);
      };
    });
    database = attempt;
    // Failed/blocked opens do not poison this instance forever; late open success is closed above.
    void attempt.catch(() => { if (database === attempt) database = undefined; });
    return attempt;
  }

  async function requestValue(key: [string, string], blob?: Blob): Promise<unknown> {
    const db = await openDatabase();
    requireOpen();
    return new Promise((resolve, reject) => {
      const transaction = blob
        ? db.transaction(STORE, "readwrite", { durability: "strict" })
        : db.transaction(STORE, "readonly");
      transactions.add(transaction);
      let value: unknown;
      const finish = () => transactions.delete(transaction);
      // Request success is insufficient: a later abort/commit failure must still reject the write.
      transaction.oncomplete = () => { finish(); resolve(value); };
      transaction.onabort = () => { finish(); reject(transaction.error ?? new Error("Attachment cache transaction was aborted.")); };
      try {
        const store = transaction.objectStore(STORE);
        const request = blob ? store.add(blob, key) : store.get(key);
        request.onsuccess = () => { value = request.result; };
        // Leave request errors uncancelled so IndexedDB aborts and rolls back the transaction.
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  async function getVerified(key: [string, string]): Promise<Blob | null> {
    const value = await requestValue(key);
    const result = value === undefined ? null : await verify(value, key[1]);
    requireOpen();
    return result;
  }

  return {
    async put(key, bytes) {
      requireOpen();
      const capturedKey = snapshotKey(key);
      // Snapshot both caller-owned keys and mutable typed-array bytes before the first await.
      if (!(bytes instanceof Blob) && !(bytes instanceof Uint8Array)) throw new Error("Attachment cache requires Blob or Uint8Array bytes.");
      const size = bytes instanceof Blob ? bytes.size : bytes.byteLength;
      if (size > ATTACHMENT_CACHE_MAX_BYTES) throw new Error("Attachment exceeds the 20 MiB local cache limit.");
      const snapshot = bytes instanceof Blob ? bytes.slice(0, bytes.size, "application/octet-stream") : new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
      const verified = await verify(snapshot, capturedKey[1]);
      requireOpen();
      if (await getVerified(capturedKey)) return;
      try { await requestValue(capturedKey, verified); }
      catch (error) {
        // Another window may have added the same immutable content after our read.
        if (!(error instanceof DOMException) || error.name !== "ConstraintError" || !await getVerified(capturedKey)) throw error;
      }
      requireOpen();
    },
    async get(key) { requireOpen(); return getVerified(snapshotKey(key)); },
    close() {
      if (closed) return;
      closed = true;
      for (const transaction of transactions) { try { transaction.abort(); } catch { /* Already committed/aborted. */ } }
      if (database) void database.then(db => db.close(), () => {});
    },
  };
}
