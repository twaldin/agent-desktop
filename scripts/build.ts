import { buildModifierRelease } from "./build-modifier-release";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outdir = join(root, "apps/desktop/dist");
await mkdir(outdir, { recursive: true });
for (const name of ["main", "preload"]) {
  const result = await Bun.build({
    entrypoints: [join(root, `apps/desktop/src/main/${name}.ts`)],
    outdir, target: "node", format: "cjs", naming: `${name}.cjs`, external: ["electron"], sourcemap: "linked",
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}.`);
}
if (!process.argv.includes("--main-only")) {
  const build = Bun.spawn([process.execPath, "--bun", "vite", "build", "--config", "apps/desktop/vite.config.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await build.exited) throw new Error("Renderer build failed.");
}

buildModifierRelease(root, join(outdir, "native"));
