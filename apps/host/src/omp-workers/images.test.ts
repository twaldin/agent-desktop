import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";
import { projectWorkerEvent } from "./events";
import type { WorkerEvent } from "./events";
import type { PreparedPromptImage } from "../omp";
import { ImageAttachmentStore } from "../attachments";
import { serializeRepeatedWholeFilePrompt, serializeWholeFilePrompt } from "@agent-desktop/shared";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const vision = { provider: "image-contract", id: "vision" };

async function waitForEvents(events: WorkerEvent[], types: WorkerEvent["type"][]) {
  const deadline = Date.now() + 7_000;
  while (!types.every(type => events.some(event => event.type === type)) && Date.now() < deadline) await Bun.sleep(5);
}

async function fixture(config = "", worker = "no-provider-worker.ts") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-image-worker-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(gates)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/image-provider.ts", import.meta.url)))}\ndefaultThinkingLevel: off\nretry:\n  enabled: false\n${config}`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL(`./fixtures/${worker}`, import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, IMAGE_CONTRACT_GATES: gates, TERM: "dumb" } });
  await mkdir(path.join(root, "attachment-store"));
  const store = new ImageAttachmentStore(path.join(root, "attachment-store"));
  let id = 0;
  const image = async (data: Uint8Array): Promise<PreparedPromptImage> => {
    const metadata = await store.putImage(hash(data), data);
    const verified = await store.readValidatedImage(metadata.sha256);
    return { attachment: { id: `image-${++id}`, hostId: "isolated-owner", kind: "image", name: `image-${id}`,
      sha256: metadata.sha256, bytes: metadata.bytes, mimeType: metadata.mimeType }, data: verified.bytes };
  };
  return { root, agentDir, cwd, gates, runtime, image, close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("active native Queue and Steer preserve original image bytes through IPC, history and reopen", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.gates, "mode"), "hold");
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const prompt = session.startPrompt("hold image follow-ups", { model: vision });
    await prompt.accepted;
    const first = await f.image(png), second = await f.image(await new Bun.Image(png).resize(90, 50).jpeg().bytes());
    const queued = session.startFollowUp("", "follow-up", undefined, [first]);
    const steered = session.startFollowUp("inspect second image", "steer", undefined, [second]);
    // The public parent API must copy before its caller can mutate borrowed bytes.
    first.data.fill(0); second.attachment.name = "caller changed this after dispatch";
    expect(await queued.accepted).toEqual({ kind: "queued", delivery: "follow-up" });
    expect(await steered.accepted).toEqual({ kind: "queued", delivery: "steer" });
    expect((await session.getQueuedMessages()).messages.map(item => [item.lane, item.text, item.imageCount]))
      .toEqual([["steer", "inspect second image", 1], ["follow-up", "[Image]", 1]]);
    await writeFile(path.join(f.gates, "mode"), "");
    const receipts = await Promise.all([queued.completion, steered.completion]);
    await prompt.completion;
    const recorded = [];
    for (const receipt of receipts) {
      expect(receipt.kind).toBe("user-message");
      if (receipt.kind !== "user-message") throw new Error(receipt.reason);
      const bytes = await session.getImage(receipt.entryId, 1);
      expect(hash(bytes.data)).toBe(bytes.sha256);
      recorded.push({ entryId: receipt.entryId, sha256: bytes.sha256 });
    }
    expect(new Set(recorded.map(image => image.entryId)).size).toBe(2);
    const input = JSON.parse(await readFile(path.join(f.gates, "provider-input.json"), "utf8"));
    const imageHashes = input.flatMap((message: { content: { type: string; sha256?: string }[] }) => message.content.filter(block => block.type === "image").map(block => block.sha256));
    expect(imageHashes.sort()).toEqual(recorded.map(image => image.sha256).sort());
    const sourceFile = session.sessionFile;
    await session.dispose();
    const reopened = await f.runtime.open({ sessionFile: sourceFile });
    for (const image of recorded) expect((await reopened.getImage(image.entryId, 1)).sha256).toBe(image.sha256);
    expect((await reopened.getMessages()).filter(message => message.role === "user")).toHaveLength(3);
  } finally { await f.close(); }
}, 40_000);

