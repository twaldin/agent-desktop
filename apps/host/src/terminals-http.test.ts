import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager, TerminalError } from "./terminals";
import { TerminalsHttp } from "./terminals-http";
import type { TerminalInfo, TerminalInputRequest, TerminalInvalidation, TerminalViewerLease } from "../../../packages/shared/src/terminals";
import { Terminal } from "@xterm/xterm";
import { separateXtermReplies, binaryTerminalInput, type ParsedTerminalReply } from "../../desktop/src/renderer/xterm-input";
import { OrderedTerminalInput, TerminalReplayCursor } from "../../desktop/src/renderer/terminal-state";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for actual HTTP terminal output"); await Bun.sleep(10); }
}
async function fixture(viewerLeaseMs?: number) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-desktop-terminal-http-")); const target = { projectId: crypto.randomUUID() };
  const notifications: TerminalInvalidation[] = [];
  const manager = new TerminalManager({ maximumOutputBytes: 4096, shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"], environment: { HISTFILE: "/dev/null", BASH_ENV: "/dev/null", ENV: "/dev/null", PS1: "", BASH_SILENCE_DEPRECATION_WARNING: "1" } } });
  const adapter = new TerminalsHttp({ manager, viewerLeaseMs, resolveTarget: owner => { if (!("projectId" in owner) || owner.projectId !== target.projectId) throw new TerminalError("WORKSPACE_NOT_FOUND", "Unknown fixture project"); return cwd; }, invalidate: event => { notifications.push(event); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => await adapter.handle(request) ?? new Response("Not found", { status: 404 }) });
  cleanups.push(async () => { adapter.dispose(); await manager.shutdown(); server.stop(true); await rm(cwd, { recursive: true, force: true }); });
  const post = async (route: string, body: unknown) => fetch(`${server.url}v1/terminals/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await post("action", { type: "create", options: { target, cols: 80, rows: 24 } }); expect(response.status).toBe(200);
  const { terminal } = await response.json() as { terminal: TerminalInfo };
  manager.write(terminal.id, "set +H; stty -echo; printf '\\nHTTP_READY\\n'\r");
  await until(() => manager.replay(terminal.id).chunks.map(chunk => chunk.data).join("").includes("\r\nHTTP_READY\r\n"));
  return { cwd, target, terminal, manager, adapter, server, post, notifications };
}

describe("terminal HTTP and renderer transport against actual shells", () => {
  test("catalog authority and bounded schema are enforced before starting shells", async () => {
    const f = await fixture();
    expect((await f.post("action", { type: "create", options: { target: f.target, cwd: "/tmp" } })).status).toBe(400);
    expect((await f.post("action", { type: "create", options: { target: { projectId: crypto.randomUUID() } } })).status).toBe(404);
    expect((await f.post("action", { type: "create", options: { target: f.target, env: { UNRELATED: "not-allowed" } } })).status).toBe(400);
    expect((await f.post("action", { type: "input", terminalId: f.terminal.id, data: "no" })).status).toBe(400);
    expect((await fetch(`${f.server.url}v1/terminals/query`)).status).toBe(405);
    expect((await f.post("query", { type: "list", target: f.target }).then(response => response.json()) as { terminals: TerminalInfo[] }).terminals).toHaveLength(1);
    const oversized = await fetch(`${f.server.url}v1/terminals/input`, { method: "POST", body: " ".repeat(512 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    expect(f.manager.list()).toHaveLength(1);
  });

  test("duplicate, changed and reordered input requests cannot execute a second time", async () => {
    const f = await fixture(); const clientId = crypto.randomUUID();
    const first = { terminalId: f.terminal.id, clientId, sequence: 1, data: "printf a >> ordered.txt\r" };
    const second = { terminalId: f.terminal.id, clientId, sequence: 2, data: "printf b >> ordered.txt\r" };
    expect((await f.post("input", second)).status).toBe(409);
    const duplicates = await Promise.all([f.post("input", first), f.post("input", first)]);
    expect(duplicates.map(response => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(duplicates.map(response => response.json())) as { duplicate: boolean }[];
    expect(receipts.filter(receipt => receipt.duplicate)).toHaveLength(1);
    expect((await f.post("input", { ...first, data: "printf forbidden >> ordered.txt\r" })).status).toBe(409);
    expect((await f.post("input", second)).status).toBe(200);
    await until(async () => await readFile(join(f.cwd, "ordered.txt"), "utf8").catch(() => "") === "ab");
    expect(await readFile(join(f.cwd, "ordered.txt"), "utf8")).toBe("ab");
  });

  test("renderer orders live input and pauses after a lost accepted receipt without replaying queued input", async () => {
    const f = await fixture(); const delivered: TerminalInputRequest[] = []; let loseResponse = true;
    const writer = new OrderedTerminalInput(f.terminal.id, async request => {
      delivered.push(request); const response = await f.post("input", request); const receipt = await response.json() as { sequence: number; duplicate: boolean };
      if (!response.ok) throw new Error("Actual input route rejected request");
      if (loseResponse) { loseResponse = false; throw new Error("Controlled connection loss after native acceptance"); }
      return receipt;
    }, () => {});
    writer.enqueue("printf accepted >> loss.txt\r"); writer.enqueue("printf NEVER_AUTOREPLAY >> loss.txt\r");
    await writer.settled();
    expect(writer.paused).toBe(true); expect(writer.pendingBytes).toBeGreaterThan(0); expect(delivered).toHaveLength(1);
    await until(async () => await readFile(join(f.cwd, "loss.txt"), "utf8").catch(() => "") === "accepted");
    writer.setConnected(false); writer.setConnected(true); await Bun.sleep(50); expect(delivered).toHaveLength(1);
    writer.resume(); writer.enqueue("printf resumed >> loss.txt\r"); writer.enqueue("printf ordered >> loss.txt\r"); await writer.settled();
    await until(async () => await readFile(join(f.cwd, "loss.txt"), "utf8").catch(() => "") === "acceptedresumedordered");
    expect(delivered[1]?.clientId).not.toBe(delivered[0]?.clientId);
    expect(delivered.slice(1).map(request => request.sequence)).toEqual([1, 2]);
    expect(delivered.some(request => request.data.includes("NEVER_AUTOREPLAY"))).toBe(false); writer.dispose();
  });

  test("replay invalidations carry cursors and actual output is rendered once across repeated responses", async () => {
    const f = await fixture(); await Bun.sleep(60); f.notifications.splice(0);
    f.manager.write(f.terminal.id, "printf '\\033[31mNATIVE_OUTPUT\\033[0m\\n'\r");
    await until(() => f.notifications.some(event => event.type === "output"));
    expect(f.notifications.every(event => event.type === "output")).toBe(true);
    expect(JSON.stringify(f.notifications)).not.toContain("NATIVE_OUTPUT");
    const response = await f.post("query", { type: "replay", terminalId: f.terminal.id, afterSequence: 0 });
    const replay = (await response.json() as { replay: ReturnType<TerminalManager["replay"]> }).replay;
    let rendered = ""; let writes = 0; let resets = 0; let gaps = 0;
    const cursor = new TerminalReplayCursor(async data => { rendered += data; writes++; }, () => { rendered = ""; resets++; }, () => { gaps++; });
    await cursor.apply(replay); const initialWrites = writes; await cursor.apply(replay);
    expect(rendered).toContain("\x1b[31mNATIVE_OUTPUT\x1b[0m"); expect(writes).toBe(initialWrites); expect(resets).toBe(0);
    f.manager.write(f.terminal.id, "printf '%012000d\\n' 1; printf 'TAIL_COMPLETE\\n'\r");
    await until(() => f.manager.replay(f.terminal.id).chunks.map(chunk => chunk.data).join("").includes("TAIL_COMPLETE"));
    const tail = f.manager.replay(f.terminal.id, cursor.sequence); expect(tail.truncated).toBe(true);
    await cursor.apply(tail); expect(resets).toBe(1); expect(gaps).toBe(1); expect(rendered).not.toContain("NATIVE_OUTPUT"); expect(rendered).toContain("TAIL_COMPLETE");
    await cursor.apply(replay); expect(resets).toBe(1); expect(cursor.sequence).toBe(tail.lastSequence);
  });

  test("two real xterm viewers hand over unanswered queries without repeating an accepted reply", async () => {
    const f = await fixture(); const viewerA = crypto.randomUUID(); const viewerB = crypto.randomUUID();
    const claim = async (viewerId: string, afterSequence = 0, leaseId?: string, release?: boolean) => {
      const response = await f.post("action", { type: "viewer", terminalId: f.terminal.id, viewerId, afterSequence, leaseId, release });
      expect(response.status).toBe(200); return (await response.json() as { viewer: TerminalViewerLease }).viewer;
    };
    const leaseA = await claim(viewerA); const observer = await claim(viewerB); expect(observer.leaseId).toBe(leaseA.leaseId);
    await writeFile(join(f.cwd, "query-reader.js"), `import { appendFileSync } from "node:fs"; process.stdin.setRawMode(true); process.stdin.on("data", data => appendFileSync("replies.bin", data)); process.stdout.write("\\x1b[2J\\x1b[H\\x1b[6n\\x1b[c");`);
    f.manager.write(f.terminal.id, `'${process.execPath}' query-reader.js\r`);
    await until(() => f.manager.replay(f.terminal.id, leaseA.startSequence).chunks.some(chunk => chunk.data.includes("\x1b[6n")));
    const output = f.manager.replay(f.terminal.id); const first = new Terminal({ cols: 80, rows: 24 }); const second = new Terminal({ cols: 80, rows: 24 });
    const parserA = separateXtermReplies(first); const parserB = separateXtermReplies(second);
    try {
      const responses: ParsedTerminalReply[] = [];
      for (const chunk of output.chunks) { const replies = await parserA.write(chunk.data, chunk.sequence); if (chunk.sequence > leaseA.startSequence) responses.push(...replies); }
      expect(responses).toHaveLength(2);
      const send = async (clientId: string, sequence: number, lease: TerminalViewerLease, reply: typeof responses[number]) => {
        const response = await f.post("input", { terminalId: f.terminal.id, clientId, sequence, data: reply.data, reply: { leaseId: lease.leaseId, outputSequence: reply.outputSequence, ordinal: reply.ordinal } });
        expect(response.status).toBe(200); return await response.json() as { accepted: boolean };
      };
      const clientA = crypto.randomUUID(); expect((await send(clientA, 1, leaseA, responses[0]!)).accepted).toBe(true);
      // The first native answer was accepted, but A disappeared before committing parsed progress.
      await claim(viewerA, leaseA.completedSequence, leaseA.leaseId, true);
      const leaseB = await claim(viewerB, output.lastSequence); expect(leaseB.leaseId).not.toBe(leaseA.leaseId); expect(leaseB.completedSequence).toBe(leaseA.completedSequence);
      const clientB = crypto.randomUUID(); let sequence = 0;
      for (const chunk of output.chunks) for (const reply of await parserB.write(chunk.data, chunk.sequence)) if (chunk.sequence > leaseB.completedSequence) expect((await send(clientB, ++sequence, leaseB, reply)).accepted).toBe(true);
      expect((await send(clientA, 2, leaseA, responses[1]!)).accepted).toBe(false);
      const expected = responses.map(reply => reply.data).join("");
      await until(async () => await readFile(join(f.cwd, "replies.bin"), "utf8").catch(() => "") === expected);
      await claim(viewerB, output.lastSequence, leaseB.leaseId);
      expect((await send(clientB, ++sequence, leaseB, responses[0]!)).accepted).toBe(false);
      await Bun.sleep(40); expect(await readFile(join(f.cwd, "replies.bin"), "utf8")).toBe(expected);
    } finally { parserA.dispose(); parserB.dispose(); first.dispose(); second.dispose(); }
  });

  test("expired responder leases reject old viewers and binary HTTP input remains byte exact", async () => {
    const f = await fixture(120); const viewerA = crypto.randomUUID(); const viewerB = crypto.randomUUID();
    const first = f.adapter.viewer(f.terminal.id, viewerA, 0);
    await Bun.sleep(140); const next = f.adapter.viewer(f.terminal.id, viewerB, first.completedSequence);
    expect(next.leaseId).not.toBe(first.leaseId); expect(next.viewerId).toBe(viewerB);
    await writeFile(join(f.cwd, "byte-reader.js"), `import { appendFileSync } from "node:fs"; process.stdin.setRawMode(true); process.stdin.on("data", data => appendFileSync("bytes.bin", data)); process.stdout.write("BYTE_READER_READY\\n");`);
    f.manager.write(f.terminal.id, `'${process.execPath}' byte-reader.js\r`);
    await until(() => f.manager.replay(f.terminal.id).chunks.some(chunk => chunk.data.includes("BYTE_READER_READY")));
    const bytes = String.fromCharCode(0, 3, 27, 127, 128, 193, 254, 255);
    const input = { terminalId: f.terminal.id, clientId: crypto.randomUUID(), sequence: 1, encoding: "base64", data: binaryTerminalInput(bytes) };
    expect((await f.post("input", input)).status).toBe(200); expect((await f.post("input", input)).status).toBe(200);
    await until(async () => (await readFile(join(f.cwd, "bytes.bin")).catch(() => Buffer.alloc(0))).length === bytes.length);
    expect([...await readFile(join(f.cwd, "bytes.bin"))]).toEqual([0, 3, 27, 127, 128, 193, 254, 255]);
    expect((await f.post("input", { ...input, sequence: 2, data: "A===wrong" })).status).toBe(400);
  });

  test("disposing HTTP subscriptions leaves the shell alive and explicit close/forget remain separate", async () => {
    const f = await fixture();
    const resize = await f.post("action", { type: "resize", terminalId: f.terminal.id, cols: 500, rows: 1 });
    expect(await resize.json()).toMatchObject({ terminal: { cols: 400, rows: 5 } });
    const closed = await f.post("action", { type: "close", terminalId: f.terminal.id }); expect(await closed.json()).toMatchObject({ terminal: { status: "exited", cancelled: true } });
    expect((await f.post("action", { type: "forget", terminalId: f.terminal.id })).status).toBe(200);
    expect(f.notifications.some(event => event.type === "removed" && event.terminalId === f.terminal.id)).toBe(true);
    const another = await f.manager.create({ cwd: f.cwd, target: f.target }); f.adapter.dispose();
    expect(f.manager.get(another.id).status).toBe("running"); expect((await f.post("query", { type: "list" })).status).toBe(503);
  });
});
