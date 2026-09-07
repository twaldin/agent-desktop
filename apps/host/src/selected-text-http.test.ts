import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, DraftInput, HostCommand, HostState, SessionSummary, TranscriptMessage } from "@agent-desktop/shared";
import { startHost } from "./server";

const model = { provider: "selected-text-contract", id: "controlled" };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "selected-text-http-")));
  const options = { dataDirectory: path.join(root, "data"), agentDirectory: path.join(root, "agent"), discoveryDirectory: path.join(root, "project"),
    workerPath: fileURLToPath(new URL("./fixtures/selected-text-http-worker.ts", import.meta.url)), tailscale: false, port: 0 };
  const gates = path.join(options.agentDirectory, "gates");
  await Promise.all([options.dataDirectory, options.agentDirectory, options.discoveryDirectory, gates].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(options.agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./omp-workers/fixtures/selected-text-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  let host = await startHost(options);
  const request = (route: string, init: RequestInit = {}) => fetch(`${host.connection.origin}${route}`, { ...init,
    headers: { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json", ...init.headers } });
  const command = async (command: HostCommand, id: string = crypto.randomUUID(), version = 6): Promise<CommandResult> => {
    const response = await request(`/v${version}/commands`, { method: "POST", body: JSON.stringify({ id, command }) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  const create = await command({ type: "session.create", projectId: null, cwd: options.discoveryDirectory });
  if (!create.ok || !create.value || !("sessionFile" in create.value)) throw new Error("Expected native session");
  const session = create.value as SessionSummary;
  const draft: DraftInput = { id: `session:${session.id}`, text: "Explain the snapshot.", model, projectId: null,
    selectedTextAttachments: [{ id: "excerpt-one", text: "unsaved value", source: { kind: "file", hostId: "remote-source-owner", path: "/missing/source.ts",
      range: { start: { line: 5, column: 3 }, end: { line: 5, column: 16 } } } }] };
  const raw = async () => (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const settled = async () => {
    const until = Date.now() + 5000;
    while (host.store.getSession(session.id)?.status === "running" && Date.now() < until) await Bun.sleep(10);
    expect(host.store.getSession(session.id)?.status).not.toBe("running");
  };
  return { root, gates, request, command, session, draft, raw, settled, get host() { return host; },
    restart: async () => { await host.stop(); host = await startHost(options); },
    close: async () => { await host.stop(); await rm(root, { recursive: true, force: true }); } };
}

test("selected snapshots traverse authenticated HTTP, native admission and durable exact-once draft consumption", async () => {
  const f = await fixture();
  try {
    const state = await (await f.request("/v1/state")).json() as HostState;
    expect(state.selectedText).toEqual({ commandVersion: 6, maxSerializedChars: 400000, ordinaryPrompt: true });
    const put: HostCommand = { type: "draft.put", draft: f.draft, expectedRevision: 0 };
    for (const version of [1, 2, 3, 4, 5]) {
      const response = await f.request(`/v${version}/commands`, { method: "POST", body: JSON.stringify({ id: `old-${version}`, command: put }) });
      expect(response.status).toBe(422); expect(f.host.store.getCommand(`old-${version}`)).toBeUndefined();
    }
    expect((await f.command(put)).ok).toBe(true);
    const { selectedTextAttachments: _selected, ...legacy } = f.draft;
    const old = await f.command({ type: "draft.put", draft: { ...legacy, text: "old writer" }, expectedRevision: 1 }, "legacy", 5);
    expect(old).toMatchObject({ ok: false, error: { code: "SELECTED_TEXT_PROTOCOL_REQUIRED" } });
    expect((await f.command({ ...put, draft: { ...f.draft, text: "conflicting client" } })).ok).toBe(false);
    expect(f.host.store.listDraftConflicts()[0]?.attempted.selectedTextAttachments).toEqual(f.draft.selectedTextAttachments);
    const send: HostCommand = { type: "session.prompt", sessionId: f.session.id, text: f.draft.text, model,
      selectedTextAttachments: f.draft.selectedTextAttachments, draft: { id: f.draft.id, revision: 1 } };
    expect(await f.command({ ...send, selectedTextAttachments: [] })).toMatchObject({ ok: false, error: { code: "DRAFT_CONTENT_MISMATCH" } });
    expect(await f.command({ type: "session.steer", sessionId: f.session.id, text: f.draft.text, selectedTextAttachments: f.draft.selectedTextAttachments,
      draft: send.draft })).toMatchObject({ ok: false, error: { code: "SELECTED_TEXT_STEER_UNSUPPORTED" } });
    const result = await f.command(send, "selected-send");
    expect(result).toMatchObject({ ok: true, admission: { kind: "user-message" } });
    await f.settled();
    expect(f.host.store.getDraft(f.draft.id)).toMatchObject({ revision: 2, text: "", selectedTextAttachments: [], lastConsumption: { commandId: "selected-send", submittedRevision: 1 } });
    const entries = await f.raw(), custom = entries.filter(row => row.customType === "agent-desktop.selected-text");
    expect(custom).toHaveLength(1);
    expect(custom[0].details).toMatchObject({ submissionId: "selected-send", attachments: f.draft.selectedTextAttachments });
    expect(entries.filter(row => row.type === "message" && row.message.role === "user")).toHaveLength(1);
    const bound = entries.find(row => row.type === "custom" && row.customType === "agent-desktop.selected-text-binding");
    expect(bound?.data).toMatchObject({ submissionId: "selected-send", contextEntryId: custom[0].id });
    const messages = await (await f.request(`/v1/sessions/${f.session.id}/messages`)).json() as TranscriptMessage[];
    const user = messages.find(message => message.nativeId === bound?.data.userEntryId);
    expect(user).toMatchObject({ role: "user", text: f.draft.text, selectedText: { bindingEntryId: bound.id, attachments: f.draft.selectedTextAttachments } });
    expect(messages.some(message => message.role === "selectedText")).toBe(false);
    expect(entries.find(row => row.type === "message" && row.message.role === "assistant").message.content[0].text).toContain("unsaved value");
    expect(await f.command(send, "selected-send")).toEqual(result);
    await f.restart();
    const reopened = await (await f.request(`/v1/sessions/${f.session.id}/messages`)).json() as TranscriptMessage[];
    expect(reopened.find(message => message.nativeId === user?.nativeId)?.selectedText).toEqual(user?.selectedText);
    expect(await f.command(send, "selected-send")).toEqual(result);
    expect((await f.raw()).filter(row => row.customType === "agent-desktop.selected-text")).toHaveLength(1);
    expect(f.host.store.getDraft(f.draft.id)?.selectedTextAttachments).toEqual([]);
    expect(f.host.store.listDraftConflicts()).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

test("a lost native selected-text receipt retains the original draft and never replays after host restart", async () => {
  const f = await fixture();
  try {
    expect((await f.command({ type: "draft.put", draft: f.draft, expectedRevision: 0 })).ok).toBe(true);
    await writeFile(path.join(f.gates, "lose-receipt"), "");
    const send: HostCommand = { type: "session.prompt", sessionId: f.session.id, text: f.draft.text, model,
      selectedTextAttachments: f.draft.selectedTextAttachments, draft: { id: f.draft.id, revision: 1 } };
    const result = await f.command(send, "lost-selected-receipt");
    expect(result).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
    expect(JSON.parse(await readFile(path.join(f.gates, "receipt-lost.json"), "utf8"))).toMatchObject({ kind: "user-message" });
    expect(f.host.store.getDraft(f.draft.id)).toMatchObject({ revision: 1, text: f.draft.text, selectedTextAttachments: f.draft.selectedTextAttachments });
    await f.restart();
    expect(await f.command(send, "lost-selected-receipt")).toEqual(result);
    expect((await f.raw()).filter(row => row.customType === "agent-desktop.selected-text")).toHaveLength(1);
    expect((await f.raw()).filter(row => row.type === "message" && row.message.role === "user")).toHaveLength(1);
    expect(f.host.store.getDraft(f.draft.id)?.lastConsumption).toBeUndefined();
  } finally { await f.close(); }
}, 30000);

test("production renderer draft and submission controllers round-trip snapshots through the real versioned host", async () => {
  const { DraftController } = await import("../../desktop/src/renderer/drafts");
  const { SubmissionController } = await import("../../desktop/src/renderer/submissions");
  const { requestVersionedCommand } = await import("../../desktop/src/main/command-endpoints");
  const f = await fixture(), cache = new Map<string, string>();
  const storage = { read: (key: string) => cache.get(key) ?? null, write: (key: string, value: string) => { cache.set(key, value); } };
  const paths: string[] = [];
  const transport = (envelope: import("@agent-desktop/shared").CommandEnvelope) => requestVersionedCommand(async (route, body) => {
    paths.push(route);
    const response = await f.request(route, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json();
  }, envelope) as Promise<CommandResult>;
  const drafts = new DraftController(transport, f.host.connection.hostId, storage);
  const submissions = new SubmissionController(transport, f.host.connection.hostId, storage);
  try {
    drafts.get(f.draft.id);
    drafts.update(f.draft.id, { text: f.draft.text, model, selectedTextAttachments: f.draft.selectedTextAttachments });
    drafts.setConnected(true);
    const captured = await drafts.prepareSubmission(f.draft.id);
    const result = await submissions.submit(captured, f.session.id, "prompt", (snapshot, id) => drafts.beginPendingSubmission(snapshot, id));
    drafts.finishSubmission(f.draft.id, result.submitted, true, false, result.commandId);
    const state = await (await f.request("/v1/state")).json() as HostState;
    drafts.ingest(state.drafts.find(draft => draft.id === f.draft.id)!);
    expect(drafts.get(f.draft.id)).toMatchObject({ status: "saved", draft: { text: "", selectedTextAttachments: [], revision: 2 } });
    expect(paths).toEqual(["/v6/commands", "/v6/commands"]);
    const restored = new DraftController(transport, f.host.connection.hostId, storage);
    try { expect(restored.get(f.draft.id).draft.selectedTextAttachments).toEqual([]); } finally { restored.dispose(); }
    expect(submissions.entries()).toEqual([]);
    await f.settled();
    expect((await f.raw()).filter(row => row.customType === "agent-desktop.selected-text")).toHaveLength(1);
  } finally { drafts.dispose(); await f.close(); }
}, 30000);
