import type { LocalWindowBridge } from "../window-state";
import { parseProcessJournalScope, parseProcessOperationEntries, type ProcessJournalScope, type ProcessOperationMetadata } from "../session-process-journal";

/** The synchronous main-process reply is sent after file and directory fsync.
 * Promise resolution here is that acknowledgement, not a React layout save. */
export function createSessionProcessesJournal(bridge: LocalWindowBridge | undefined) {
  return {
    async load(scope: ProcessJournalScope): Promise<ProcessOperationMetadata[]> {
      if (!bridge?.readProcessOperations) throw new Error("Process operation storage is unavailable in this window.");
      const result = bridge.readProcessOperations(parseProcessJournalScope(scope));
      if (result.error) throw new Error(result.error);
      return parseProcessOperationEntries(result.entries);
    },
    async save(scope: ProcessJournalScope, entries: readonly ProcessOperationMetadata[]): Promise<void> {
      if (!bridge?.saveProcessOperations) throw new Error("Process operation storage is unavailable in this window.");
      const result = bridge.saveProcessOperations(parseProcessJournalScope(scope), parseProcessOperationEntries(entries));
      if (result.error) throw new Error(result.error);
    },
  };
}
