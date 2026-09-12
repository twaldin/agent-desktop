// Search metadata and original-target observation IPC cannot be cancelled.
// Keep their admission shared across effect rounds,
// bridge replacements and hook remounts in this renderer until each call settles.
let activeMetadataReads = 0;
const waitingMetadataReads = new Set<() => void>();
export function readBrowserMetadataLimited<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(undefined); return; }
    const cancelQueued = () => {
      if (waitingMetadataReads.delete(start)) resolve(undefined);
    };
    const start = () => {
      waitingMetadataReads.delete(start);
      signal.removeEventListener("abort", cancelQueued);
      if (signal.aborted) { resolve(undefined); return; }
      activeMetadataReads++;
      void (async () => {
        try { resolve(await read()); }
        catch (error) { reject(error); }
        finally {
          activeMetadataReads--;
          waitingMetadataReads.values().next().value?.();
        }
      })();
    };
    if (activeMetadataReads < 4) start();
    else {
      waitingMetadataReads.add(start);
      signal.addEventListener("abort", cancelQueued, { once: true });
    }
  });
}
