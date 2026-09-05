import { ATTACHMENT_CACHE_MAX_BYTES, createAttachmentCache, type AttachmentCacheKey } from "../../apps/desktop/src/renderer/attachment-cache";

const DB = "attachment-cache-acceptance";
const requireValue = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const digest = async (bytes: Blob | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes instanceof Blob ? await bytes.arrayBuffer() : new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
const rejected = async (operation: Promise<unknown>, pattern?: RegExp) => {
  try { await operation; } catch (error) { const value = error as Error; requireValue(!pattern || pattern.test(value.message), `Unexpected failure: ${value}`); return { name: value.name, message: value.message }; }
  throw new Error("Operation unexpectedly reported success.");
};
const nativeOpen = (name: string, version = 1) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(name, version);
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const nativeWrite = (db: IDBDatabase, key: AttachmentCacheKey, value: unknown) => new Promise<void>((resolve, reject) => {
  const transaction = db.transaction("bytes", "readwrite");
  transaction.objectStore("bytes").put(value, [key.hostId, key.sha256]);
  transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
});
const imageFixture = async () => {
  const canvas = document.createElement("canvas"); canvas.width = 3; canvas.height = 2;
  const context = canvas.getContext("2d")!; context.fillStyle = "#f05020"; context.fillRect(0, 0, 3, 2); context.fillStyle = "#20a0f0"; context.fillRect(1, 0, 1, 2);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG fixture encoding failed.")), "image/png"));
};
const cache = () => createAttachmentCache({ databaseName: DB });
type Persistence = { imageHash: string; imageBytes: number; limitHash: string };

async function runInitial() {
  const checks: string[] = [], failureEvidence: Record<string, unknown> = {};
  Object.assign(globalThis, { attachmentCacheProgress: { checks, failureEvidence } });
  const image = await imageFixture(), imageHash = await digest(image), key = { hostId: "host-a", sha256: imageHash };
  let first = cache(); const second = cache();
  const localStorageBefore = JSON.stringify(Object.entries(localStorage));
  try {
    await first.put(key, image);
    const saved = await first.get(key); requireValue(saved instanceof Blob && saved.type === "application/octet-stream", "Store verified bytes in a neutral-MIME Blob.");
    requireValue(await digest(saved!) === imageHash, "Read exact PNG bytes.");
    const decoded = await createImageBitmap(saved!); requireValue(decoded.width === 3 && decoded.height === 2, "The saved bytes decode as the actual PNG fixture."); decoded.close();
    checks.push("actual PNG binary roundtrip and decode");

    requireValue(await second.get({ ...key, hostId: "host-b" }) === null, "Never substitute another owner's content.");
    requireValue(await first.get({ ...key, sha256: "0".repeat(64) }) === null, "Never substitute another hash.");
    failureEvidence.wrongHash = await rejected(first.put({ ...key, sha256: "0".repeat(64) }, image), /SHA-256/);
    await second.put({ ...key, hostId: "host-b" }, image);
    checks.push("explicit owner and hash isolation");

    const mutable = new Uint8Array(await image.arrayBuffer()), mutableKey = { hostId: "captured-owner", sha256: imageHash };
    const pending = first.put(mutableKey, mutable);
    mutable.fill(0); mutableKey.hostId = "late-owner"; mutableKey.sha256 = "0".repeat(64);
    await pending;
    requireValue(await digest((await first.get({ hostId: "captured-owner", sha256: imageHash }))!) === imageHash, "Capture mutable bytes and key before any await.");
    requireValue(await first.get({ hostId: "late-owner", sha256: imageHash }) === null, "Late owner mutation cannot redirect storage.");
    checks.push("caller buffer and owner snapshot before await");

    const add = IDBObjectStore.prototype.add; let duplicateCollisions = 0;
    IDBObjectStore.prototype.add = function(value, key) {
      const request = add.call(this, value, key);
      request.addEventListener("error", () => { if (request.error?.name === "ConstraintError") duplicateCollisions++; });
      return request;
    };
    try { await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).put({ hostId: "racing-owner", sha256: imageHash }, image))); }
    finally { IDBObjectStore.prototype.add = add; }
    requireValue(duplicateCollisions > 0, "Exercise actual concurrent add collisions, not only sequential idempotency.");
    requireValue(await digest((await first.get({ hostId: "racing-owner", sha256: imageHash }))!) === imageHash, "Concurrent duplicate bytes remain correct.");
    checks.push("two native IDB connections and actual duplicate constraint races");

    const raw = await nativeOpen(DB);
    try {
      await nativeWrite(raw, key, new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }));
      failureEvidence.corruptRead = await rejected(first.get(key), /SHA-256/);
      failureEvidence.corruptDuplicate = await rejected(first.put(key, image), /SHA-256/);
      requireValue(await digest((await second.get({ ...key, hostId: "host-b" }))!) === imageHash, "Corruption cannot substitute or damage a different owner.");
      await nativeWrite(raw, key, "not binary"); failureEvidence.malformedRecord = await rejected(first.get(key), /binary/);
      await nativeWrite(raw, key, image);
    } finally { raw.close(); }
    checks.push("actual corrupt bytes and malformed records reject without silent repair");

    let requestSucceeded = false, strictDurability: string | undefined;
    IDBObjectStore.prototype.add = function(value, key) {
      const request = add.call(this, value, key); strictDurability = this.transaction.durability;
      request.addEventListener("success", () => { requestSucceeded = true; this.transaction.abort(); });
      return request;
    };
    const abortedKey = { hostId: "aborted-owner", sha256: imageHash };
    try { failureEvidence.abortAfterRequestSuccess = await rejected(first.put(abortedKey, image), /abort/i); }
    finally { IDBObjectStore.prototype.add = add; }
    requireValue(requestSucceeded && strictDurability === "strict", "Exercise native add success then abort, with strict durability hint.");
    requireValue(await first.get(abortedKey) === null, "An aborted successful request leaves no saved attachment.");
    checks.push("write waits for transaction commit and rejects actual late abort");

    const closing = cache(), closingKey = { hostId: "closing-owner", sha256: imageHash };
    IDBObjectStore.prototype.add = function(value, key) { const request = add.call(this, value, key); request.addEventListener("success", () => closing.close()); return request; };
    try { failureEvidence.closedWrite = await rejected(closing.put(closingKey, image), /abort|closed/i); }
    finally { IDBObjectStore.prototype.add = add; closing.close(); }
    await rejected(closing.get(key), /closed/);
    requireValue(await first.get(closingKey) === null, "Close aborts the unfinished transaction.");
    first.close(); await rejected(first.get(key), /closed/); first = cache();
    requireValue(await digest((await first.get(key))!) === imageHash, "New instance reopens existing durable binary data.");
    checks.push("close aborts unfinished writes; a new instance reopens committed bytes");

    const futureName = "attachment-cache-future-schema", future = await nativeOpen(futureName, 2); future.close();
    const retrying = createAttachmentCache({ databaseName: futureName });
    failureEvidence.open = await rejected(retrying.get(key)); requireValue((failureEvidence.open as {name:string}).name === "VersionError", "Native version mismatch supplies a real open failure.");
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(futureName); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    requireValue(await retrying.get(key) === null, "A failed native open can recover on the same instance."); retrying.close();
    checks.push("actual native open failure and subsequent retry recovery");

    const limit = new Uint8Array(ATTACHMENT_CACHE_MAX_BYTES); limit[0] = 27; limit[limit.length - 1] = 91;
    const limitHash = await digest(limit); await first.put({ hostId: "limit-owner", sha256: limitHash }, limit);
    requireValue((await first.get({ hostId: "limit-owner", sha256: limitHash }))?.size === ATTACHMENT_CACHE_MAX_BYTES, "Exactly20MiB roundtrips through native storage.");
    failureEvidence.oversize = await rejected(first.put({ hostId: "too-large", sha256: imageHash }, new Uint8Array(ATTACHMENT_CACHE_MAX_BYTES + 1)), /20 MiB/);
    checks.push("actual20MiB boundary roundtrip and oversize rejection");

    for (const bad of [{ hostId: "", sha256: imageHash }, { hostId: " host-a", sha256: imageHash }, { hostId: "host-a", sha256: imageHash.toUpperCase() }]) await rejected(first.get(bad));
    requireValue(JSON.stringify(Object.entries(localStorage)) === localStorageBefore, "No binary or metadata is written to localStorage.");
    checks.push("invalid owner/hash rejected and localStorage untouched");
    return { passed: true, checks, failureEvidence, duplicateCollisions, strictDurability, persistence: { imageHash, imageBytes: image.size, limitHash } satisfies Persistence };
  } finally { first.close(); second.close(); }
}

