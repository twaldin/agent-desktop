import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
// Apply only to a separate copy of the previously accepted package. Regenerate
// the complete net patch with patches/lsp-inspection/produce.ts afterwards.
const root = process.argv[2]; if (!root) throw new Error("Usage: bun apply-guard.ts AUTHORED_PACKAGE_COPY");
for (const [name, declaration] of [["src/session/agent-session.ts", false], ["dist/types/session/agent-session.d.ts", true]] as const) {
  const file = resolve(root, name); let source = await readFile(file, "utf8");
  const start = source.indexOf(declaration ? "    navigateTree(targetId: string," : "\tasync navigateTree(");
  if (start < 0) throw new Error(`Pinned navigateTree unavailable in ${name}`);
  const prefix = source.slice(0, start); let method = source.slice(start);
  const replace = (before: string, after: string) => { if (!method.includes(before)) throw new Error(`Pinned tree guard context changed in ${name}`); method = method.replace(before, after); };
  const indent = declaration ? "        " : "\t\t\t";
  if (method.slice(0, method.indexOf("customInstructions")).includes("assertCurrent")) throw new Error("Tree guard is already present");
  replace(`${indent}summarize?: boolean;`, `${indent}summarize?: boolean;\n${indent}/** Optional owner/lifetime fence after asynchronous preparation and before history changes. */\n${indent}assertCurrent?: () => void;`);
  if (!declaration) {
    replace("\t\tawait this.#bash.flushPending();", "\t\tawait this.#bash.flushPending();\n\t\toptions.assertCurrent?.();");
    replace("\t\t// Determine the new leaf position based on target type", "\t\t// No await may separate this owner fence from the first history mutation.\n\t\toptions.assertCurrent?.();\n\n\t\t// Determine the new leaf position based on target type");
  }
  source = prefix + method; await writeFile(file, source);
}
