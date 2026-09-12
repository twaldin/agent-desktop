import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("account HTTP uses native storage, resolves callbacks once and never journals secrets", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-account-http-")));
  const child = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(new URL("./fixtures/accounts-http.ts", import.meta.url))],
    env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", CONTRACT_DIRECTORY: directory,
      PI_CODING_AGENT_DIR: join(directory, "native") }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`Isolated HTTP account contract failed: ${await errors}`);
    expect(await output).toContain("native account HTTP and secret-isolation contracts passed");
  } finally {
    clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 50_000);


test("account selection requests keep the exact owner token and reject malformed tokens", async () => {
  const { parseAccountAction } = await import("./accounts-http");
  const expectedSelection = { model: { provider: "openai", id: "gpt-4o" }, revision: "original-worker-model-revision" };
  for (const type of ["session.pin", "session.release"] as const) {
    const action = type === "session.pin" ? { type, sessionId: "original-session", credentialId: 4, expectedSelection } : { type, sessionId: "original-session", expectedSelection };
    const parsed = parseAccountAction(action);
    expect(parsed).toEqual(action);
    expectedSelection.model.id = "changed-model";
    expect("expectedSelection" in parsed && parsed.expectedSelection?.model.id).toBe("gpt-4o");
    expectedSelection.model.id = "gpt-4o";
    for (const malformed of [null, [], { ...expectedSelection, revision: "" }, { ...expectedSelection, extra: true }, { ...expectedSelection, model: { ...expectedSelection.model, extra: true } }]) {
      expect(() => parseAccountAction({ ...action, expectedSelection: malformed })).toThrow();
    }
    expect(parseAccountAction({ ...action, expectedSelection: undefined })).not.toHaveProperty("expectedSelection");
  }
});
