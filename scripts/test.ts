import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const roots = ["apps", "packages", "scripts"];
const excludedDirectories = new Set(["node_modules", "fixtures", "__fixtures__", "private"]);
const entries = new Bun.Glob("*");

/** Enumerate owned suites without asking Bun's test runner to search the repository. */
export async function discoverTestFiles(root = repository): Promise<string[]> {
  const pending = roots.map(name => join(root, name));
  const tests: string[] = [];
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]!;
    // One level at a time lets us prune fixture/private/dependency directories
    // before entering them, rather than filtering a recursive scan afterwards.
    for await (const name of entries.scan({ cwd: directory, onlyFiles: false, followSymlinks: false, dot: false })) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!excludedDirectories.has(name)) pending.push(path);
      } else if (info.isFile() && /\.test\.tsx?$/.test(name)) tests.push(relative(root, path).split(sep).join("/"));
    }
  }
  return tests.sort();
}

const booleanFlags = new Set(["--no-orphans", "-u", "--update-snapshots", "--todo", "--only", "--pass-with-no-tests",
  "--concurrent", "--randomize", "--coverage", "--dots", "--only-failures", "--isolate", "--help"]);
const valueFlags = new Set(["--timeout", "--rerun-each", "--retry", "--seed", "--coverage-reporter", "--coverage-dir",
  "-t", "--test-name-pattern", "--reporter", "--reporter-outfile", "--max-concurrency", "--path-ignore-patterns",
  "--parallel-delay", "--shard"]);
const optionalValueFlags = new Set(["--bail", "--changed", "--parallel"]);

/** Keep bare positional patterns from accidentally re-enabling test discovery. */
export function validateTestFlags(flags: string[]): string[] {
  for (let index = 0; index < flags.length; index++) {
    const raw = flags[index]!, equal = raw.indexOf("=");
    const flag = equal < 0 ? raw : raw.slice(0, equal);
    if (equal >= 0) {
      if ((!valueFlags.has(flag) && !optionalValueFlags.has(flag)) || equal === raw.length - 1) throw new Error(`Unsupported test option: ${raw}`);
    } else if (valueFlags.has(flag)) {
      const value = flags[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value; use ${flag}=VALUE for values beginning with --.`);
    } else if (!booleanFlags.has(flag) && !optionalValueFlags.has(flag)) {
      throw new Error(`Unsupported test option or filename filter: ${raw}. Select exact test files before --; pass Bun flags after it.`);
    }
  }
  return [...flags];
}

export function selectTestFiles(available: string[], requested: string[], root = repository): string[] {
  if (!requested.length) return [...available];
  const allowed = new Set(available), selected = new Set<string>();
  for (const input of requested) {
    const path = relative(root, isAbsolute(input) ? input : resolve(root, input)).split(sep).join("/");
    if (!allowed.has(path)) throw new Error(`Not an owned test file: ${input}. Use --list to see exact paths; filename filters are not supported.`);
    if (selected.has(path)) throw new Error(`Test file selected more than once: ${input}`);
    selected.add(path);
  }
  return [...selected].sort();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: bun run test [exact/test.test.ts ...] -- [Bun test flags]\n       bun run test --list\nNo file selection runs every owned .test.ts and .test.tsx suite.");
    return 0;
  }
  const available = await discoverTestFiles();
  if (args.length === 1 && args[0] === "--list") { console.log(available.join("\n")); return 0; }
  // `bun run test -- -t NAME` strips its leading separator before invoking this
  // script. Accept the first flag as the boundary too, preserving normal usage.
  const separator = args.findIndex(arg => arg.startsWith("-"));
  const files = selectTestFiles(available, separator < 0 ? args : args.slice(0, separator));
  const flags = validateTestFlags(separator < 0 ? [] : args.slice(separator + (args[separator] === "--" ? 1 : 0)));
  if (!files.length) throw new Error("No owned test files found; refusing to fall back to Bun test discovery.");
  // Every path is explicitly rooted. In particular, never pass an unprefixed
  // filename that Bun would interpret as a repository-search filter.
  const child = Bun.spawn([process.execPath, "test", ...files.map(file => join(repository, file)), ...flags], {
    cwd: repository, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null) child.kill(signal); };
  const interrupt = () => forward("SIGINT"), terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try { return await child.exited; }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}

if (import.meta.main) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
