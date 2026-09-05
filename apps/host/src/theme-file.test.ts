import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_THEME, type ThemeDocument } from "../../../packages/shared/src/theme";
import { PreferencesSync } from "./preferences-sync";
import { HostStore } from "./store";
import { ThemeConflictError, ThemeFile } from "./theme-file";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const serialize = (document: ThemeDocument) => JSON.stringify(document, null, 2) + "\n";
const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-theme-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new HostStore(directory); cleanup.push(async () => store.close());
  const preferences = new PreferencesSync(store, () => {}); cleanup.push(() => preferences.dispose());
  const theme = new ThemeFile({ dataDirectory: directory, store, preferences, changed() {} }); cleanup.push(() => theme.dispose());
  return { directory, store, preferences, theme };
}

test("theme saves reject stale revisions and replicated preference changes reach the editable file", async () => {
  const { theme, preferences } = await fixture();
  const initial = await theme.refresh();
  expect(initial.document).toEqual(DEFAULT_THEME);
  const saved = await theme.set({ ...DEFAULT_THEME, mode: "dark", tokens: { "--sidebar-surface": "#242424" } }, initial.revision);
  expect(saved.revision).not.toBe(initial.revision);
  await expect(theme.set(DEFAULT_THEME, initial.revision)).rejects.toBeInstanceOf(ThemeConflictError);
  preferences.put({ key: "theme.tokens", value: { "--sidebar-surface": "#112233" } });
  const received = await theme.refresh();
  expect(received.document.tokens["--sidebar-surface"]).toBe("#112233");
  expect(JSON.parse(await readFile(theme.filePath, "utf8"))).toEqual(received.document);
  await expect(theme.set(saved.document, saved.revision)).rejects.toBeInstanceOf(ThemeConflictError);
  const before = preferences.snapshot();
  expect(() => preferences.putMany([{ key: "theme.mode", value: "light" }, { key: "theme.tokens", value: { "--font-size": "999px" } }])).toThrow();
  expect(preferences.snapshot()).toEqual(before);
});

test("invalid external edits keep last valid values and are backed up before an explicit repair", async () => {
  const { theme, directory } = await fixture();
  const initial = await theme.refresh();
  const saved = await theme.set({ ...DEFAULT_THEME, mode: "light" }, initial.revision);
  await writeFile(theme.filePath, "{ broken edit\n");
  const broken = await theme.refresh();
  expect(broken.document).toEqual(saved.document);
  expect(broken.fileError).toContain("invalid");
  await expect(theme.set(DEFAULT_THEME, saved.revision)).rejects.toBeInstanceOf(ThemeConflictError);
  const repaired = await theme.set(DEFAULT_THEME, broken.revision);
  expect(repaired.fileError).toBeUndefined();
  const backup = (await readdir(directory)).find(name => name.startsWith("theme.invalid-"));
  expect(backup).toBeDefined();
  expect(await readFile(join(directory, backup!), "utf8")).toBe("{ broken edit\n");
  expect((await stat(join(directory, backup!))).mode & 0o777).toBe(0o600);
});

test("managed interrupted writes restore committed values while genuine file edits are adopted", async () => {
  const { theme, store, directory, preferences } = await fixture();
  await theme.refresh();
  const pending = { ...DEFAULT_THEME, mode: "dark" } satisfies ThemeDocument;
  const oldHash = hash(serialize(DEFAULT_THEME)); const pendingHash = hash(serialize(pending));
  for (const actual of [DEFAULT_THEME, pending]) {
    store.writeThemeFileMarker({ currentHash: oldHash, pendingHash });
    await writeFile(theme.filePath, serialize(actual));
    const restarted = new ThemeFile({ dataDirectory: directory, store, preferences, changed() {} });
    const result = await restarted.refresh();
    await restarted.dispose();
    expect(result.document).toEqual(DEFAULT_THEME);
    expect(await readFile(theme.filePath, "utf8")).toBe(serialize(DEFAULT_THEME));
    expect(store.readThemeFileMarker()).toEqual({ currentHash: oldHash });
  }
  await writeFile(theme.filePath, serialize(pending));
  const external = await theme.refresh();
  expect(external.document).toEqual(pending);
  expect(preferences.store.get("theme.mode")).toMatchObject({ value: "dark" });
});

test("theme editing preserves an external symlink target and its mode, and detects replaced target contents", async () => {
  const { theme, directory } = await fixture();
  await theme.refresh(); await unlink(theme.filePath);
  const target = join(directory, "dotfiles-theme.json");
  await writeFile(target, serialize(DEFAULT_THEME)); await chmod(target, 0o640);
  await symlink(target, theme.filePath);
  const before = await theme.refresh();
  const saved = await theme.set({ ...DEFAULT_THEME, material: "sidebar" }, before.revision);
  expect((await lstat(theme.filePath)).isSymbolicLink()).toBe(true);
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(saved.document);
  await writeFile(target, serialize({ ...saved.document, mode: "light" }));
  expect((await theme.refresh()).document.mode).toBe("light");
});

test("the real filesystem watcher adopts valid edits without a UI request", async () => {
  const { theme, preferences } = await fixture();
  await theme.start();
  await writeFile(theme.filePath, serialize({ ...DEFAULT_THEME, mode: "dark" }));
  const deadline = Date.now() + 3000;
  while (preferences.store.get("theme.mode")?.deleted !== false || (preferences.store.get("theme.mode") as { value?: unknown })?.value !== "dark") {
    if (Date.now() > deadline) throw new Error("The file watcher did not adopt the theme edit.");
    await Bun.sleep(25);
  }
  expect(preferences.store.get("theme.mode")).toMatchObject({ value: "dark" });
});
