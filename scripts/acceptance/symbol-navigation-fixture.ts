import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const symbolAcceptanceFiles: Record<string, string> = {
  "symbol-source.ts": 'import { first, second } from "./symbol-target.js";\nfirst();\nsecond();\ninterface Merged { first: number }\ninterface Merged { second: number }\nlet item: Merged;\nconst quoted = "first"; // first\n',
  "symbol-target.ts": 'export function first() { return 1; }\nexport function second() { return 2; }\n',
  "unsupported.py": "def first():\n    return 1\nfirst()\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { noLib: true, module: "nodenext", moduleResolution: "nodenext", noEmit: true }, include: ["*.ts"] }, null, 2) + "\n",
};
/** Seed only an empty, explicitly supplied directory. No Git identity, sessions or providers. */
export async function createSymbolNavigationFixture(directory: string) {
  const root = resolve(directory); await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await readdir(root)).length) throw new Error("Symbol acceptance needs an empty disposable directory.");
  for (const [name, text] of Object.entries(symbolAcceptanceFiles)) await writeFile(join(root, name), text, { mode: 0o600, flag: "wx" });
  return root;
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: bun scripts/acceptance/symbol-navigation-fixture.ts /absolute/empty/disposable/workspace");
  console.log(await createSymbolNavigationFixture(process.argv[2]));
}
