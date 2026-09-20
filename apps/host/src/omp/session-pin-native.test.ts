import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Native assertions live in the isolated fixture. Durable results avoid stdout
// size/truncation assumptions and preserve the raw primary failure before drain.
for (const scenario of ["selection", "boundaries", "shadows"] as const) {
  test(`native session pin: ${scenario}`, async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "native-pin-")));
    const evidence = process.env.SESSION_PIN_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(path.join(evidence, `${scenario}-${path.basename(directory)}.json`), JSON.stringify({ scenario, directory }) + "\n");
    }
    let passed = false;
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./fixtures/session-pin-native.ts", import.meta.url)), directory, scenario], {
        env: { HOME: directory, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") },
        stdout: "pipe", stderr: "pipe",
      });
      // A watchdog for a real child/IPC deadlock, not a sleep used to synchronize assertions.
      const deadline = setTimeout(() => child.kill("SIGTERM"), 150_000);
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        .finally(() => clearTimeout(deadline));
      await writeFile(path.join(directory, "process-output.json"), JSON.stringify({ exit, stdout, stderr }, null, 2) + "\n");
      let durable: string;
      try { durable = await readFile(path.join(directory, "result.json"), "utf8"); }
      catch (error) { throw new Error(`Native pin fixture left no durable result at ${directory}; exit=${exit}; ${stderr || stdout}`, { cause: error }); }
      if (exit !== 0) throw new Error(`Native pin fixture failed at ${directory}\n${durable}\n${stderr}`);
      const result = JSON.parse(durable);
      expect(result.ok).toBe(true);
      if (scenario === "selection") {
        expect(result.persistence.accountSequence).toEqual(["pin-alpha", "pin-beta", "pin-beta"]);
      } else if (scenario === "boundaries") {
        expect(result.receipts.output[0].code).toBe("OUTCOME_UNKNOWN");
        expect(result.receipts.flush[0].code).toBe("OUTCOME_UNKNOWN");
        expect(result.receipts.read.handledCommand).toBe("session");
        expect(result.receipts.read.agentInvoked).toBe(false);
      } else {
        expect(result.effects.map((effect: { kind: string }) => effect.kind)).toEqual(["extension", "custom"]);
      }
      passed = true;
    } finally {
      // The fixture's process exits only after its runtime and provider drain.
      // Retain failed evidence instead of replacing the primary error with cleanup.
      if (passed && !evidence) await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
}
