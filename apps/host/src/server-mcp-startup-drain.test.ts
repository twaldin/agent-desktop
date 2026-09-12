import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLease } from "./lease";
import { McpOwnerHttp } from "./mcp-owner-http";
import { startHost } from "./server";

test("failed startup joins MCP owner cleanup before releasing its host lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-startup-drain-"));
  const options = { dataDirectory: join(root, "data"), agentDirectory: join(root, "agent"), discoveryDirectory: join(root, "project") };
  await Promise.all(Object.values(options).map(path => mkdir(path, { recursive: true })));
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalDispose = McpOwnerHttp.prototype.dispose;
  const disposal = spyOn(McpOwnerHttp.prototype, "dispose").mockImplementation(function (this: McpOwnerHttp) {
    const original = originalDispose.call(this);
    entered.resolve();
    return original.then(() => release.promise);
  });
  let startup: Promise<unknown> | undefined;
  try {
    let settled = false;
    startup = startHost({ ...options, port: occupied.port! }).then(async host => {
      await host.stop();
      throw new Error("The occupied port unexpectedly admitted a second host.");
    }, error => { settled = true; return error; });
    const first = await Promise.race([entered.promise.then(() => "draining"), startup.then(() => "rejected")]);
    const settledBeforeRelease = settled;
    let leaseFailure: unknown;
    try { acquireHostLease(options.dataDirectory).release(); }
    catch (error) { leaseFailure = error; }
    release.resolve();
    const failure = await startup;
    expect(first).toBe("draining");
    expect(settledBeforeRelease).toBe(false);
    expect(leaseFailure).toBeInstanceOf(Error);
    expect((leaseFailure as Error).message).toContain("already owns this data directory");
    expect(failure).toBeInstanceOf(Error);
    const releasedLease = acquireHostLease(options.dataDirectory);
    releasedLease.release();
  } finally {
    release.resolve();
    await startup?.catch(() => {});
    disposal.mockRestore();
    occupied.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
