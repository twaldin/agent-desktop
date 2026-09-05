import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThemeDocument, ThemeState } from "../../packages/shared/src/theme";

// Explicit physical acceptance. Temporarily changes the shared theme and restores
// its exact baseline; never runs as part of the routine test command.
const directory = resolve(".data/physical-theme-acceptance", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(directory, { recursive: true, mode: 0o700 });
const hosts = [
  { name: "home", command: [process.execPath, "run", "-"], data: resolve(process.argv[2] ?? ".data/dev") },
  { name: "work", command: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "twaldin@twaldin-work", "/opt/homebrew/bin/bun", "run", "-"], data: "/Users/twaldin/Library/Application Support/Agent Desktop" },
  { name: "deckbox", command: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "tim@deckbox", "/home/tim/.bun/bin/bun", "run", "-"], data: "/home/tim/.local/share/agent-desktop" },
] as const;
type Observation = { hostId: string; theme: ThemeState; image?: { status: number; sha256?: string; bytes?: number } };
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), scope: "Installed host theme/preference/image transfer over existing authenticated Tailscale peers; SSH reads each host's loopback state but does not copy preference records or image bytes between hosts. One-pixel PNG is a byte-transfer fixture, not visual parity evidence.", hosts: hosts.map(({ name }) => name) };
const record = () => Bun.write(join(directory, "result.json"), JSON.stringify(evidence, null, 2));
async function call<T>(host: typeof hosts[number], operation: string): Promise<T> {
  const source = `
    const locator = await Bun.file(${JSON.stringify(join(host.data, "connection.json"))}).json();
    async function request(path, body, binary = false) {
      const response = await fetch(locator.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + locator.token, ...(!binary ? {'Content-Type':'application/json'} : {}) }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Host endpoint returned HTTP ' + response.status);
      return response.json();
    }
    ${operation}
  `;
  const child = Bun.spawn([...host.command], { stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`${host.name}: ${stderr.trim().slice(-1000)}`);
  return JSON.parse(stdout);
}
async function observe(sha256?: string): Promise<Observation[]> {
  return Promise.all(hosts.map(host => call<Observation>(host, `
    const theme = await request('/v1/theme');
    let image;
    const sha256 = ${JSON.stringify(sha256 ?? null)};
    if (sha256) {
      const response = await fetch(locator.origin + '/v1/theme/assets/' + sha256, { headers: { Authorization:'Bearer ' + locator.token }, signal:AbortSignal.timeout(10000) });
      const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
      image = {status:response.status, ...(bytes ? {bytes:bytes.length, sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')} : {})};
    }
    console.log(JSON.stringify({hostId:locator.hostId, theme, image}));
  `)));
}
function equal(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}
async function converge(document: ThemeDocument, sha256?: string): Promise<Observation[]> {
  const deadline = Date.now() + 60_000;
  do {
    const observed = await observe(sha256);
    if (observed.every(item => !item.theme.fileError && equal(item.theme.document, document) && (!sha256 || item.image?.sha256 === sha256))) return observed;
    if (Date.now() >= deadline) { evidence.lastObservation = observed; throw new Error("Installed hosts did not converge before the acceptance deadline."); }
    await Bun.sleep(1000);
  } while (true);
}
const initial = await observe(); evidence.initial = initial; await record();
const baseline = initial[0]!.theme.document;
if (initial.some(item => item.theme.fileError || !equal(item.theme.document, baseline))) throw new Error("Hosts must have the same valid theme before this reversible acceptance check.");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iSgAAAABJRU5ErkJggg==", "base64");
const digest = new Bun.CryptoHasher("sha256").update(png).digest("hex");
const temporary: ThemeDocument = { ...baseline, tokens: { ...baseline.tokens, "--accent": "#7c91e8" }, background: { kind: "asset", sha256: digest, fit: "tile", opacity: 0.04, blur: 0 } };
let changed = false;
try {
  const asset = await call<{ sha256: string; bytes: number }>(hosts[0], `console.log(JSON.stringify(await request('/v1/theme/assets', Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64'), true)));`);
  if (asset.sha256 !== digest || asset.bytes !== png.length) throw new Error("Uploaded image bytes did not match.");
  evidence.asset = asset;
  // A lost response can follow a successful save; inspect/restore in either case.
  changed = true;
  await call(hosts[0], `console.log(JSON.stringify(await request('/v1/theme', ${JSON.stringify({ document: temporary, expectedRevision: initial[0]!.theme.revision })})));`);
  evidence.changedAt = new Date().toISOString(); await record();
  console.log(JSON.stringify({ phase: "temporary-theme-saved", evidence: directory }));
  evidence.synchronized = await converge(temporary, digest);
  evidence.synchronizedAt = new Date().toISOString();
  console.log(JSON.stringify({ phase: "three-host-theme-and-image-verified" }));
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error); throw error;
} finally {
  try { if (changed) {
    // Restore from work to exercise synchronization in the opposite direction.
    const latest = await observe();
    if (latest.some(item => item.theme.fileError || (!equal(item.theme.document, temporary) && !equal(item.theme.document, baseline)))) {
      evidence.restored = false; evidence.restoreError = "An unrelated theme edit appeared; automatic restoration stopped to preserve it.";
      throw new Error(String(evidence.restoreError));
    }
    await call(hosts[1], `console.log(JSON.stringify(await request('/v1/theme', ${JSON.stringify({ document: baseline, expectedRevision: latest[1]!.theme.revision })})));`);
    evidence.restoration = await converge(baseline);
    evidence.restored = true;
  } } catch (error) {
    evidence.restored = false; evidence.restoreError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
  evidence.finishedAt = new Date().toISOString(); evidence.passed = changed && !evidence.error && evidence.restored === true;
  await record();
  console.log(JSON.stringify({ passed: evidence.passed, restored: evidence.restored, evidence: join(directory, "result.json") }));
  }
}
