import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("installed owned CDP transport retains root service across stale child commands", async () => {
  // Load the actual patched module through the existing complete-module harness.
  // Its controlled connection/session boundaries do not launch Chrome or import the SDK.
  const source = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/tools/browser/owned-cdp-transport"));
  const fixture = fileURLToPath(new URL("./acceptance/browser-owned-cdp-transport.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture, source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const result = JSON.parse(stdout);
  expect({ exitCode, stderr, failures: result.failures }).toEqual({ exitCode: 0, stderr: "", failures: [] });
  for (const state of ["detached", "foreign", "replaced"]) {
    expect(result.passed).toContain(`${state} child gets a correlated refusal while the original root remains usable`);
  }
}, 15_000);