test("active images reject incompatible models and commands without entering the native queue", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.gates, "mode"), "hold");
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const prompt = session.startPrompt("text-only held turn", { model: { provider: "image-contract", id: "text" } });
    await prompt.accepted;
    const image = await f.image(png);
    const rejected = session.startFollowUp("", "follow-up", undefined, [image]);
    await expect(rejected.accepted).rejects.toThrow("does not accept images");
    expect(await rejected.completion).toMatchObject({ kind: "not-recorded" });
    const command = session.startFollowUp("/image-effect", "steer", undefined, [image]);
    await expect(command.accepted).rejects.toThrow("slash commands");
    expect(await command.completion).toMatchObject({ kind: "not-recorded" });
    expect((await session.getQueuedMessages()).messages).toEqual([]);
    expect(await Bun.file(path.join(f.gates, "slash-executed")).exists()).toBe(false);
    await session.abort(); await prompt.completion;
  } finally { await f.close(); }
}, 30_000);

test("actual native worker records an image-only ordered turn, normalization receipts, lazy bytes and reopen (controlled provider)", async () => {
  const f = await fixture();
  try {
    const first = await f.image(png), second = await f.image(await new Bun.Image(png).resize(220, 240).jpeg().bytes());
    const events: WorkerEvent[] = [];
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true, onEvent: event => events.push(event) });
    const run = session.startPrompt("", { model: vision, images: [first, second] });
    const accepted = await run.accepted;
    expect(accepted?.kind).toBe("user-message");
    if (accepted?.kind !== "user-message") throw new Error("Expected actual native image admission");
    expect(accepted.images?.map(image => image.attachmentId)).toEqual([first.attachment.id, second.attachment.id]);
    expect(accepted.images?.map(image => image.sourceSha256)).toEqual([first.attachment.sha256, second.attachment.sha256]);
    expect(accepted.images?.[0]?.nativeSha256).not.toBe(first.attachment.sha256);
    expect(await run.completion).toBe(true);
    const input = JSON.parse(await readFile(path.join(f.gates, "provider-input.json"), "utf8"));
    expect(input.at(-1).content.filter((block: { type: string }) => block.type === "image").map((block: { sha256: string }) => block.sha256)).toEqual(accepted.images!.map(image => image.nativeSha256));
    const before = await session.getMessages(), user = before.find(message => message.nativeId === accepted.entryId)!;
    expect(user.text).toBe("");
    expect(user.content?.filter(block => block.type === "image").map(block => block.sha256)).toEqual(accepted.images!.map(image => image.nativeSha256));
    expect(JSON.stringify(before)).not.toContain(first.data.toBase64());
    await waitForEvents(events, ["message_start", "message_end"]);
    expect(JSON.stringify(events)).not.toContain(first.data.toBase64());
    expect(events.some(event => event.type === "message_start")).toBe(true);
    expect(events.some(event => event.type === "message_end")).toBe(true);
    for (const image of accepted.images!) {
      const bytes = await session.getImage(accepted.entryId, image.blockIndex);
      expect(hash(bytes.data)).toBe(image.nativeSha256);
      expect(bytes.mimeType).toBe(image.mimeType);
    }
    const read1 = session.getImage(accepted.entryId, 1), read2 = session.getImage(accepted.entryId, 2);
    await expect(session.getImage(accepted.entryId, 1)).rejects.toThrow("retrieval limit");
    await Promise.all([read1, read2]);
    await expect(session.getImage(accepted.entryId, 0)).rejects.toThrow("Native image");
    await expect(session.getImage("../../not-a-session-entry", 1)).rejects.toThrow("unavailable");
    const file = session.sessionFile, id = session.id;
    const persisted = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.id === accepted.entryId);
    expect(persisted.message.content.some((block: { data?: string }) => block.data?.startsWith("blob:sha256:"))).toBe(true);
    await session.dispose();
    const reopened = await f.runtime.open({ sessionFile: file, interactions: true });
    expect(reopened.id).toBe(id);
    const restored = (await reopened.getMessages()).find(message => message.nativeId === accepted.entryId)!;
    expect(restored.content).toEqual(user.content);
    for (const image of accepted.images!) expect(hash((await reopened.getImage(accepted.entryId, image.blockIndex)).data)).toBe(image.nativeSha256);
  } finally { await f.close(); }
}, 30_000);

