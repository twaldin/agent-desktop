import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_ATTACHMENT_OWNER_HEADER, type CommandEnvelope, type CommandResult, type Draft, type HostCommand, type HostState, type ImageAttachmentRef, type SessionSummary, type TranscriptMessage } from "@agent-desktop/shared";
import { startHost } from "./server";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const model = { provider: "image-contract", id: "vision" };

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-native-image-http-")));
  const options = { dataDirectory: path.join(root, "data"), agentDirectory: path.join(root, "agent"), discoveryDirectory: path.join(root, "project"),
    workerPath: fileURLToPath(new URL("./fixtures/server-images-worker.ts", import.meta.url)), tailscale: false };
  const gates = path.join(options.agentDirectory, "image-gates");
  await Promise.all([options.dataDirectory, options.agentDirectory, options.discoveryDirectory, gates].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(options.agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/server-images-provider.ts", import.meta.url)))}\ndefaultThinkingLevel: off\nretry:\n  enabled: false\n`);
  let host = await startHost(options);
  const request = (route: string, init: RequestInit = {}) => fetch(`${host.connection.origin}${route}`, {
    ...init, headers: { Authorization: `Bearer ${host.connection.token}`, [IMAGE_ATTACHMENT_OWNER_HEADER]: host.connection.hostId, ...init.headers },
  });
  const command = async (command: HostCommand, id: string = crypto.randomUUID(), version = 3): Promise<CommandResult> => {
    const response = await request(`/v${version}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, command }) });
    expect(response.status).toBe(200);
    return response.json() as Promise<CommandResult>;
  };
  const upload = async (): Promise<ImageAttachmentRef> => {
    const response = await request(`/v1/attachments/images/${digest(png)}`, { method: "PUT", body: png });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const metadata = await response.json() as { bytes: number; sha256: string; mimeType: "image/png" };
    return { id: "fixture-original", hostId: host.connection.hostId, kind: "image", name: "Known image fixture.png",
      bytes: metadata.bytes, sha256: metadata.sha256, mimeType: metadata.mimeType };
  };
  const session = async () => {
    const result = await command({ type: "session.create", projectId: null, cwd: options.discoveryDirectory });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value || !("sessionFile" in result.value)) throw new Error("Expected real native session creation");
    return result.value as SessionSummary;
  };
  const messages = async (id: string): Promise<TranscriptMessage[]> => {
    const response = await request(`/v1/sessions/${id}/messages`); expect(response.status).toBe(200);
    return response.json() as Promise<TranscriptMessage[]>;
  };
  const settled = async (id: string) => {
    const deadline = Date.now() + 7000;
    while (host.store.getSession(id)?.status === "running" && Date.now() < deadline) await Bun.sleep(5);
    expect(host.store.getSession(id)?.status).not.toBe("running");
  };
  // Independent caller snapshots and command identities over authenticated HTTP;
  // these are transport clients, not a claim of two graphical desktop windows.
  const client = () => ({ command, draft: async (id: string) => {
    const response = await request("/v1/state"); expect(response.status).toBe(200);
    return (await response.json() as HostState).drafts.find(draft => draft.id === id)!;
  } });
  return { root, options, gates, get host() { return host; }, request, command, upload, session, messages, settled, client,
    restart: async () => { await host.stop(); host = await startHost(options); },
    close: async () => { await host.stop(); await rm(root, { recursive: true, force: true }); } };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 7000;
  while (!await Bun.file(file).exists() && Date.now() < deadline) await Bun.sleep(5);
  expect(await Bun.file(file).exists()).toBe(true);
}

test("v17 image follow-up binds the saved draft and original host, deduplicates retries and reopens native bytes", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(), session = await f.session();
    await writeFile(path.join(f.gates, "mode"), "hold");
    expect((await f.command({ type: "session.prompt", sessionId: session.id, text: "hold image queue", model })).ok).toBe(true);
    await waitForFile(path.join(f.gates, "provider-input.json"));
    const draft: Draft = { id: `session:${session.id}`, revision: 0, updatedAt: 0, text: "inspect uploaded image", projectId: null, model, attachments: [image] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 }, undefined, 17)).ok).toBe(true);
    const command: Extract<HostCommand, { type: "session.follow-up" }> = { type: "session.follow-up", sessionId: session.id, text: draft.text,
      delivery: "follow-up", attachments: [image], draft: { id: draft.id, revision: 1 } };
    const legacy = await f.request("/v13/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "wrong-version", command }) });
    expect(legacy.status).toBe(422);
    const missingBody = await f.command({ ...command, attachments: undefined }, "missing-body", 17);
    expect(missingBody).toMatchObject({ ok: true, value: { receipt: { outcome: "not-recorded" } } });
    const foreign = await f.command({ ...command, attachments: [{ ...image, hostId: "foreign" }] }, "foreign-image", 17);
    expect(foreign).toMatchObject({ ok: true, value: { receipt: { outcome: "not-recorded" } } });
    expect(f.host.store.getDraft(draft.id)?.attachments).toEqual([image]);
    const id = "original-image-follow-up", queued = await f.command(command, id, 17);
    expect(queued).toMatchObject({ ok: true, value: { receipt: { commandId: id, phase: "queued", outcome: "pending" } } });
    expect(f.host.store.getDraft(draft.id)).toMatchObject({ text: "", attachments: [], revision: 2, lastConsumption: { commandId: id, submittedRevision: 1 } });
    const newer = { ...draft, revision: 2, text: "newer unsent text", attachments: [] };
    expect((await f.command({ type: "draft.put", draft: newer, expectedRevision: 2 }, undefined, 17)).ok).toBe(true);
    expect(await f.command(command, id, 17)).toEqual(queued);
    await writeFile(path.join(f.gates, "mode"), "");
    await f.settled(session.id);
    let final = await f.command(command, id, 17);
    const deadline = Date.now() + 7000;
    while (final.ok && final.value && "type" in final.value && final.value.type === "session.follow-up" && final.value.receipt.phase !== "settled" && Date.now() < deadline) {
      await Bun.sleep(5); final = await f.command(command, id, 17);
    }
    expect(final).toMatchObject({ ok: true, value: { receipt: { outcome: "succeeded" } } });
    if (!final.ok || !final.value || !("type" in final.value) || final.value.type !== "session.follow-up" || !final.value.receipt.entryId) throw new Error("missing native image entry");
    const entryId = final.value.receipt.entryId;
    const recordedRoute = `/v1/sessions/${session.id}/images/${entryId}/1`;
    const recorded = await f.request(recordedRoute);
    expect(recorded.status).toBe(200);
    const recordedHash = digest(new Uint8Array(await recorded.arrayBuffer()));
    expect((await f.messages(session.id)).filter(row => row.nativeId === entryId)).toHaveLength(1);
    await f.restart();
    expect(await f.command(command, id, 17)).toEqual(final);
    expect(digest(new Uint8Array(await (await f.request(recordedRoute)).arrayBuffer()))).toBe(recordedHash);
    expect(f.host.store.getDraft(draft.id)).toMatchObject({ text: "newer unsent text", attachments: [], revision: 3 });
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(2);
  } finally { await f.close(); }
}, 45_000);

test("v13 text follow-up preserves an emptied image-aware draft through native queue admission", async () => {
  const f = await fixture();
  try {
    const session = await f.session();
    await writeFile(path.join(f.gates, "mode"), "hold");
    expect((await f.command({ type: "session.prompt", sessionId: session.id, text: "held text turn", model })).ok).toBe(true);
    await waitForFile(path.join(f.gates, "provider-input.json"));
    const draft = { id: `session:${session.id}`, text: "text after image removal", projectId: null, model, attachments: [] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 })).ok).toBe(true);
    const queued = await f.command({ type: "session.follow-up", sessionId: session.id, text: draft.text, delivery: "follow-up",
      draft: { id: draft.id, revision: 1 } }, "empty-image-text", 13);
    expect(queued).toMatchObject({ ok: true, value: { receipt: { phase: "queued", outcome: "pending" } } });
    expect(f.host.store.getDraft(draft.id)).toMatchObject({ text: "", attachments: [], revision: 2 });
    await writeFile(path.join(f.gates, "mode"), "");
    await f.settled(session.id);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(2);
  } finally { await f.close(); }
}, 30_000);

test("authenticated image HTTP joins actual native admission, atomic draft consumption, retry and restart", async () => {
  const f = await fixture();
  try {
    expect((await fetch(`${f.host.connection.origin}/v1/attachments/capabilities`)).status).toBe(401);
    expect((await (await f.request("/v1/attachments/capabilities")).json()).commandVersion).toBe(3);
    const image = await f.upload(), session = await f.session();
    const draft = { id: session.id, text: "", projectId: null, model, attachments: [image] };
    const saved = await f.command({ type: "draft.put", draft, expectedRevision: 0 });
    expect(saved.ok).toBe(true);
    expect(f.host.store.getDraft(session.id)?.revision).toBe(1);
    for (const version of [1, 2]) {
      const raw = await f.request(`/v${version}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), command: { type: "draft.put", draft, expectedRevision: 1 } }) });
      expect(raw.status).toBe(422);
      const legacy = await f.command({ type: "draft.put", draft: { id: session.id, text: "Old writer would erase the image", projectId: null, model }, expectedRevision: 1 }, crypto.randomUUID(), version);
      expect(legacy.ok).toBe(false);
      if (!legacy.ok) expect(legacy.error.code).toBe("ATTACHMENT_PROTOCOL_REQUIRED");
    }
    expect(f.host.store.getDraft(session.id)?.attachments).toEqual([image]);
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: "", model, attachments: [image], draft: { id: session.id, revision: 1 } } };
    const result = await f.command(envelope.command, envelope.id);
    expect(result.ok).toBe(true);
    if (!result.ok || result.admission?.kind !== "user-message") throw new Error("Missing certified native image receipt");
    const entryId = result.admission.entryId;
    expect(result.admission.images?.[0]?.sourceSha256).toBe(image.sha256);
    const nativeHash = result.admission.images![0]!.nativeSha256;
    expect(f.host.store.getDraft(session.id)).toMatchObject({ text: "", attachments: [], revision: 2, lastConsumption: { commandId: envelope.id, submittedRevision: 1 } });
    expect(await f.command(envelope.command, envelope.id)).toEqual(result);
    await f.settled(session.id);
    const rows = await f.messages(session.id), user = rows.find(row => row.nativeId === entryId)!;
    expect(rows.filter(row => row.role === "user").length).toBe(1);
    expect(user.content?.find(block => block.type === "image")).toMatchObject({ type: "image", nativeType: "image", blockIndex: 1, sha256: nativeHash });
    const nativeRoute = `/v1/sessions/${session.id}/images/${result.admission.entryId}/1`;
    const original = await f.request(`/v1/attachments/images/${image.sha256}`), recorded = await f.request(nativeRoute);
    expect(digest(new Uint8Array(await original.arrayBuffer()))).toBe(image.sha256);
    const recordedBytes = new Uint8Array(await recorded.arrayBuffer());
    expect(recorded.status).toBe(200); expect(recorded.headers.get("x-image-sha256")).toBe(nativeHash);
    expect(digest(recordedBytes)).toBe(nativeHash);
    const db = new Database(path.join(f.options.dataDirectory, "state.sqlite"), { readonly: true });
    try {
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
      for (const table of ["commands", "events", "drafts"]) {
        const body = JSON.stringify(db.query<{ data: string }, []>(`SELECT data FROM ${table}`).all());
        expect(body).not.toContain(png.toString("base64"));
        expect(body).not.toContain(Buffer.from(recordedBytes).toString("base64"));
      }
    } finally { db.close(); }
    const owner = f.host.connection.hostId;
    await f.restart();
    expect(f.host.connection.hostId).toBe(owner);
    expect(await f.command(envelope.command, envelope.id)).toEqual(result);
    expect((await f.messages(session.id)).filter(row => row.role === "user").length).toBe(1);
    expect(digest(new Uint8Array(await (await f.request(nativeRoute)).arrayBuffer()))).toBe(nativeHash);
    expect(f.host.store.getDraft(session.id)?.lastConsumption?.commandId).toBe(envelope.id);
  } finally { await f.close(); }
}, 45_000);

