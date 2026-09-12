import type {
  PullRequestAvailability,
  PullRequestDetailResult,
  PullRequestInboxResult,
} from "../../../../packages/shared/src/pull-requests";
import type { PullRequestWindowView } from "../pull-request-window-state";
import { pullRequestKey } from "./pull-request-pages";
import { pullRequestQuery } from "./pull-request-query";

export interface PullRequestSnapshot {
  availability?: PullRequestAvailability;
  inbox?: PullRequestInboxResult;
  detail?: PullRequestDetailResult;
}
/** Window-local read cache. Closing the page does not grant a cached account authority to read. */
export class PullRequestCache {
  #entries = new Map<
    string,
    { savedAt: number; bytes: number; value: PullRequestSnapshot }
  >();
  constructor(private readonly now = Date.now) {}
  get(hostId: string): PullRequestSnapshot | undefined {
    const entry = this.#entries.get(hostId);
    if (!entry) return;
    if (this.now() - entry.savedAt > 600_000) {
      this.#entries.delete(hostId);
      return;
    }
    return entry.value;
  }
  put(hostId: string, value: PullRequestSnapshot): void {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    this.#entries.delete(hostId);
    if (bytes > 12 * 1024 * 1024) return;
    this.#entries.set(hostId, { savedAt: this.now(), bytes, value });
    let total = [...this.#entries.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    while (this.#entries.size > 8 || total > 24 * 1024 * 1024) {
      const first = this.#entries.entries().next().value!;
      total -= first[1].bytes;
      this.#entries.delete(first[0]);
    }
  }
}

/** Cached content must match the restored presentation before the first offline render. */
export function pullRequestSnapshotForView(
  snapshot: PullRequestSnapshot | undefined,
  view: PullRequestWindowView,
): PullRequestSnapshot {
  const filters = pullRequestQuery(view.filters, view.filters.search).filters;
  return {
    availability: snapshot?.availability,
    inbox:
      snapshot?.inbox?.account.id === view.accountId &&
      JSON.stringify(snapshot.inbox.filters) === JSON.stringify(filters)
        ? snapshot.inbox
        : undefined,
    detail:
      snapshot?.detail?.account.id === view.accountId &&
      view.selected &&
      pullRequestKey(snapshot.detail.summary.pullRequest) ===
        pullRequestKey(view.selected)
        ? snapshot.detail
        : undefined,
  };
}