for (const repeated of [false, true]) test(`${repeated ? "repeated-v3" : "distinct-v2"} inline whole files preserve serialized native text through actual image admission and reopen`, async () => {
  const f = await fixture();
  try {
    const filePath = path.join(f.cwd, "@linked # file.txt"); await writeFile(filePath, "bound whole-file context\n");
    const authoredText = "show @authored", attachments = repeated ? [
        { id: "whole-first", textOffset: 5, source: { kind: "file" as const, hostId: "isolated-owner", path: filePath } },
        { id: "whole-second", textOffset: authoredText.length, source: { kind: "file" as const, hostId: "isolated-owner", path: filePath } },
      ] : [{ id: "whole", textOffset: 5, source: { kind: "file" as const, hostId: "isolated-owner", path: filePath } }];
    const nativeText = repeated ? serializeRepeatedWholeFilePrompt(authoredText, attachments)
      : serializeWholeFilePrompt(authoredText, attachments), image = await f.image(png);
    const submissionId = repeated ? "image-and-whole-v3" : "image-and-whole-v2";
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const oversized = "x".repeat(499_999);
    const rejected = session.startPrompt(oversized, { model: vision, wholeFiles: { submissionId: "too-large", attachments: [{ ...attachments[0]!, textOffset: oversized.length }] } });
    await expect(rejected.accepted).rejects.toThrow("durable-history limit"); await expect(rejected.completion).rejects.toThrow("durable-history limit");
    expect((await session.getMessages()).some(message => message.role === "fileMention" || message.role === "user")).toBe(false);
    expect(await readFile(session.sessionFile, "utf8")).not.toContain("too-large");
    const run = session.startPrompt(authoredText, { model: vision, images: [image], wholeFiles: { submissionId, attachments } });
    const accepted = await run.accepted; expect(accepted?.kind).toBe("user-message"); await expect(run.completion).resolves.toBe(true);
    if (accepted?.kind !== "user-message") throw new Error("Expected actual native image/file admission");
    const provider = JSON.parse(await readFile(path.join(f.gates, "provider-input.json"), "utf8"));
    // OMP may append a date/cwd reminder as another model-visible user message.
    // Identify our exact submitted text, rather than assuming it is the last row.
    const submitted = provider.filter((message: {content: unknown}) => Array.isArray(message.content)
      && message.content.some(block => block.type === "text" && block.text === nativeText));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].content.filter((block: {type: string}) => block.type === "image"))
      .toEqual([expect.objectContaining({sha256: accepted.images?.[0]?.nativeSha256})]);
    const messages = await session.getMessages(), user = messages.find(message => message.nativeId === accepted?.entryId);
    expect(user).toMatchObject({ role: "user", text: nativeText, wholeFiles: { submissionId, authoredText, attachments } });
    expect(user?.content?.filter(block => block.type === "image")).toHaveLength(1);
    expect(messages.some(message => message.role === "fileMention")).toBe(false);
    const nativeEntries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(nativeEntries.filter(entry => entry.type === "message" && entry.message?.role === "fileMention")).toHaveLength(1);
    expect(nativeEntries.find(entry => entry.customType === "agent-desktop.whole-file-binding")?.data?.version).toBe(repeated ? 3 : 2);
    const sessionFile = session.sessionFile; await session.dispose();
    const reopened = await f.runtime.open({ sessionFile, interactions: true });
    const restored = (await reopened.getMessages()).find(message => message.nativeId === accepted?.entryId);
    expect(restored).toMatchObject({ text: nativeText, wholeFiles: { submissionId, authoredText, attachments } });
    expect(restored?.content?.filter(block => block.type === "image")).toHaveLength(1);
  } finally { await f.close(); }
}, 30_000);

test("a native image flush failure never certifies admission; abort retains already accepted images", async () => {
  const f = await fixture("", "image-failure-worker.ts");
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const images = [await f.image(png)];
    await writeFile(path.join(f.gates, "fail-flush"), "");
    const failed = session.startPrompt("Uncertified native storage", { model: vision, images });
    await expect(failed.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", name: "OmpPromptAdmissionError" });
    await expect(failed.completion).rejects.toThrow("storage certification failure");
    await rm(path.join(f.gates, "fail-flush"));
    expect((await session.getMessages()).some(message => message.role === "user")).toBe(true);
    await writeFile(path.join(f.gates, "mode"), "hold");
    const running = session.startPrompt("Interrupt after actual image admission", { model: vision, images });
    const accepted = await running.accepted;
    expect(accepted?.kind).toBe("user-message");
    expect(() => session.startPrompt("Concurrent image input", { model: vision, images })).toThrow("busy");
    await session.abort(); await running.completion;
    expect((await session.getMessages()).filter(message => message.role === "user").length).toBe(2);
    const file = session.sessionFile;
    await session.dispose();
    const reopened = await f.runtime.open({ sessionFile: file });
    if (accepted?.kind !== "user-message") throw new Error("Expected certified native admission before abort");
    expect(hash((await reopened.getImage(accepted.entryId, 1)).data)).toBe(accepted.images![0]!.nativeSha256);
  } finally { await f.close(); }
}, 30_000);