test("native image HTTP flush uncertainty retains the draft and exact same-envelope receipt through restart", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(), session = await f.session();
    const draft = { id: session.id, text: "Keep uncertain image", projectId: null, model, attachments: [image] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 })).ok).toBe(true);
    const before = f.host.store.getDraft(session.id) as Draft;
    await writeFile(path.join(f.gates, "fail-flush"), "");
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, text: draft.text, model, attachments: [image], draft: { id: session.id, revision: before.revision } } };
    const result = await f.command(envelope.command, envelope.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Faulted flush cannot certify native admission");
    expect(result.error.code).toBe("OUTCOME_UNKNOWN");
    expect(f.host.store.getDraft(session.id)).toEqual(before);
    expect(await f.command(envelope.command, envelope.id)).toEqual(result);
    await f.settled(session.id);
    expect((await f.messages(session.id)).filter(row => row.role === "user").length).toBe(1);
    await rm(path.join(f.gates, "fail-flush"));
    await f.restart();
    expect(await f.command(envelope.command, envelope.id)).toEqual(result);
    expect(f.host.store.getDraft(session.id)).toEqual(before);
    expect((await f.messages(session.id)).filter(row => row.role === "user").length).toBe(1);
    expect((await readFile(session.sessionFile, "utf8")).split("\n").filter(line => line.includes('"role":"user"')).length).toBe(1);
  } finally { await f.close(); }
}, 45_000);

