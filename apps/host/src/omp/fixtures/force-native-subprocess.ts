import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** New environment and HOME: the child cannot discover personal credentials or retained state. */
export async function runForceNativeFixture(file: "force-native-controller.ts" | "force-provider-requests.ts", group?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "force-native-"));
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, file), root, ...(group ? [group] : [])], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, TERM: "dumb", NO_COLOR: "1",
        PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_DISABLE_DOTENV: "1", PI_NO_TITLE: "1",
        AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "force-native-inert-access", AWS_SECRET_ACCESS_KEY: "force-native-inert-secret",
        AWS_EC2_METADATA_DISABLED: "true", PI_TELEMETRY_DISABLED: "1", },
    });
    const timeout = setTimeout(() => child.kill(), 100_000);
    try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(code, 0, `Native fixture ${file}/${group ?? "controller"} failed:\n${stderr}\n${stdout}`);
    const line = stdout.trim().split("\n").at(-1);
    assert.ok(line, "Fixture must return structured assertion evidence");
    const result: unknown = JSON.parse(line);
    assert.ok(result && typeof result === "object" && "evidenceClass" in result && typeof result.evidenceClass === "string");
    return result;
    } finally { clearTimeout(timeout); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
