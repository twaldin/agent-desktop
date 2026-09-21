import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRecordedTextChanges, type RecordedTextChange, type RecordedTextFile } from "../../apps/host/src/turn-review/recorded-diff";
import { parseReviewPatch } from "../../apps/desktop/src/renderer/review-model";
import { fixtureGit } from "./git-file-fixture";

const output = process.argv[2];
if (!output) throw new Error("An owned evidence output directory is required.");
const root = await mkdtemp(join(tmpdir(), "agent-turn-recorded-")), cwd = join(root, "project"), applyCwd = join(root, "apply");
await mkdir(cwd); await mkdir(applyCwd); await mkdir(output, { recursive: true });
Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_DISABLE_DOTENV: "1", XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") });
let fetches = 0;
const denyNetwork = () => { fetches++; throw new Error("Recorded transition acceptance must not fetch"); };
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
let manager: Awaited<ReturnType<typeof SessionManager.open>> | undefined;
async function observe(path: string, directory = cwd): Promise<RecordedTextFile | null> {
  const full = join(directory, path);
  let metadata;
  try { metadata = await lstat(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  assert(metadata.isFile() || metadata.isSymbolicLink());
  return { path, text: metadata.isSymbolicLink() ? await readlink(full) : await readFile(full, "utf8"), mode: metadata.isSymbolicLink() ? "120000" : metadata.mode & 0o111 ? "100755" : "100644" };
}
async function put(file: RecordedTextFile, directory: string): Promise<void> {
  const full = join(directory, file.path); await mkdir(join(full, ".."), { recursive: true });
  if (file.mode === "120000") await symlink(file.text, full);
  else { await writeFile(full, file.text); await chmod(full, file.mode === "100755" ? 0o755 : 0o644); }
}
async function snapshot(directory: string): Promise<unknown[]> {
  const files: unknown[] = [];
  async function visit(dir: string, prefix: string) {
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name), path = `${prefix}${name}`, metadata = await lstat(full);
      if (metadata.isDirectory()) await visit(full, `${path}/`);
      else files.push([path, metadata.mode, metadata.isSymbolicLink() ? await readlink(full) : createHash("sha256").update(await readFile(full)).digest("hex")]);
    }
  }
  await visit(directory, ""); return files;
}
try {
  fixtureGit(cwd, ["init", "--initial-branch=main"]);
  const oddPath = "src/café [literal]\\name\tnew\n.txt";
  const seed: RecordedTextFile[] = [
    { path: "src/original.txt", text: "HEAD text\n", mode: "100644" },
    { path: "src/deleted.txt", text: "deleted by this turn\n", mode: "100644" },
    { path: "src/mode.sh", text: "#!/bin/sh\necho unchanged\n", mode: "100644" },
    { path: "src/newline.txt", text: "no final newline", mode: "100644" },
    { path: "src/link", text: "../../outside-secret", mode: "120000" },
    { path: "src/regular-to-link", text: "regular bytes\n", mode: "100644" },
    { path: "src/link-to-regular", text: "../../outside-secret", mode: "120000" },
  ];
  for (const file of seed) await put(file, cwd);
  await writeFile(join(root, "outside-secret"), "must not enter review\n");
  fixtureGit(cwd, ["add", "."]); fixtureGit(cwd, ["commit", "-m", "Recorded transition fixture"]);
  // The turn begins from dirty bytes, not HEAD or the index.
  await writeFile(join(cwd, "src/original.txt"), "dirty before turn\n");
  const beforeFiles = await Promise.all(seed.map(file => observe(file.path)));
  const gitBefore = { head: fixtureGit(cwd, ["rev-parse", "HEAD"]), index: await readFile(join(cwd, ".git/index")), config: await readFile(join(cwd, ".git/config")) };
  manager = SessionManager.create(cwd, join(root, "sessions"));
  const userEntryId = manager.appendMessage({ role: "user", content: "Fixture records explicit file transitions", timestamp: 1 });
  const changes: RecordedTextChange[] = [];
  async function record(beforePath: string, afterPath: string, mutate: () => Promise<unknown>) {
    const before = await observe(beforePath); await mutate(); const after = await observe(afterPath);
    const change = { before, after }; changes.push(change);
    // Fixture-owned evidence, not a claim that native OMP automatically captures this.
    manager!.appendCustomEntry("fixture-recorded-file-transition", change);
  }
  await record("src/original.txt", "src/original.txt", () => writeFile(join(cwd, "src/original.txt"), "first observed edit\n"));
  await record("src/original.txt", "src/original.txt", () => writeFile(join(cwd, "src/original.txt"), "final recorded edit\n"));
  await record("src/original.txt", oddPath, () => rename(join(cwd, "src/original.txt"), join(cwd, oddPath)));
  await record("src/deleted.txt", "src/deleted.txt", () => rm(join(cwd, "src/deleted.txt")));
  await record("src/mode.sh", "src/mode.sh", () => chmod(join(cwd, "src/mode.sh"), 0o755));
  await record("src/newline.txt", "src/newline.txt", () => writeFile(join(cwd, "src/newline.txt"), "now has final newline\n"));
  await record("src/empty.txt", "src/empty.txt", () => writeFile(join(cwd, "src/empty.txt"), ""));
  await record("src/temporary.txt", "src/temporary.txt", () => writeFile(join(cwd, "src/temporary.txt"), "cancelled\n"));
  await record("src/temporary.txt", "src/temporary.txt", () => rm(join(cwd, "src/temporary.txt")));
  await record("src/link", "src/link", async () => { await rm(join(cwd, "src/link")); await symlink("../../different-target", join(cwd, "src/link")); });
  await record("src/regular-to-link", "src/regular-to-link", async () => { await rm(join(cwd, "src/regular-to-link")); await symlink("../../outside-secret", join(cwd, "src/regular-to-link")); });
  await record("src/link-to-regular", "src/link-to-regular", async () => { await rm(join(cwd, "src/link-to-regular")); await writeFile(join(cwd, "src/link-to-regular"), "replaced link without following it\n"); });
  const touched = [...new Set(changes.flatMap(change => [change.before?.path, change.after?.path].filter((path): path is string => !!path)))];
  const expectedAfter = await Promise.all(touched.map(path => observe(path)));
  await manager.ensureOnDisk(); await manager.flush(); const sessionFile = manager.getSessionFile()!;
  await manager.close(); manager = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
  const persisted = manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "fixture-recorded-file-transition").map(entry => entry.type === "custom" ? entry.data as RecordedTextChange : null).filter((change): change is RecordedTextChange => change !== null);
  assert.equal(persisted.length, changes.length);
  await manager.close(); manager = undefined;
  await writeFile(join(cwd, oddPath), "later unrelated disk edit\n");
  const beforeRead = await snapshot(cwd);
  const review = composeRecordedTextChanges(persisted);
  assert.deepEqual(await snapshot(cwd), beforeRead);
  assert(!review.patch.includes("HEAD text") && !review.patch.includes("later unrelated disk edit") && !review.patch.includes("must not enter review"));
  const parsed = parseReviewPatch(review.patch, "recorded-native-session");
  const rendererBoundary = { expectedPaths: review.files.map(file => file.path), parsedPaths: parsed.files.map(file => file.metadata.name), scope: "Observation only: existing shared renderer is outside this prerequisite. It must preserve quoted rename identity and fold file-type replacement sections before Turn UI integration." };
  assert(!review.files.some(file => file.path === "src/temporary.txt"));
  fixtureGit(applyCwd, ["init", "--initial-branch=main"]);
  for (const file of beforeFiles) if (file) await put(file, applyCwd);
  fixtureGit(applyCwd, ["add", "."]); fixtureGit(applyCwd, ["commit", "-m", "Actual pre-turn bytes"]);
  const patchPath = join(root, "recorded.patch"); await writeFile(patchPath, review.patch);
  fixtureGit(applyCwd, ["apply", "--check", patchPath]); fixtureGit(applyCwd, ["apply", patchPath]);
  assert.deepEqual(await Promise.all(touched.map(path => observe(path, applyCwd))), expectedAfter);
  assert.equal(fixtureGit(cwd, ["rev-parse", "HEAD"]), gitBefore.head);
  assert.deepEqual(await readFile(join(cwd, ".git/index")), gitBefore.index);
  assert.deepEqual(await readFile(join(cwd, ".git/config")), gitBefore.config);
  assert.equal(fetches, 0);
  await writeFile(join(output, "recorded.patch"), review.patch);
  await writeFile(join(output, "native-session.jsonl"), await readFile(sessionFile));
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, userEntryId, nativeSessionReopened: true, transitions: persisted.length, files: review.files, gitApplyCheck: 0, gitApply: 0, reproducedRecordedAfterBytes: true, reviewDidNotChangeRepository: true, headIndexConfigUnchanged: true, fetches, rendererBoundary, scope: "Explicit fixture-observed filesystem transitions persisted through native SessionManager; pure production composer; actual Git apply. Pierre parser observation is not UI acceptance. Not automatic native capture, provider execution, host transport or App UI." }, null, 2));
  console.log("TURN_RECORDED_DIFF_PASS", JSON.stringify({ transitions: persisted.length, files: review.files.length, nativeSessionReopened: true, gitApply: true, reviewReadOnly: true, fetches }));
  await rm(root, { recursive: true, force: true });
} catch (error) {
  await manager?.close();
  await writeFile(join(output, "failure.json"), JSON.stringify({ root, error: String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2));
  throw error;
}