test("native image admission rejects nonvision/settings/slash/steer and altered normalized slots before dispatch", async () => {
  const f = await fixture();
  try {
    const first = await f.image(png), second = await f.image(await new Bun.Image(png).resize(220, 240).jpeg().bytes());
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const rejected = async (text: string, model = vision, images = [first]) => {
      const run = session.startPrompt(text, { model, images });
      await expect(run.accepted).rejects.toThrow(); await expect(run.completion).rejects.toThrow();
      expect((await session.getMessages()).some(message => message.role === "user")).toBe(false);
      expect(await Bun.file(path.join(f.gates, "provider-input.json")).exists()).toBe(false);
    };
    await rejected("Image with text-only model", { provider: "image-contract", id: "text" });
    await rejected("/image-effect"); await rejected("  /image-effect");
    expect(await Bun.file(path.join(f.gates, "slash-executed")).exists()).toBe(false);
    await expect(session.steer("Image steer", undefined, { images: [first] })).rejects.toThrow("not supported on steering");
    await writeFile(path.join(f.gates, "mode"), "reorder");
    await rejected("Retain original order", vision, [first, second]);
    await rm(path.join(f.gates, "mode"));
    // Empty attachment arrays retain the exact existing text-command path.
    const textCommand = session.startPrompt("/image-effect", { images: [] });
    expect(await textCommand.accepted).toEqual({ kind: "native-command", command: "image-effect" });
    expect(await textCommand.completion).toBe(false);
    expect(await Bun.file(path.join(f.gates, "slash-executed")).exists()).toBe(true);
    const corrupt = { ...first, data: new Uint8Array(first.data).fill(0) };
    expect(() => session.startPrompt("Corrupt immutable bytes", { images: [corrupt] })).toThrow("hash");
  } finally { await f.close(); }
  const blocked = await fixture("images:\n  blockImages: true\n");
  try {
    const session = await blocked.runtime.create({ cwd: blocked.cwd, interactions: true });
    const run = session.startPrompt("Never strip this image", { model: vision, images: [await blocked.image(png)] });
    await expect(run.accepted).rejects.toThrow("blocked"); await expect(run.completion).rejects.toThrow("blocked");
    expect((await session.getMessages()).length).toBe(0);
    expect(await Bun.file(path.join(blocked.gates, "provider-input.json")).exists()).toBe(false);
  } finally { await blocked.close(); }
}, 30_000);

test("maximum four-image 20 MiB IPC batch preserves distinct receipts and projected event queue stays bounded", async () => {
  const f = await fixture();
  try {
    // Actual decodable PNG plus inert trailing padding gives an exact ingress
    // byte boundary without allocating a decompression bomb or huge pixel grid.
    const bytes = new Uint8Array(5 * 1024 * 1024); bytes.set(png);
    const images = await Promise.all(Array.from({ length: 4 }, () => f.image(bytes)));
    const events: WorkerEvent[] = [];
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true, onEvent: event => events.push(event) });
    const start = performance.now();
    const run = session.startPrompt("Maximum image transport contract", { model: vision, images });
    // Caller mutation after capture cannot change the already issued envelope.
    images[0]!.data.fill(0);
    const receipt = await run.accepted;
    expect(receipt?.kind).toBe("user-message");
    if (receipt?.kind !== "user-message") throw new Error("Missing native maximum-batch receipt");
    expect(receipt.images?.length).toBe(4);
    expect(new Set(receipt.images!.map(image => image.attachmentId)).size).toBe(4);
    expect(new Set(receipt.images!.map(image => image.nativeSha256)).size).toBe(1);
    expect(await run.completion).toBe(true);
    expect(session.workerFailure).toBeUndefined();
    expect(JSON.stringify(events).length).toBeLessThan(100_000);
    expect(performance.now() - start).toBeLessThan(20_000);
    const raw = { type: "message_end", message: { role: "user", content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }], timestamp: 1 } } as const;
    let total = 0;
    for (let index = 0; index < 2048; index++) total += JSON.stringify(projectWorkerEvent(raw as never)).length;
    expect(total).toBeLessThan(256_000);
  } finally { await f.close(); }
}, 30_000);
