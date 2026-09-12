import { expect, test } from "bun:test";
// Select the actual App callback without evaluating App's unrelated mounted effects.
const source = await Bun.file(new URL("./App.tsx", import.meta.url)).text();
const start = source.indexOf("  async function archiveSidebarSession(");
const end = source.indexOf("  async function rename(", start);
if (start < 0 || end < start) throw new Error("App sidebar archive callback was not found");
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));

function harness(connected = true, failure?: string) {
  const calls: unknown[] = [], refreshes: string[] = [], errors: Array<string | null> = [];
  const desktop = { catalog: {
    records: new Map([
      ["selected-host", { connected: true, state: { sessions: [{ id: "same-id" }] } }],
      ["row-host", { connected, state: { sessions: [{ id: "same-id" }] } }],
    ]),
    refreshHost: async (host: string) => { refreshes.push(host); },
  } };
  const bridge = { command: async (envelope: unknown, host: string) => {
    calls.push({ envelope, host });
    return failure ? { ok: false, error: { message: failure } } : { ok: true };
  } };
  const archive = new Function("desktop", "bridge", "setActionError", "errorMessage", `${compiled}; return archiveSidebarSession;`)(
    desktop, bridge, (message: string | null) => errors.push(message), (error: Error) => error.message,
  ) as (session: string, host: string, archived: boolean) => Promise<void>;
  return { archive, calls, refreshes, errors };
}

test("App archives the clicked row on its owner even when another host has the same session ID", async () => {
  const h = harness();
  await h.archive("same-id", "row-host", true);
  expect(h.calls).toEqual([{ host: "row-host", envelope: {
    id: expect.any(String), command: { type: "session.archive", sessionId: "same-id", archived: true },
  } }]);
  expect(h.refreshes).toEqual(["row-host"]);
  expect(h.errors).toEqual([null]);
});

test("a disconnected or missing row owner cannot dispatch an archive", async () => {
  for (const host of ["row-host", "missing-host"]) {
    const h = harness(false);
    await h.archive("same-id", host, true);
    expect(h.calls).toEqual([]);
    expect(h.refreshes).toEqual([]);
    expect(h.errors.at(-1)).toContain("Reconnect");
  }
});

test("an unsuccessful unarchive is surfaced without refreshing as if it succeeded", async () => {
  const h = harness(true, "Archive update refused");
  await h.archive("same-id", "row-host", false);
  expect(h.calls).toEqual([{ host: "row-host", envelope: {
    id: expect.any(String), command: { type: "session.archive", sessionId: "same-id", archived: false },
  } }]);
  expect(h.refreshes).toEqual([]);
  expect(h.errors.at(-1)).toBe("Archive update refused");
});
