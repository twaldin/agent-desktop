import { expect, test } from "bun:test";
import { ATTACHMENT_CACHE_MAX_BYTES, createAttachmentCache } from "./attachment-cache";

// Boundary guards only. Native storage/transactions/restart are exercised by
// scripts/acceptance/attachment-cache.ts in real isolated Electron IndexedDB.
test("cache rejects missing owner, ambiguous identity, and oversized input before storage", async () => {
  const cache = createAttachmentCache();
  const hash = "a".repeat(64);
  try {
    for (const hostId of ["", " owner", "owner\n", "x".repeat(201)]) {
      await expect(cache.get({ hostId, sha256: hash })).rejects.toThrow("owning host");
    }
    for (const sha256 of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      await expect(cache.put({ hostId: "owner", sha256 }, new Uint8Array([1]))).rejects.toThrow("SHA-256");
    }
    await expect(cache.put({ hostId: "owner", sha256: hash }, new Uint8Array(ATTACHMENT_CACHE_MAX_BYTES + 1))).rejects.toThrow("20 MiB");
  } finally { cache.close(); }
});

test("a closed cache instance cannot silently create a new database", async () => {
  const cache = createAttachmentCache(), key = { hostId: "owner", sha256: "b".repeat(64) };
  cache.close(); cache.close();
  await expect(cache.get(key)).rejects.toThrow("closed");
  await expect(cache.put(key, new Blob(["bytes"]))).rejects.toThrow("closed");
});
