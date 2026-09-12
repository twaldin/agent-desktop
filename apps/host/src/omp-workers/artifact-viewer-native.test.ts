import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkerRuntime } from "./runtime";

test("actual native tool history restores an artifact without replay, and its declared viewer saves only the original revision", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-artifact-viewer-"))), agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates"), log = path.join(root, "wire.jsonl");
  await Promise.all([agentDir, cwd, gates].map(value => mkdir(value)));
  await writeFile(path.join(cwd, "sample.report.note"), "original note");
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(path.join(import.meta.dir, "fixtures/artifact-provider.ts"))}\nretry:\n  enabled: false\n`);
  await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(import.meta.dir, "../omp/fixtures/artifact-server.ts")], env: { ARTIFACT_TEST_LOG: log } } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "fixtures/no-provider-worker.ts"), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, ARTIFACT_CONTRACT_GATES: gates, TERM: "dumb" } });
  try {
    let session = await runtime.create({ cwd, interactions: true, approvalOverride: "yolo" });
    expect(await session.prompt("Create the original report once.", { model: { provider: "artifact-contract", id: "controlled" } })).toBe(true);
    const messages = await session.getMessages(), row = messages.find(value => value.mcpArtifact);
    if (process.env.ARTIFACT_EVIDENCE_DIRECTORY) {
      await mkdir(process.env.ARTIFACT_EVIDENCE_DIRECTORY, { recursive: true });
      await writeFile(path.join(process.env.ARTIFACT_EVIDENCE_DIRECTORY, "messages.json"), JSON.stringify(messages, null, 2));
      await writeFile(path.join(process.env.ARTIFACT_EVIDENCE_DIRECTORY, "native.jsonl"), await readFile(session.sessionFile));
      await writeFile(path.join(process.env.ARTIFACT_EVIDENCE_DIRECTORY, "wire.jsonl"), await readFile(log));
    }
    expect(row?.mcpArtifact).toMatchObject({ serverName: "fixture", toolName: "report", resourceUri: "ui://artifact-result", arguments: { title: "Original report" }, result: { structuredContent: { calls: 1, retained: [3, 5, 8] }, _meta: { privateResult: "retained-native" } } });
    if (!row?.mcpArtifact) throw new Error("Native completed result did not preserve its artifact");
    const saved = row.mcpArtifact, sessionFile = session.sessionFile;
    await session.dispose(); session = await runtime.open({ sessionFile, interactions: true, approvalOverride: "yolo" });
    expect((await session.getMessages()).find(value => value.nativeId === saved.entryId)?.mcpArtifact).toEqual(saved);
    const catalogue = await session.getSessionMcp(), server = catalogue.servers.find(value => value.name === "fixture")!;
    const selection = { epoch: catalogue.epoch, expectedRevision: catalogue.revision, serverName: "fixture", toolName: saved.toolName, resourceUri: saved.resourceUri };
    expect(await session.sessionMcpApp({ type: "open", channelId: "artifact", selection, source: { type: "artifact", entryId: saved.entryId } })).toMatchObject({ type: "opened", initialResult: saved.result, initialArguments: saved.arguments });
    expect(server.fileViewers?.[0]?.extensions).toEqual([".note", "report.note"]); expect(server.apps).toEqual([]);
    const source = { type: "file" as const, path: "sample.report.note", resourceUri: "codex-resource://original-file" };
    const viewer = server.fileViewers![0]!;
    const opened = await session.sessionMcpApp({ type: "open", channelId: "viewer", selection: { ...selection, toolName: viewer.toolName, resourceUri: viewer.resourceUri }, source });
    expect(opened).toMatchObject({ type: "opened", initialArguments: { file: { name: source.path, resourceUri: source.resourceUri } } });
    const call = await session.sessionMcpApp({ type: "request", channelId: "viewer", requestId: "initial", method: "tools/call", params: { name: "viewer", arguments: { file: { name: source.path, resourceUri: source.resourceUri } } } });
    expect(call).toMatchObject({ value: { structuredContent: { metadata: { "openai/resource": { path: path.join(cwd, source.path) } } } } });
    const read = await session.sessionMcpApp({ type: "request", channelId: "viewer", requestId: "read", method: "resources/read", params: { uri: source.resourceUri } });
    expect(read).toMatchObject({ type: "result", value: { extension: "report.note", contents: [{ text: "original note" }] } });
    if (read.type !== "result") throw new Error("Missing original file read");
    const meta = read.value._meta as { "openai/resource": { etag: string } }, etag = meta["openai/resource"].etag;
    const savedFile = await session.sessionMcpApp({ type: "request", channelId: "viewer", requestId: "save", method: "openai/resources/write", params: { uri: source.resourceUri, ifMatch: etag, text: "saved note" } });
    expect(savedFile).toMatchObject({ type: "result", value: { outcome: "saved" } }); expect(await readFile(path.join(cwd, source.path), "utf8")).toBe("saved note");
    expect(await session.sessionMcpApp({ type: "request", channelId: "viewer", requestId: "stale", method: "openai/resources/write", params: { uri: source.resourceUri, ifMatch: etag, text: "stale note" } })).toMatchObject({ value: { outcome: "conflict" } });
    await session.sessionMcpApp({ type: "close", channelId: "viewer" }); await session.sessionMcpApp({ type: "close", channelId: "artifact" });
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(value => value.method === "tools/call" && value.params.name === "report")).toHaveLength(1);
    expect(requests.some(value => value.method === "resources/read" && String(value.params.uri).startsWith("codex-resource://"))).toBe(false);
    await session.dispose();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 40_000);
