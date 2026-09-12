import type { BranchQueryObserverView, LiveBranchQuery, LiveBranchResult } from "@agent-desktop/shared";
import type { BranchQueryObserver } from "./branch-query-observer";

export interface ControlledBranchQueryRequest {
  query: LiveBranchQuery;
  recoveries: number;
  response: {
    resolve(result: LiveBranchResult, requiresRecovery?: boolean): void;
    reject(cause: unknown): void;
  };
}

/** Test-only live query factory. Construction is inert; requests become visible
 * on start, and a disposed observer suppresses every later controlled reply. */
export function controlledBranchQueryObserverFactory(onStart?: (request: ControlledBranchQueryRequest) => void) {
  const requests: ControlledBranchQueryRequest[] = [];
  const createBranchQueryObserver = (query: LiveBranchQuery, listener: (view: BranchQueryObserverView) => void): Pick<BranchQueryObserver, "start" | "dispose" | "recover" | "getSnapshot"> => {
    let view: BranchQueryObserverView = { phase: "connecting" };
    let started = false, disposed = false;
    const publish = (next: BranchQueryObserverView) => {
      if (disposed) return;
      view = structuredClone(next); listener(structuredClone(next));
    };
    let request: ControlledBranchQueryRequest | undefined;
    const response = {
      resolve(result: LiveBranchResult, requiresRecovery = false) {
        publish({ phase: "ready", update: { generation: 1, requiresRecovery, phase: "complete", result } });
      },
      reject(cause: unknown) {
        publish({ phase: "ready", update: { generation: 1, requiresRecovery: false, phase: "failed", error: cause instanceof Error ? cause.message : String(cause) } });
      },
    };
    return {
      getSnapshot: () => structuredClone(view),
      async start() {
        if (started || disposed) return;
        started = true;
        request = { query: structuredClone(query), response, recoveries: 0 };
        requests.push(request); onStart?.(request);
      },
      async recover() { if (request && !disposed) request.recoveries++; },
      async dispose() { disposed = true; view = { phase: "released" }; },
    };
  };
  return { requests, createBranchQueryObserver };
}