test("loss of the actual native acceptance response preserves one unknown command and the image draft", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(), session = await f.session();
    const draft = { id: session.id, text: "Lost image receipt", projectId: null, model, attachments: [image] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 })).ok).toBe(true);
    const before = f.host.store.getDraft(session.id)!;
    await writeFile(path.join(f.gates, "lose-receipt"), "");
    const command: HostCommand = { type: "session.prompt", sessionId: session.id, text: draft.text, model, attachments: [image], draft: { id: session.id, revision: 1 } };
    const id = crypto.randomUUID(), result = await f.command(command, id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("A lost receipt cannot certify native admission");
    expect(result.error.code).toBe("OUTCOME_UNKNOWN");
    const observed = JSON.parse(await readFile(path.join(f.gates, "receipt-lost.json"), "utf8"));
    expect(observed.receipt.kind).toBe("user-message");
    expect(observed.receipt.images[0].attachmentId).toBe(image.id);
    expect(f.host.store.getDraft(session.id)).toEqual(before);
    expect(await f.command(command, id)).toEqual(result);
    await rm(path.join(f.gates, "lose-receipt"));
    await f.restart();
    expect(await f.command(command, id)).toEqual(result);
    expect(f.host.store.getDraft(session.id)).toEqual(before);
    const messages = await f.messages(session.id);
    expect(messages.filter(message => message.role === "user").length).toBe(1);
    expect(messages.some(message => message.nativeId === observed.receipt.entryId)).toBe(true);
  } finally { await f.close(); }
}, 45_000);

