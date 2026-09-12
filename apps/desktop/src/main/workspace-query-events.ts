import type { BranchQueryRequest, RepositoryWatchRequest } from "@agent-desktop/shared";
import type { BranchQueryConnection } from "./branch-query-connection";
import type { RepositoryWatchConnection } from "./repository-watch-connection";

/** One socket failure invalidates both logical clients before any further send. */
export function attachWorkspaceQueryEvents(watches: RepositoryWatchConnection, branches: BranchQueryConnection, transport: {
  isCurrent(): boolean; send(request: RepositoryWatchRequest | BranchQueryRequest): void; close(reason: string): void;
}) {
  let ended = false;
  let watchEvents: ReturnType<RepositoryWatchConnection["attach"]> | undefined;
  let branchEvents: ReturnType<BranchQueryConnection["attach"]> | undefined;
  const finish = (reason: string, close: boolean) => {
    if (ended) return;
    ended = true;
    watchEvents?.disconnected(reason); branchEvents?.disconnected(reason);
    if (close && transport.isCurrent()) transport.close(reason);
  };
  const shared = {
    send(request: RepositoryWatchRequest | BranchQueryRequest) {
      if (ended || !transport.isCurrent()) throw new Error("Workspace query socket is unavailable.");
      transport.send(request);
    },
    close: (reason: string) => finish(reason, true),
  };
  if (transport.isCurrent()) watchEvents = watches.attach(shared);
  if (!ended && transport.isCurrent()) branchEvents = branches.attach(shared);
  else finish("Workspace query socket was replaced during attachment.", false);
  // An observer can synchronously end the connection during attach delivery.
  if (ended || !transport.isCurrent()) { finish("Workspace query socket was replaced during attachment.", false); watchEvents?.disconnected(); branchEvents?.disconnected(); }
  return {
    /** True consumes connection-local frames (or a failed state), never an event cursor. */
    receive(value: unknown): boolean {
      if (!transport.isCurrent()) finish("Workspace query socket was replaced.", false);
      if (ended) return true;
      if (!value || typeof value !== "object") return false;
      const type = (value as { type?: unknown }).type;
      if (type === "repository-watch") { watchEvents!.receive(value); return true; }
      if (type === "branch-query") { branchEvents!.receive(value); return true; }
      if (type === "state") {
        watchEvents!.receive(value);
        if (!ended) branchEvents!.receive(value);
      }
      return ended;
    },
    disconnected: (reason = "Workspace query socket disconnected.") => finish(reason, false),
  };
}