async function probeNativeQuota() {
  const instance = cache(), bytes = new Uint8Array(1024 * 1024); bytes[0] = 82;
  const key = { hostId: "quota-owner", sha256: await digest(bytes) };
  try {
    try { await instance.put(key, bytes); }
    catch (error) {
      requireValue((error as Error).name === "QuotaExceededError", `Unexpected quota-probe error: ${error}`);
      requireValue(await instance.get(key) === null, "A native quota failure must not publish bytes.");
      return { status: "enforced", error: { name: (error as Error).name, message: (error as Error).message } };
    }
    requireValue((await instance.get(key))?.size === bytes.length, "Record the actual native write rather than infer it from a receipt.");
    return { status: "not-enforced", actualWrittenBytes: bytes.length, limitation: "Electron accepted a real1MiB write beyond the reported32KiB CDP quota. Native quota exhaustion is unverified; do not count this probe as a passing failure test." };
  } finally { instance.close(); }
}

async function runControlledQuota() {
  const instance = cache(), bytes = new Uint8Array([1, 2, 3]), key = { hostId: "controlled-quota-owner", sha256: await digest(bytes) };
  const add = IDBObjectStore.prototype.add;
  let invoked = false;
  IDBObjectStore.prototype.add = function() { invoked = true; throw new DOMException("Controlled quota failure at native add boundary.", "QuotaExceededError"); };
  try {
    const error = await rejected(instance.put(key, bytes)); requireValue(invoked && error.name === "QuotaExceededError", "Preserve the supplied native API error.");
    requireValue(await instance.get(key) === null, "The failed add must leave no saved bytes in actual IndexedDB.");
    return { passed: true, check: "controlled QuotaExceededError at native add rejects and actual transaction leaves no record", error, limitation: "Error injected at the browser API boundary; not actual disk exhaustion." };
  } finally { IDBObjectStore.prototype.add = add; instance.close(); }
}

async function runReopened(expected: Persistence) {
  const instance = cache();
  try {
    for (const hostId of ["host-a", "host-b", "captured-owner", "racing-owner"]) {
      const image = await instance.get({ hostId, sha256: expected.imageHash });
      requireValue(image?.size === expected.imageBytes && await digest(image) === expected.imageHash, `Actual process relaunch preserves ${hostId} bytes.`);
    }
    requireValue(await instance.get({ hostId: "missing-owner", sha256: expected.imageHash }) === null, "Owner isolation survives process relaunch.");
    const maximum = await instance.get({ hostId: "limit-owner", sha256: expected.limitHash });
    requireValue(maximum?.size === ATTACHMENT_CACHE_MAX_BYTES, "Maximum-size blob survives actual process relaunch.");
    return { passed: true, checks: ["exact binary hashes after separate Electron process restart", "owner isolation after restart", "20MiB blob persisted across process restart"] };
  } finally { instance.close(); }
}

Object.assign(globalThis, { runAttachmentCacheAcceptance: runInitial, probeAttachmentCacheNativeQuota: probeNativeQuota, runAttachmentCacheControlledQuota: runControlledQuota, runAttachmentCacheReopenAcceptance: runReopened });