test("image HTTP rejects changed snapshots and wrong-owner, missing or corrupt bytes before native permission or prompt effects", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(), session = await f.session();
    const duplicate = { ...image, id: "second-image-identity" };
    const draft = { id: session.id, text: "Captured image snapshot", projectId: null, model, attachments: [image, duplicate] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 })).ok).toBe(true);
    const before = f.host.store.getDraft(session.id);
    for (const changed of [{ text: "Changed text", attachments: draft.attachments }, { text: draft.text, attachments: [duplicate, image] }]) {
      const result = await f.command({ type: "session.prompt", sessionId: session.id, model, approvalMode: "always-ask", ...changed, draft: { id: session.id, revision: 1 } });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("DRAFT_CONTENT_MISMATCH");
    }
    const missing = await f.command({ type: "session.prompt", sessionId: session.id, text: "Do not apply permissions without image bytes", model,
      approvalMode: "always-ask", attachments: [{ ...image, sha256: "f".repeat(64) }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("IMAGE_NOT_FOUND");
    const wrongOwnerId = crypto.randomUUID();
    const wrongOwner = await f.request("/v3/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wrongOwnerId,
      command: { type: "session.prompt", sessionId: session.id, text: "Do not cross host ownership", model,
        approvalMode: "always-ask", attachments: [{ ...image, hostId: crypto.randomUUID() }] } }) });
    expect(wrongOwner.status).toBe(400);
    expect((await wrongOwner.json()).error).toContain("another host");
    expect(f.host.store.getCommand(wrongOwnerId)).toBeUndefined();
    const corrupted = Buffer.from(png); corrupted[corrupted.length - 1] ^= 1;
    await writeFile(path.join(f.options.dataDirectory, "attachments", "images", image.sha256.slice(0, 2), image.sha256), corrupted);
    const corrupt = await f.command({ type: "session.prompt", sessionId: session.id, text: "Do not apply permissions to corrupted bytes", model,
      approvalMode: "always-ask", attachments: [image] });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe("CORRUPT_IMAGE_STORAGE");
    expect(f.host.store.getSession(session.id)?.approvalOverride).toBeUndefined();
    expect(f.host.store.getDraft(session.id)).toEqual(before);
    expect((await f.messages(session.id)).length).toBe(0);
    expect(await Bun.file(path.join(f.gates, "provider-input.json")).exists()).toBe(false);
  } finally { await f.close(); }
}, 30_000);

