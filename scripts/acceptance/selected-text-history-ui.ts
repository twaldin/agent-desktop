import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/selected-text-history-ui-${Date.now()}`);
const input = process.argv[3];
if (!input) throw new Error("Usage: bun scripts/acceptance/selected-text-history-ui.ts <empty-output-dir> <recorded-native-history.json>");
const history = resolve(repo, input);
const sources = [
  "apps/desktop/src/renderer/Transcript.tsx",
  "apps/desktop/src/renderer/transcript.css",
  "apps/desktop/src/renderer/ComposerSelectedText.tsx",
  "apps/desktop/src/renderer/composer-selected-text.css",
  "apps/desktop/src/renderer/MarkdownText.tsx",
  "apps/desktop/src/renderer/styles.css",
  "apps/desktop/src/renderer/theme.css",
  "packages/shared/src/protocol.ts",
  "scripts/acceptance/selected-text-history-ui.ts",
  "scripts/acceptance/selected-text-history-ui-browser.tsx",
  "scripts/acceptance/selected-text-history-ui-electron.cjs",
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await readFile(join(repo, file), "utf8"))])));
const expectedHistory = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error("Native history must be an array.");
  const user = value.find((item: any) => item?.role === "user" && item?.selectedText);
  const selected = user?.selectedText, item = selected?.attachments?.[0];
  if (!user || typeof selected?.contextEntryId !== "string" || typeof selected?.bindingEntryId !== "string" || typeof selected?.submissionId !== "string"
    || !Array.isArray(selected.attachments) || !item || typeof item.text !== "string" || item.source?.kind !== "file" || typeof item.source.hostId !== "string" || typeof item.source.path !== "string")
    throw new Error("Recorded native history has no explicit selected-text binding.");
  if (typeof user.id !== "string" || typeof user.nativeId !== "string" || selected.attachments.some((attachment: any) => typeof attachment?.id !== "string" || typeof attachment?.text !== "string"))
    throw new Error("Recorded native history has no stable sent-message or selection identities.");
  return {
    userMessageId: user.id,
    userNativeId: user.nativeId,
    contextEntryId: selected.contextEntryId,
    bindingEntryId: selected.bindingEntryId,
    submissionId: selected.submissionId,
    label: `${selected.attachments.length} ${selected.attachments.length === 1 ? "selection" : "selections"}`,
    attachments: selected.attachments.map((attachment: any) => ({ id: attachment.id, text: attachment.text })),
  };
};

await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const original = await readFile(history, "utf8"), parsed = JSON.parse(original);
const expected = expectedHistory(parsed);
const sourceAtBuild = await hashes();
try {
  await writeFile(join(output, "native-messages.original.json"), original, { mode: 0o600 });
  await writeFile(join(output, "native-messages.json"), original, { mode: 0o600 });
  await writeFile(join(output, "index.html"), `<!doctype html><meta charset="utf-8"><title>Selected text history acceptance</title><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "selected-text-history-ui-browser.tsx"))}"></script>`);
  await build({ configFile: false, root: output, logLevel: "warn", plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
  await writeFile(join(output, "launch.json"), JSON.stringify({ profile: join(output, "electron-profile"), historyDigest: digest(original), expected }), { mode: 0o600 });
  const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "selected-text-history-ui-electron.cjs"), output], { stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")) });
  const timer = setTimeout(() => electron.kill("SIGTERM"), 90_000);
  const code = await electron.exited; clearTimeout(timer);
  const resultPath = join(output, "result.json"), result = JSON.parse(await readFile(resultPath, "utf8"));
  result.sourceAtBuild = sourceAtBuild; result.sourceAfterRun = await hashes(); result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfterRun);
  result.history = { input: relative(repo, history), sha256: digest(original), copiedOriginal: "native-messages.original.json" };
  result.passed &&= code === 0 && result.sourceHashesStable;
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error(`Selected-text history acceptance failed; inspect ${resultPath}`);
  console.log(JSON.stringify({ passed: true, output }));
} finally {
  await rm(join(output, "launch.json"), { force: true });
}
