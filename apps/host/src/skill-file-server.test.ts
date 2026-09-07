import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, NativeSkillFileDocument, NativeSkillFileRef } from "@agent-desktop/shared";

async function waitFor<T>(read: () => Promise<T>): Promise<T> {
  const expires = Date.now() + 30_000;
  let failure: unknown;
  while (Date.now() < expires) {
    try { return await read(); }
    catch (error) { failure = error; await Bun.sleep(50); }
  }
  throw failure;
}

test("native skill writes replay their durable command receipt without applying twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-skill-file-server-"));
  await mkdir(root, { recursive: true });
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../../../scripts/acceptance/skill-file-host.ts"), root], {
    cwd: join(import.meta.dir, "../../.."), env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") },
    stdout: "pipe", stderr: "pipe", ipc() {},
  });
  try {
    const ready = await waitFor(async () => JSON.parse(await readFile(join(root, "ready.json"), "utf8")) as {
      connection: { origin: string; token: string; hostId: string }; ref: NativeSkillFileRef; skillPath: string;
    });
    const headers = { Authorization: `Bearer ${ready.connection.token}`, "Content-Type": "application/json", "X-Agent-Host-Id": ready.connection.hostId };
    const openedResponse = await fetch(ready.connection.origin + "/v1/composer/skill-file", {
      method: "POST", headers, body: JSON.stringify({ ref: ready.ref }),
    });
    expect(openedResponse.status).toBe(200);
    const opened = await openedResponse.json() as NativeSkillFileDocument;
    const envelope: CommandEnvelope = { id: "durable-skill-write", commandVersion: 5, command: {
      type: "skill.file.write", ref: ready.ref, expectedRevision: opened.document.revision, text: "first receipt\n",
    } };
    const send = async (): Promise<CommandResult> => {
      const response = await fetch(ready.connection.origin + "/v5/commands", { method: "POST", headers, body: JSON.stringify(envelope) });
      expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
    };
    const first = await send();
    expect(first).toMatchObject({ ok: true, value: { type: "skill.file.write", conflict: false, file: { document: { text: "first receipt\n" } } } });
    await writeFile(ready.skillPath, "external after receipt\n");
    expect(await send()).toEqual(first);
    expect(await readFile(ready.skillPath, "utf8")).toBe("external after receipt\n");
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