test("two HTTP clients preserve image-only conflicts and newer edits while native admission is pending", async () => {
  const f = await fixture();
  let pending: Promise<CommandResult> | undefined;
  try {
    const image = await f.upload(), second = { ...image, id: "second-ordered-image" }, session = await f.session();
    const a = f.client(), b = f.client();
    const initial = { id: session.id, text: "", projectId: null, model, attachments: [image] };
    expect((await a.command({ type: "draft.put", draft: initial, expectedRevision: 0 })).ok).toBe(true);
    const aRead = await a.draft(session.id), bRead = await b.draft(session.id);
    expect(aRead).toEqual(bRead); expect(aRead.revision).toBe(1);
    const captured = { ...initial, attachments: [image, second] };
    expect((await a.command({ type: "draft.put", draft: captured, expectedRevision: aRead.revision })).ok).toBe(true);
    const attempted = { ...initial, attachments: [second] };
    const conflict = await b.command({ type: "draft.put", draft: attempted, expectedRevision: bRead.revision });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("DRAFT_CONFLICT");
    const capturedRead = await a.draft(session.id);
    expect(capturedRead).toMatchObject({ text: "", attachments: captured.attachments, revision: 2 });
    expect(f.host.store.listDraftConflicts(session.id)).toHaveLength(1);
    expect(f.host.store.listDraftConflicts(session.id)[0]).toMatchObject({ expectedRevision: 1, attempted, currentDraft: capturedRead });

    await writeFile(path.join(f.gates, "hold-admission"), "");
    const envelope: CommandEnvelope = { id: crypto.randomUUID(), command: { type: "session.prompt", sessionId: session.id, model,
      text: captured.text, attachments: captured.attachments, draft: { id: session.id, revision: capturedRead.revision } } };
    let completed = false;
    pending = a.command(envelope.command, envelope.id).then(result => { completed = true; return result; });
    await waitForFile(path.join(f.gates, "admission-started"));
    expect(completed).toBe(false);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(0);
    expect(await Bun.file(path.join(f.gates, "provider-input.json")).exists()).toBe(false);
    expect((await b.command({ type: "draft.put", draft: attempted, expectedRevision: 2 })).ok).toBe(true);
    const newer = await b.draft(session.id);
    expect(newer).toMatchObject({ text: "", attachments: [second], revision: 3 });
    await writeFile(path.join(f.gates, "release-admission"), "");
    const receipt = await pending;
    expect(receipt.ok).toBe(true);
    if (!receipt.ok || receipt.admission?.kind !== "user-message") throw new Error("Expected native image admission");
    expect(receipt.admission.images?.map(image => image.attachmentId)).toEqual([image.id, second.id]);
    expect(await a.draft(session.id)).toEqual(newer);
    expect(newer.lastConsumption).toBeUndefined();
    await f.settled(session.id);
    const providerInput = JSON.parse(await readFile(path.join(f.gates, "provider-input.json"), "utf8"));
    expect(providerInput[0].content.filter((block: { type: string }) => block.type === "image")).toHaveLength(2);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(1);
    // Once accepted, replay must resolve the immutable result before comparing a
    // later image-aware draft, even after the owning host has restarted.
    expect((await b.command({ type: "draft.put", draft: { ...attempted, attachments: [second, image] }, expectedRevision: 3 })).ok).toBe(true);
    const later = await b.draft(session.id);
    expect(await a.command(envelope.command, envelope.id)).toEqual(receipt);
    expect(await a.draft(session.id)).toEqual(later);
    await f.restart();
    expect(await b.command(envelope.command, envelope.id)).toEqual(receipt);
    expect(await b.draft(session.id)).toEqual(later);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(1);
    expect(f.host.store.listDraftConflicts(session.id)[0]).toMatchObject({ attempted, currentDraft: capturedRead });
  } finally {
    await writeFile(path.join(f.gates, "release-admission"), "");
    await pending?.catch(() => undefined);
    await f.close();
  }
}, 45_000);

