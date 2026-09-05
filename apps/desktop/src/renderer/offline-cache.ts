export interface OfflineCache { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void> }
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("agent-desktop-offline", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("cache"); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline database could not be opened."));
    request.onblocked = () => reject(new Error("Close older app windows to update the offline database."));
  });
  return database;
}
export const offlineCache: OfflineCache = {
  async read(key) {
    const db = await openDatabase();
    const value = await new Promise<string | null>((resolve, reject) => {
      const request = db.transaction("cache", "readonly").objectStore("cache").get(key);
      request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error("Offline data could not be read."));
    });
    // Preserve caches from the first desktop build while the next durable write migrates them.
    return value ?? localStorage.getItem(key);
  },
  async write(key, value) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("cache", "readwrite");
      transaction.objectStore("cache").put(value, key);
      transaction.oncomplete = () => {
        try { localStorage.removeItem(key); if (key === "agent-desktop:host-catalog:v2") localStorage.removeItem("agent-desktop:host-cache:v1"); } catch { /* The durable database write already succeeded. */ }
        resolve();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("Offline data could not be saved."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline save was interrupted."));
    });
  },
};
