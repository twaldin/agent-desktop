import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSessionExport, sessionExportStatus } from "./session-export";
import type { SessionExportReceipt } from "@agent-desktop/shared";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "export-download-")), bytes = Buffer.from("<!DOCTYPE html><title>Actual downloaded HTML</title>");
  const receipt: SessionExportReceipt = { type: "session.export", hostId: "owner", sessionId: "session", commandId: "command", artifactId: "a".repeat(64), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, theme: "web" };
  let wrongOwner = false, changed = false, calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls++; expect(request.headers.get("Authorization")).toBe("Bearer controlled-export-token"); expect(request.headers.get("X-Agent-Host-Id")).toBe("owner");
    const headers = { "X-Agent-Host-Id": wrongOwner ? "foreign" : "owner" };
    return new URL(request.url).pathname.endsWith("/file") ? new Response(changed ? "tampered" : bytes, { headers }) : Response.json({ hostId: "owner", sessionId: "session", commandId: "command", state: "complete", receipt }, { headers });
  } });
  cleanup.push(async () => { server.stop(true); await rm(root, { recursive: true, force: true }); });
  return { root, bytes, receipt, endpoint: { origin: server.url.origin, hostId: "owner", token: "controlled-export-token" }, get calls() { return calls; }, wrongOwner() { wrongOwner = true; }, change() { changed = true; } };
}
test("native Save as transaction downloads exact owner-bound bytes and writes chosen client destination", async () => {
  const f = await fixture(), destination = join(f.root, "chosen.html");
  expect((await sessionExportStatus(f.endpoint, "session", "command")).receipt).toEqual(f.receipt);
  await writeFile(destination, "replace only after verification");
  expect(await saveSessionExport(f.receipt, { endpoint: async () => f.endpoint, choose: async () => destination, current() {} })).toEqual({ path: destination });
  expect(await readFile(destination)).toEqual(f.bytes);
});
test("cancel never fetches and tampered or wrong-owner downloads preserve existing destination", async () => {
  const f = await fixture(), destination = join(f.root, "chosen.html"); await writeFile(destination, "original");
  expect(await saveSessionExport(f.receipt, { endpoint: async () => f.endpoint, choose: async () => null, current() {} })).toEqual({ path: null }); expect(f.calls).toBe(0);
  f.change(); await expect(saveSessionExport(f.receipt, { endpoint: async () => f.endpoint, choose: async () => destination, current() {} })).rejects.toThrow("does not match");
  expect(await readFile(destination, "utf8")).toBe("original");
  f.wrongOwner(); await expect(sessionExportStatus(f.endpoint, "session", "command")).rejects.toThrow("original host");
});