test("v3 empty images preserve text and native slash handling; nonempty slash and steer keep the draft", async () => {
  const f = await fixture();
  try {
    const image = await f.upload(), session = await f.session();
    const draft = { id: session.id, text: "Ordinary text with cleared image list", projectId: null, model, attachments: [] as ImageAttachmentRef[] };
    expect((await f.command({ type: "draft.put", draft, expectedRevision: 0 })).ok).toBe(true);
    const text = await f.command({ type: "session.prompt", sessionId: session.id, text: draft.text, model, attachments: [], draft: { id: session.id, revision: 1 } });
    expect(text.ok).toBe(true);
    if (!text.ok || text.admission?.kind !== "user-message") throw new Error("Expected actual native text receipt");
    expect(text.admission.images).toBeUndefined();
    await f.settled(session.id);
    expect(f.host.store.getDraft(session.id)).toMatchObject({ revision: 2, text: "", attachments: [] });
    const imageSlash = { ...draft, text: "/image-effect", attachments: [image] };
    expect((await f.command({ type: "draft.put", draft: imageSlash, expectedRevision: 2 })).ok).toBe(true);
    const slashBefore = f.host.store.getDraft(session.id)!;
    const slash = await f.command({ type: "session.prompt", sessionId: session.id, text: imageSlash.text, model, attachments: [image],
      approvalMode: "always-ask", draft: { id: session.id, revision: slashBefore.revision } });
    expect(slash.ok).toBe(false);
    if (!slash.ok) expect(slash.error.code).toBe("IMAGE_COMMAND_UNSUPPORTED");
    expect(f.host.store.getDraft(session.id)).toEqual(slashBefore);
    expect(f.host.store.getSession(session.id)?.approvalOverride).toBeUndefined();
    expect(await Bun.file(path.join(f.gates, "slash-executed")).exists()).toBe(false);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(1);
    // Clearing the images explicitly restores the same native command's handler.
    expect((await f.command({ type: "draft.put", draft: { ...imageSlash, attachments: [] }, expectedRevision: 3 })).ok).toBe(true);
    const handled = await f.command({ type: "session.prompt", sessionId: session.id, text: "/image-effect", attachments: [], draft: { id: session.id, revision: 4 } });
    expect(handled.ok).toBe(true);
    if (handled.ok) expect(handled.admission?.kind).toBe("native-command");
    expect(await Bun.file(path.join(f.gates, "slash-executed")).exists()).toBe(true);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(1);
    await writeFile(path.join(f.gates, "mode"), "hold");
    expect((await f.command({ type: "session.prompt", sessionId: session.id, text: "Controlled running text turn", model, attachments: [] })).ok).toBe(true);
    expect(f.host.store.getSession(session.id)?.status).toBe("running");
    const steerDraft = { ...draft, text: "", attachments: [image] };
    const revision = f.host.store.getDraft(session.id)!.revision;
    expect((await f.command({ type: "draft.put", draft: steerDraft, expectedRevision: revision })).ok).toBe(true);
    const steerBefore = f.host.store.getDraft(session.id)!;
    const steer = await f.command({ type: "session.steer", sessionId: session.id, text: "", attachments: [image], approvalMode: "always-ask",
      draft: { id: session.id, revision: steerBefore.revision } });
    expect(steer.ok).toBe(false);
    if (!steer.ok) expect(steer.error.code).toBe("IMAGE_STEER_UNSUPPORTED");
    expect(f.host.store.getDraft(session.id)).toEqual(steerBefore);
    expect(f.host.store.getSession(session.id)?.approvalOverride).toBeUndefined();
    expect((await f.command({ type: "session.interrupt", sessionId: session.id })).ok).toBe(true);
    await f.settled(session.id);
    expect((await f.messages(session.id)).filter(row => row.role === "user")).toHaveLength(2);
    expect(f.host.store.getDraft(session.id)).toEqual(steerBefore);
  } finally { await f.close(); }
}, 45_000);
