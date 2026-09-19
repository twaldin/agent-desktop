import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

type Member = { path: string; bytes: number; mode: number; sha256: string };
const [pristineArg, baselineArg, authoredArg, outputArg, evidenceArg] = process.argv.slice(2);
if (!pristineArg || !baselineArg || !authoredArg || !outputArg || !evidenceArg) {
  throw new Error("Usage: bun produce.ts PRISTINE BASELINE AUTHORED PATCH EVIDENCE_DIR");
}
const [pristine, baseline, authored, output, evidence] = [pristineArg, baselineArg, authoredArg, outputArg, evidenceArg].map(value => resolve(value));
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const excludedMember = (name: string) => name === "node_modules" || /^\.bun-tag(?:-[a-f0-9]+)?$/.test(name);
async function manifest(root: string): Promise<Member[]> {
  const members: Member[] = [];
  async function visit(relative = "") {
    for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
      if (excludedMember(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(resolve(root, path)), metadata = await stat(resolve(root, path));
        members.push({ path, bytes: bytes.length, mode: metadata.mode & 0o777, sha256: digest(bytes) });
      } else throw new Error(`Unexpected package member kind: ${path}`);
    }
  }
  await visit();
  return members.sort((a, b) => a.path.localeCompare(b.path));
}
await mkdir(evidence, { recursive: true });
const [before, prior, after] = await Promise.all([manifest(pristine), manifest(baseline), manifest(authored)]);
for (const [name, members] of [["published", before], ["baseline", prior], ["authored", after]] as const) {
  await writeFile(resolve(evidence, `${name}-package-manifest.json`), `${JSON.stringify(members, null, 2)}\n`);
}
const stage = resolve(evidence, "net-patch-input");
await mkdir(stage, { recursive: false });
const copyPackage = (source: string, destination: string) => cp(source, destination, { recursive: true, preserveTimestamps: true,
  filter: path => !relative(source, path).split("/").some(excludedMember) });
await Promise.all([copyPackage(pristine, resolve(stage, "before")), copyPackage(authored, resolve(stage, "after"))]);
const command = ["git", "diff", "--no-index", "--no-renames", "--binary", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "before", "after"];
const child = Bun.spawn(command, { cwd: stage, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
await writeFile(resolve(evidence, "net-diff-command.json"), `${JSON.stringify({ command, cwd: stage, exitCode, stderr }, null, 2)}\n`);
if (exitCode !== 1 || stderr) throw new Error(`Net diff did not produce a clean changed package: ${exitCode}`);
let inHeader = false;
let patch = stdout.split("\n").map(line => {
  if (line.startsWith("diff --git ")) inHeader = true;
  else if (line.startsWith("@@ ") || line === "GIT binary patch") inHeader = false;
  return inHeader && /^(diff --git |--- |\+\+\+ )/.test(line)
    ? line.replaceAll("a/before/", "a/").replaceAll("a/after/", "a/")
      .replaceAll("b/before/", "b/").replaceAll("b/after/", "b/") : line;
}).join("\n");
const existing = new Set(before.map(member => member.path));
const modeFixes: string[] = [];
for (const member of after) {
  if (existing.has(member.path) || !member.path.includes("/") || member.mode !== 0o644) continue;
  const header = `diff --git a/${member.path} b/${member.path}\nnew file mode 100644\n`;
  if (!patch.includes(header)) throw new Error(`Missing new-file patch header: ${member.path}`);
  patch = patch.replace(header, header.replace("100644", "100755"));
  modeFixes.push(`diff --git a/${member.path} b/${member.path}\nold mode 100755\nnew mode 100644\n`);
}
patch += modeFixes.join("");
await writeFile(output, patch);
const priorByPath = new Map(prior.map(member => [member.path, member]));
const delta = after.filter(member => {
  const old = priorByPath.get(member.path);
  return !old || old.mode !== member.mode || old.sha256 !== member.sha256;
}).map(member => ({ path: member.path, before: priorByPath.get(member.path) ?? null, after: member }));
const removed = prior.filter(member => !after.some(next => next.path === member.path));
await writeFile(resolve(evidence, "authored-delta.json"), `${JSON.stringify({ changed: delta, removed }, null, 2)}\n`);
await writeFile(resolve(evidence, "patch-production.json"), `${JSON.stringify({ pristine, baseline, authored, output, sha256: digest(patch), bytes: Buffer.byteLength(patch), netChangedFiles: patch.split("diff --git ").length - 1 - modeFixes.length, nestedModeFixes: modeFixes.length, authoredChangedFiles: delta.length, authoredRemovedFiles: removed.length }, null, 2)}\n`);
console.log(JSON.stringify({ patchSha256: digest(patch), authoredChangedFiles: delta.length, modeFixes: modeFixes.length }));
