import { expect, test } from "bun:test";
import type { DesktopEvent } from "@agent-desktop/shared";
import { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";

test("shared workspace panes retain one host subscription until the final release", () => {
  const listeners = new Set<(event: DesktopEvent) => void>();
  let starts = 0, stops = 0;
  const data = new WorkspaceState({
    workspaceQuery: async () => { throw new Error("No query expected"); },
    command: async () => { throw new Error("No command expected"); },
    subscribe: listener => { starts++; listeners.add(listener); return () => { stops++; listeners.delete(listener); }; },
  }, "offline-owner", { projectId: "project" }, { read: async () => null, write: async () => {} });

  const releaseFiles = retainWorkspace(data), releaseReview = retainWorkspace(data);
  expect({ starts, stops, listeners: listeners.size }).toEqual({ starts: 1, stops: 0, listeners: 1 });
  releaseFiles(); releaseFiles();
  expect({ starts, stops, listeners: listeners.size }).toEqual({ starts: 1, stops: 0, listeners: 1 });
  releaseReview();
  expect({ starts, stops, listeners: listeners.size }).toEqual({ starts: 1, stops: 1, listeners: 0 });

  const releaseRestoredPane = retainWorkspace(data);
  expect({ starts, stops, listeners: listeners.size }).toEqual({ starts: 2, stops: 1, listeners: 1 });
  releaseRestoredPane();
  expect({ starts, stops, listeners: listeners.size }).toEqual({ starts: 2, stops: 2, listeners: 0 });
});
