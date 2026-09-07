import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/file-mentions-ui-${Date.now()}`);
const input = process.argv[3];
if (!input) throw new Error("Usage: bun scripts/acceptance/file-mentions-ui.ts <empty-output-dir> <recorded-native-history.json> [controlled-owner-cwd]");
const history = resolve(repo, input);
const controlledOwnerCwd = process.argv[4] ?? "/recorded-owner/workspace";
if (!controlledOwnerCwd.startsWith("/")) throw new Error("The controlled owner cwd must be an absolute POSIX path.");
const sources = [
  "apps/desktop/src/renderer/Transcript.tsx",
  "apps/desktop/src/renderer/TranscriptFileMentions.tsx",
  "apps/desktop/src/renderer/TranscriptFileReference.tsx",
  "apps/desktop/src/renderer/transcript.css",
  "apps/desktop/src/renderer/transcript-file-reference.css",
  "apps/desktop/src/renderer/styles.css",
  "apps/desktop/src/renderer/theme.css",
  "packages/shared/src/protocol.ts",
  "scripts/acceptance/file-mentions-ui.ts",
  "scripts/acceptance/file-mentions-ui-browser.tsx",
  "scripts/acceptance/file-mentions-ui-electron.cjs",
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await readFile(join(repo, file), "utf8"))])));

function absolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return `/${parts.join("/")}`;
}
function literalActionPath(path: string, cwd: string): string | undefined {
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.startsWith("//")) return undefined;
  const root = absolutePath(cwd), resolved = absolutePath(path.startsWith("/") ? path : `${root}/${path}`);
  return resolved === root || root !== "/" && !resolved.startsWith(`${root}/`) ? undefined : resolved.slice(root === "/" ? 1 : root.length + 1);
}
function expectedHistory(value: unknown, cwd: string) {
  const wrapped = value as { messages?: unknown; reopened?: unknown };
  const messages = Array.isArray(value) ? value : Array.isArray(wrapped?.messages) ? wrapped.messages : wrapped?.reopened ? [wrapped.reopened] : undefined;
  if (!Array.isArray(messages)) throw new Error("Recorded native history must be an array, { messages }, or native-evidence { reopened }.");
  const message = messages.find((item: any) => item?.role === "fileMention" && Array.isArray(item.fileReferences) && item.fileReferences.length > 0);
  if (!message || typeof message.id !== "string" || typeof message.nativeId !== "string") throw new Error("Recorded history has no identified native fileMention entry.");
  const files = message.fileReferences.map((file: any) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Recorded native file reference is invalid.");
    return { path: file.path, content: file.content, skippedReason: file.skippedReason, actionPath: literalActionPath(file.path, cwd) };
  });
  return { messages, expected: { messageId: message.id, nativeId: message.nativeId, files } };
}

await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty.");
const original = await readFile(history, "utf8"), parsed = expectedHistory(JSON.parse(original), controlledOwnerCwd), sourceAtBuild = await hashes();
try {
  await writeFile(join(output, "native-messages.original.json"), original, { mode: 0o600 });
  await writeFile(join(output, "native-messages.json"), original, { mode: 0o600 });
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>File mentions acceptance</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "file-mentions-ui-browser.tsx"))}"></script>`);
  await build({ configFile: false, root: output, logLevel: "warn", plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "launch.json"), JSON.stringify({ profile: join(output, "electron-profile"), historyDigest: digest(original), controlledOwnerCwd, expected: parsed.expected }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "file-mentions-ui-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 90_000);
  const code = await electron.exited; clearTimeout(timer);
  const resultPath = join(output, "result.json"), result = JSON.parse(await readFile(resultPath, "utf8"));
  result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.history = { input: relative(repo, history), sha256: digest(original), copiedOriginal: "native-messages.original.json" };
  result.passed &&= code === 0 && result.sourceHashesStable;
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`File-mentions acceptance failed; inspect ${resultPath}`);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  await rm(join(output, "launch.json"), { force: true });
}
