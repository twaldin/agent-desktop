import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { CommandEnvelope, CommandResult, Draft } from "../../packages/shared/src/protocol";

// Real HTTP clients on two physical Macs, addressing the installed Linux host.
const origin = process.argv[2];
if (!origin || !/^http:\/\/100\.\d+\.\d+\.\d+:47827$/.test(origin)) throw new Error("Supply the observed installed host's Tailscale IPv4 origin.");
const runId = crypto.randomUUID();
const directory = resolve(".data/physical-acceptance", runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
function source(envelope: CommandEnvelope) {
  return `const response = await fetch(${JSON.stringify(origin + "/v1/commands")}, { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify(envelope))}, signal: AbortSignal.timeout(20000) }); if (!response.ok) throw new Error("HTTP " + response.status); console.log(JSON.stringify(await response.json()));`;
}
async function send(client: "home" | "work", envelope: CommandEnvelope): Promise<CommandResult> {
  const command = client === "home" ? [process.execPath, "run", "-"] : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "twaldin@twaldin-work", "/opt/homebrew/bin/bun", "run", "-"];
  const child = Bun.spawn(command, { stdin: new Blob([source(envelope)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode) throw new Error(`${client} physical client failed: ${stderr}`);
  return JSON.parse(stdout) as CommandResult;
}
const draft = { id: `acceptance:${runId}`, text: "prepared on home", projectId: null, model: null };
const initial = await send("home", { id: `${runId}-prepare`, command: { type: "draft.put", draft, expectedRevision: 0 } });
if (!initial.ok || !(initial.value && "revision" in initial.value)) throw new Error("Draft preparation failed.");
const revision = initial.value.revision;
const edits = await Promise.all([send("home", { id: `${runId}-home`, command: { type: "draft.put", draft: { ...draft, text: "home concurrent edit" }, expectedRevision: revision } }),
  send("work", { id: `${runId}-work`, command: { type: "draft.put", draft: { ...draft, text: "work concurrent edit" }, expectedRevision: revision } })]);
if (edits.filter(result => result.ok).length !== 1 || edits.filter(result => !result.ok && result.error.code === "DRAFT_CONFLICT").length !== 1) {
  throw new Error("Physical draft race did not preserve one winner and one conflict.");
}
const winner = edits.find(result => result.ok) as Extract<CommandResult, { ok: true }>;
const latest = winner.value as Draft;
const retry: CommandEnvelope = { id: `${runId}-same-command`, command: { type: "draft.put", draft: { ...draft, text: "same command from both Macs" }, expectedRevision: latest.revision } };
const retried = await Promise.all([send("home", retry), send("work", retry)]);
if (!retried[0]!.ok || JSON.stringify(retried[0]) !== JSON.stringify(retried[1])) throw new Error("Cross-device retry did not return the same durable result.");
const browserAttempt = await fetch(origin + "/v1/state", { headers: { Origin: "https://example.invalid" }, signal: AbortSignal.timeout(10000) });
if (browserAttempt.status !== 401) throw new Error("Remote browser Origin was not rejected.");
const evidence = { passed: true, checkedAt: new Date().toISOString(), clients: ["twaldin-home", "twaldin-work"], origin,
  runId, draftId: draft.id, edits, retried, browserOriginStatus: browserAttempt.status,
  scope: "Real physical HTTP command/draft transport; not a desktop interaction or provider-login test." };
await writeFile(join(directory, "result.json"), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: true, runId, evidence: join(directory, "result.json") }, null, 2));
