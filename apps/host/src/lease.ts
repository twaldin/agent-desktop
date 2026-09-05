import { FileLock } from "@oh-my-pi/pi-natives";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function acquireHostLease(dataDirectory: string): FileLock {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const lease = FileLock.tryAcquire(join(realpathSync(dataDirectory), "host-owner.lock"));
  if (!lease.acquired) throw new Error("Another host service already owns this data directory.");
  return lease;
}
