import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { WorkerRuntime } from "../omp-workers/runtime";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("native file mentions persist and reopen with safe references and indexed image retrieval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-file-mentions-native-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const textName = "text with # and % and :.txt";
  const emptyName = "empty file.txt";
  const binaryName = "small binary.bin";
  const imageName = "one pixel.png";
  const directoryName = "directory # % :";
  const textPath = path.join(cwd, textName), emptyPath = path.join(cwd, emptyName);
  const binaryPath = path.join(cwd, binaryName), imagePath = path.join(cwd, imageName), directoryPath = path.join(cwd, directoryName);
  let manager: SessionManager | undefined;
  try {
  await Promise.all([
    writeFile(textPath, "alpha\nbeta\n"), writeFile(emptyPath, ""), writeFile(binaryPath, Buffer.from([0, 1, 2, 255])),
    writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG, "base64")), mkdir(directoryPath),
  ]);

  const generated = await generateFileMentionMessages([textName, emptyName, directoryName, binaryName, imageName], cwd, { autoResizeImages: false });
  expect(generated).toHaveLength(1);
  const nativeMessage = generated[0]!;
  if (nativeMessage.role !== "fileMention") throw new Error("Generator did not return a file mention message");
  expect(nativeMessage.role).toBe("fileMention");
  expect(nativeMessage.files.map(file => file.path)).toEqual([textName, emptyName, directoryName, binaryName, imageName]);
  expect(nativeMessage.files[3]?.skippedReason).toBe("binary");

  manager = SessionManager.create(cwd, path.join(root, "sessions"));
  await manager.ensureOnDisk();
  manager.appendMessage(nativeMessage as never);
  const sessionFile = manager.getSessionFile()!;
  await manager.close();

  const evidence: Record<string, unknown> = { sessionFile };
  const runtime = new WorkerRuntime({
    agentDir, workerPath: path.join(import.meta.dir, "../omp-workers/fixtures/no-provider-worker.ts"),
    environment: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: tmpdir(), TERM: "dumb", PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1" },
  });
  try {
    const session = await runtime.open({ sessionFile });
    const messages = await session.getMessages();
    const fileMessage = messages.find(message => message.role === "fileMention");
    expect(fileMessage).toBeDefined();
    if (!fileMessage || fileMessage.role !== "fileMention" || !fileMessage.fileReferences) throw new Error("Missing projected file mention");
    expect(fileMessage.fileReferences.map(file => file.path)).toEqual([textName, emptyName, directoryName, binaryName, imageName]);
    expect(fileMessage.fileReferences[0]).toMatchObject({ path: textName, content: "alpha\nbeta\n", lineCount: 3 });
    expect(fileMessage.fileReferences[1]).toMatchObject({ path: emptyName, content: "", lineCount: 1 });
    expect(fileMessage.fileReferences[2]).toMatchObject({ path: directoryName });
    expect(fileMessage.fileReferences[3]).toMatchObject({ path: binaryName, skippedReason: "binary", byteSize: 4 });
    const imageRef = fileMessage.fileReferences[4]?.image;
    expect(imageRef).toMatchObject({ blockIndex: 4, mimeType: "image/png", bytes: Buffer.from(ONE_PIXEL_PNG, "base64").byteLength });
    expect(JSON.stringify(fileMessage.fileReferences)).not.toContain(ONE_PIXEL_PNG);
    const image = await session.getImage(fileMessage.nativeId ?? fileMessage.id, imageRef!.blockIndex);
    expect(image.sha256).toBe(createHash("sha256").update(Buffer.from(ONE_PIXEL_PNG, "base64")).digest("hex"));
    evidence.reopened = fileMessage;
    evidence.image = { bytes: image.bytes, sha256: image.sha256, mimeType: image.mimeType };
    await expect(session.getImage(fileMessage.nativeId ?? fileMessage.id, 0)).rejects.toThrow();
    await session.dispose();

    const reopened = await runtime.open({ sessionFile });
    const same = (await reopened.getMessages()).find(message => message.role === "fileMention");
    expect(same?.fileReferences).toEqual(fileMessage.fileReferences);
    await reopened.dispose();
  } finally {
    await runtime.dispose();
    const evidenceDir = process.env.FILE_MENTION_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      const messages = evidence.reopened ? [evidence.reopened] : [];
      await writeFile(path.join(evidenceDir, "messages.json"), JSON.stringify(messages, null, 2));
      await writeFile(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));
    }
    await rm(root, { recursive: true, force: true });
  }
  } catch (error) {
    await manager?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}, 30_000);
