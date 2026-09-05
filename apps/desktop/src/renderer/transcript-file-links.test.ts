import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { WorkspaceState } from "./workspace-state";
import { resolveTranscriptLink } from "./transcript-links";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";

// Real temporary filesystem + owning-host API arguments. This is not a physical
// remote-device or installed Electron acceptance test.
test("file-link open uses the owner target and preserves unsaved buffers through native errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-transcript-link-")), root = join(directory, "workspace");
  await mkdir(root); await writeFile(join(root, "a.txt"), "host a\n"); await writeFile(join(root, "b.txt"), "host b\n");
  await writeFile(join(directory, "outside.txt"), "outside fixture\n"); await symlink(join(directory, "outside.txt"), join(root, "escape.txt"));
  const service = new WorkspaceService(root, { worktreeRoot: join(directory, "worktrees") });
  const deliveries: Array<{ target: unknown; hostId: string | undefined }> = [];
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe"> = {
    workspaceQuery: async (target, query, hostId) => { deliveries.push({ target, hostId }); if (query.type !== "file.read") throw new Error("Unexpected fixture request"); return { type: "file.read", content: await service.readText(query.path) }; },
    command: async () => { throw new Error("No file writes are authorized by link navigation"); },
    subscribe: () => () => {},
  };
  const cached = new Map<string, string>();
  const data = new WorkspaceState(bridge, "owning-remote-host", { sessionId: "owning-session" }, { read: async key => cached.get(key) ?? null, write: async (key, value) => { cached.set(key, value); } });
  async function open(href: string) { const link = resolveTranscriptLink(href, root); if (link.kind !== "file") throw new Error("Expected fixture file link"); await data.open(link.file.path); }
  try {
    data.setConnected(true); await data.restore();
    await open("a.txt#L1"); data.edit("a.txt", "my unsaved a\n");
    await open(`${root}/b.txt:1`); expect(data.opened).toBe("b.txt");
    expect(data.documents.get("a.txt")).toMatchObject({ dirty: true, text: "my unsaved a\n" });
    await writeFile(join(root, "a.txt"), "another client a\n"); await open("a.txt");
    expect(data.documents.get("a.txt")).toMatchObject({ dirty: true, text: "my unsaved a\n", conflict: { text: "another client a\n" } });
    await open("missing.txt"); expect(data.errors["file:missing.txt"]).toBeString();
    await open("escape.txt"); expect(data.errors["file:escape.txt"]).toBeString();
    expect(data.documents.has("escape.txt")).toBe(false);
    expect(data.documents.get("a.txt")?.text).toBe("my unsaved a\n");
    expect(deliveries.every(item => item.hostId === "owning-remote-host" && JSON.stringify(item.target) === JSON.stringify({ sessionId: "owning-session" }))).toBe(true);
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("host b\n");
  } finally { data.stop(); await rm(directory, { recursive: true, force: true }); }
});
