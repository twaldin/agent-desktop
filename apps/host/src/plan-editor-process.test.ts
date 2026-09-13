import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPlanEditorProcessFiles, createPlanEditorProcessFiles, planEditorProcessCommand, readPlanEditorProcessResult, runPlanEditorProcess } from "./plan-editor-process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), "agent-plan-editor-files-")); chmodSync(value, 0o700); roots.push(value); return value; }
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

test("private parent files and parsed result retain exact edited bytes", async () => {
  const directory = root(), editor = join(directory, "editor.ts");
  writeFileSync(editor, `#!/bin/sh\nprintf %s 'edited without final newline' > "$1"\n`, { mode: 0o700 });
  const command = quote(editor);
  const files = createPlanEditorProcessFiles(directory, { editorCommand: command, content: "before\n", extension: ".plan.md", trimTrailingNewline: false });
  expect(statSync(files.inputPath).mode & 0o777).toBe(0o600); expect(statSync(files.contentPath).mode & 0o777).toBe(0o600);
  const previousVisual = process.env.VISUAL, previousEditor = process.env.EDITOR;
  process.env.VISUAL = command; process.env.EDITOR = "must-not-run";
  try { expect(await runPlanEditorProcess(files.inputPath)).toMatchObject({ outcome: "completed", content: "edited without final newline" }); }
  finally { if (previousVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = previousVisual; if (previousEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = previousEditor; }
  expect(readPlanEditorProcessResult(files)).toMatchObject({ outcome: "completed", content: "edited without final newline" });
  expect(statSync(files.editedPath).mode & 0o777).toBe(0o600); expect(statSync(files.resultPath).mode & 0o777).toBe(0o600);
  cleanupPlanEditorProcessFiles(files); expect([files.inputPath, files.contentPath, files.editedPath, files.resultPath].some(existsSync)).toBe(false);
});

test("parent command is fixed to the current Bun/helper and malformed or tampered results are refused", () => {
  const directory = root(), files = createPlanEditorProcessFiles(directory, { editorCommand: "fixture-editor", content: "before", extension: ".md", trimTrailingNewline: true });
  const command = planEditorProcessCommand(files, { VISUAL: "fixture-editor", PI_DISABLE_DOTENV: "1" });
  expect(command.application).toBe(realpathSync(process.execPath));
  expect(command.args).toEqual(["--no-env-file", realpathSync(import.meta.dir + "/plan-editor-process.ts"), "--run", files.inputPath]);
  expect(command.environment).toEqual({ VISUAL: "fixture-editor", PI_DISABLE_DOTENV: "1", TMPDIR: files.scratchPath, TMP: files.scratchPath, TEMP: files.scratchPath });
  writeFileSync(files.resultPath, JSON.stringify({ version: 1, outcome: "completed", contentSha256: "0".repeat(64) }), { mode: 0o600 });
  writeFileSync(files.editedPath, "tampered", { mode: 0o600 });
  expect(() => readPlanEditorProcessResult(files)).toThrow("do not match");
});

test("native extension fidelity and recovery cleanup preserve only settled outputs", async () => {
  const directory = root(), editor = join(directory, "editor.ts");
  writeFileSync(editor, `#!/bin/sh\nprintf %s recovered > "$1"\n`, { mode: 0o700 });
  const command = quote(editor);
  const files = createPlanEditorProcessFiles(directory, { editorCommand: command, content: "before", extension: ". plan-\u00e9", trimTrailingNewline: false });
  const previousVisual = process.env.VISUAL;
  process.env.VISUAL = command;
  try { expect(await runPlanEditorProcess(files.inputPath)).toMatchObject({ outcome: "completed", content: "recovered" }); }
  finally { if (previousVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = previousVisual; }
  cleanupPlanEditorProcessFiles(files, { preserveEditedResult: true });
  expect(existsSync(files.inputPath)).toBe(false); expect(existsSync(files.contentPath)).toBe(false);
  expect(existsSync(files.scratchPath)).toBe(false);
  expect(readPlanEditorProcessResult(files)).toMatchObject({ outcome: "completed", content: "recovered" });
  cleanupPlanEditorProcessFiles(files);
  expect(() => createPlanEditorProcessFiles(directory, { editorCommand: command, content: "", extension: ".bad/path", trimTrailingNewline: false })).toThrow("extension");
});
