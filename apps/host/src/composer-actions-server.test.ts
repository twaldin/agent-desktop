import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandEnvelope, CommandResult, SessionSummary, TranscriptMessage } from "@agent-desktop/shared";
import { startHost } from "./server";

test("a lost native command receipt is recovered by command identity without duplicating output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-composer-retry-"));
  const options = { dataDirectory: path.join(root, "data"), agentDirectory: path.join(root, "agent"), discoveryDirectory: path.join(root, "project"), tailscale: false };
  await Promise.all(Object.values(options).filter(value => typeof value === "string").map(directory => mkdir(directory as string, { recursive: true })));
  let host = await startHost(options);
  const send = async (envelope: CommandEnvelope): Promise<CommandResult> => {
    const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: {
      Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(envelope) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  const messages = async (sessionId: string): Promise<TranscriptMessage[]> => {
    const response = await fetch(`${host.connection.origin}/v1/sessions/${sessionId}/messages`, { headers: { Authorization: `Bearer ${host.connection.token}` } });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`/messages expected 200, got ${response.status}: ${body.slice(0, 4_096)}`);
    expect(response.status).toBe(200); return JSON.parse(body) as TranscriptMessage[];
  };
  try {
    const created = await send({ id: crypto.randomUUID(), command: { type: "session.create", projectId: null, cwd: options.discoveryDirectory } });
    if (!created.ok || !created.value || !("sessionFile" in created.value)) throw new Error("Expected native session");
    const session = created.value as SessionSummary;
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: "/session info" } };
    const first = await send(envelope);
    if (!first.ok || first.admission?.kind !== "native-command" || !first.admission.entryId) throw new Error("Expected persisted command receipt");
    const entryId = first.admission.entryId;
    expect((await messages(session.id)).filter(row => row.commandOutput?.entryId === entryId)).toHaveLength(1);
    expect(await send(envelope)).toEqual(first);
    expect((await messages(session.id)).filter(row => row.commandOutput?.entryId === entryId)).toHaveLength(1);
    await host.stop(); host = await startHost(options);
    expect(await send(envelope)).toEqual(first);
    expect((await messages(session.id)).filter(row => row.commandOutput?.entryId === entryId)).toHaveLength(1);
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
