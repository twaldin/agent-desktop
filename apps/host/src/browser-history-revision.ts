import { createHash } from "node:crypto";
import type { BrowserHistoryEntry } from "@agent-desktop/shared";

export const browserHistoryRevision = (entries: readonly BrowserHistoryEntry[]): string =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");
