import { realpath } from "node:fs/promises";
// Bun's top-level installed package may be a symlink. Diff the package bytes,
// not that link, separately for core and coding-agent against their archives.
for (const index of [2, 3, 4]) {
  if (process.argv[index]) process.argv[index] = await realpath(process.argv[index]!);
}
await import("../../lsp-inspection/produce");
