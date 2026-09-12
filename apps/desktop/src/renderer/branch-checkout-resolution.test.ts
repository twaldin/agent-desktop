import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitBranch, GitCheckoutTarget, GitResolvedRevision, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { BranchSearch, type BranchSearchWorkspace } from "./branch-search";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: {
    PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
  } });
  if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trimEnd();
}

test("literal branch survives more than100 case-folded presentation candidates", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-branch-case-bucket-")));
  let search: BranchSearch | undefined;
  try {
    git(cwd, "init", "--initial-branch=main"); git(cwd, "config", "user.name", "Branch Case Fixture");
    git(cwd, "config", "user.email", "branch-case@example.invalid"); git(cwd, "config", "commit.gpgSign", "false");
    git(cwd, "config", "core.hooksPath", "/dev/null");
    await writeFile(join(cwd, "tracked"), "retain\n"); git(cwd, "add", "tracked"); git(cwd, "commit", "-m", "fixture");
    const commit = git(cwd, "rev-parse", "HEAD");
    // Packed refs let real Git represent all case-distinct names even on a
    // case-insensitive fixture filesystem. No mocked branch catalogue/runner.
    const names = Array.from({ length: 256 }, (_, bits) => Array.from({ length: 8 }, (_, bit) => bits & (1 << bit) ? "z" : "Z").join(""));
    await writeFile(join(cwd, ".git/packed-refs"), "# pack-refs with: sorted\n" + names.map(name => `refs/heads/${name}`).sort().map(ref => `${commit} ${ref}\n`).join(""));
    expect(git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n")).toHaveLength(257);
    expect(git(cwd, "rev-parse", "--verify", "refs/heads/zzzzzzzz")).toBe(commit);
    const snapshot = async () => ({
      index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
      head: await readFile(join(cwd, ".git/HEAD"), "utf8"), refs: await readFile(join(cwd, ".git/packed-refs"), "utf8"),
      config: await readFile(join(cwd, ".git/config"), "utf8"), log: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"),
      tracked: await readFile(join(cwd, "tracked"), "utf8"),
    });
    const before = await snapshot(), service = new WorkspaceService(cwd), calls: WorkspaceQuery[] = [];
    const page = await service.searchBranches("zzzzzzzz", 100);
    expect(page.branches).toHaveLength(20); expect(page.limitReached).toBe(true);
    expect(page.branches.some(branch => branch.name === "zzzzzzzz")).toBe(false);
    expect(page.branches.every(branch => branch.name.toLowerCase() === "zzzzzzzz")).toBe(true);
    const workspace: BranchSearchWorkspace = { connected: true, repositoryQueryRevision() { return 0; }, subscribe: () => () => {}, async query(query): Promise<WorkspaceQueryResult> {
      calls.push(query);
      if (query.type === "git.search-branches") return { type: query.type, ...await service.searchBranches(query.query, query.limit) };
      if (query.type === "git.resolve-revision") return { type: query.type, revision: await service.resolveRevision(query.expression) };
      if (query.type === "git.resolve-checkout") return { type: query.type, target: await service.resolveCheckoutTarget(query.expression) };
      throw new Error(`Unexpected branch query ${query.type}`);
    } };
    search = new BranchSearch(workspace);
    async function resolve(expression: string) {
      // Finish the actual debounced presentation read first, separating those
      // calls from the deliberate selection. Both selected versions share this.
      const controller = search!;
      let completed!: () => void; const ready = new Promise<void>(yes => { completed = yes; });
      const unsubscribe = controller.subscribe(() => { if (!controller.getSnapshot().loading) completed(); });
      try { controller.configure(expression, true); await ready; } finally { unsubscribe(); }
      if (controller.getSnapshot().error) throw new Error(controller.getSnapshot().error);
      calls.length = 0;
      // Invocation-only compatibility for a historical selected controller. A
      // normal old GitBranch positive control proves this is not an API-shape RED.
      const old = controller as unknown as { exact(expression: string): Promise<GitBranch | GitResolvedRevision | undefined> };
      const selected: GitCheckoutTarget | GitBranch | GitResolvedRevision | undefined = "resolveCheckout" in controller
        ? await controller.resolveCheckout(expression) : await old.exact(expression);
      if (!selected) return;
      if ("kind" in selected) return selected.kind === "branch" ? { kind: "branch", ...selected.selection } : selected;
      return "ref" in selected ? { kind: "branch", ref: selected.ref, commit: selected.commit } : { kind: "revision", ...selected };
    }
    expect(await resolve("main")).toEqual({ kind: "branch", ref: "refs/heads/main", commit });
    expect(await resolve("zzzzzzzz")).toEqual({ kind: "branch", ref: "refs/heads/zzzzzzzz", commit });
    expect(calls).toEqual([{ type: "git.resolve-checkout", expression: "zzzzzzzz" }]);
    expect(await snapshot()).toEqual(before);
  } finally { search?.configure("", false); await rm(cwd, { recursive: true, force: true }); }
}, 30_000);
