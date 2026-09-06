import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2]!;
const nativePackage = process.env.BROWSER_CREATE_NATIVE_PACKAGE;
assert(nativePackage);
await Promise.all(["agent", "project", "sessions"].map(name =>
	mkdir(path.join(root, name), { recursive: true, mode: 0o700 }),
));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
await writeFile(path.join(agentDir, "config.yml"), [
	"browser:",
	"  enabled: true",
	"  headless: true",
	"  cmux: false",
	"  relay: false",
	"retry:",
	"  enabled: false",
	"",
].join("\n"));

const native = await import(pathToFileURL(path.join(nativePackage, "src/index.ts")).href);
const browserModule = await import(pathToFileURL(path.join(nativePackage, "src/tools/browser.ts")).href);
const supervisor = await import(pathToFileURL(path.join(nativePackage, "src/tools/browser/tab-supervisor.ts")).href);
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } =
	native as typeof import("@oh-my-pi/pi-coding-agent");
const { createBrowserTabForSession } = browserModule as typeof import("@oh-my-pi/pi-coding-agent/tools/browser") & {
	createBrowserTabForSession(session: Awaited<ReturnType<typeof createAgentSession>>["session"], request: { name: string }): Promise<{
		created: true;
		name: string;
		ownerSessionId: string;
		targetId: string;
		backend: string;
		kindTag: string;
		targetDisposition: string;
		url: string;
		title: string;
		viewport: { width: number; height: number; deviceScaleFactor?: number };
	}>;
};
const { getTab, listTabsForOwner, releaseAllTabs } = supervisor as typeof import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor");

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let failure: unknown;
const checks: string[] = [];
try {
	const auth = await discoverAuthStorage(agentDir);
	const settings = await Settings.loadReadOnly({ cwd, agentDir });
	const manager = SessionManager.create(cwd, path.join(root, "sessions"));
	await manager.ensureOnDisk();
	const created = await createAgentSession({
		cwd,
		agentDir,
		settings,
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings }),
		sessionManager: manager,
		agentRegistry: new AgentRegistry(),
		toolNames: ["eval"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		hasUI: false,
	});
	session = created.session;
	const ownerSessionId = manager.getSessionId();
	const branchBefore = structuredClone(manager.getBranch());
	const events: unknown[] = [];
	const unsubscribe = session.subscribe(event => events.push(event));

	const result = await createBrowserTabForSession(session, { name: "human-create-proof" });
	assert.equal(result.created, true);
	assert.equal(result.ownerSessionId, ownerSessionId);
	assert.equal(result.backend, "worker");
	assert.equal(result.kindTag, "headless");
	assert.equal(result.targetDisposition, "created-page");
	assert.equal(result.url, "about:blank");
	assert(result.targetId);
	assert(result.viewport.width > 0 && result.viewport.height > 0);
	const listed = listTabsForOwner(ownerSessionId);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.targetId, result.targetId);
	assert.equal(getTab(result.name)?.ownerSessionId, ownerSessionId);
	assert.deepEqual(manager.getBranch(), branchBefore);
	assert(events.every(event => (event as { type?: string }).type === "advisor_cost_changed"));
	checks.push("real AgentSession settings create an owner-bound headless page without transcript or agent/tool events");

	await assert.rejects(
		createBrowserTabForSession(session, { name: result.name }),
		error => (error as Error).name === "BrowserTabCreateRejected" && /already exists/.test((error as Error).message),
	);
	assert.equal(getTab(result.name)?.targetId, result.targetId);
	checks.push("duplicate create rejects definitely and preserves the original native target");

	const race = await Promise.allSettled([
		createBrowserTabForSession(session, { name: "atomic-create-proof" }),
		createBrowserTabForSession(session, { name: "atomic-create-proof" }),
	]);
	assert.equal(race.filter(entry => entry.status === "fulfilled").length, 1);
	const rejected = race.find(entry => entry.status === "rejected");
	assert(rejected?.status === "rejected");
	assert.equal((rejected.reason as Error).name, "BrowserTabCreateRejected");
	assert.equal(listTabsForOwner(ownerSessionId).filter(tab => tab.name === "atomic-create-proof").length, 1);
	checks.push("concurrent same-name creates admit exactly one managed native tab");

	settings.override("browser.enabled", false);
	await assert.rejects(
		createBrowserTabForSession(session, { name: "disabled-proof" }),
		error => (error as Error).name === "BrowserTabCreateRejected" && /disabled/.test((error as Error).message),
	);
	assert.equal(getTab("disabled-proof"), undefined);
	settings.override("browser.enabled", true);
	checks.push("the direct seam reads live AgentSession browser enablement and rejects before acquisition");

	const evalTool = session.getToolByName("eval");
	assert(evalTool);
	const legacy = await evalTool.execute(crypto.randomUUID(), {
		language: "js",
		title: "Legacy browser reuse proof",
		code: `await browser.open({name:${JSON.stringify(result.name)},timeout:30});`,
		timeout: 30,
	});
	assert.notEqual(legacy.isError, true);
	assert.equal(getTab(result.name)?.targetId, result.targetId);
	checks.push("the existing agent browser.open operation still reuses an existing tab");

	unsubscribe();
	await session.dispose();
	session = undefined;
	assert.equal(listTabsForOwner(ownerSessionId).length, 0);
	assert.equal(getTab(result.name), undefined);
	checks.push("native AgentSession disposal closes every tab created for its owner");
} catch (error) {
	failure = error;
} finally {
	await session?.dispose().catch(error => { failure ??= error; });
	await releaseAllTabs({ kill: true }).catch(error => { failure ??= error; });
	await writeFile(path.join(root, "result.json"), JSON.stringify({
		passed: failure === undefined,
		checks,
		scope: "Copied pinned OMP candidate, disposable AgentSession, and isolated headless profile only; no provider or existing browser profile.",
	}, null, 2));
}
if (failure) throw failure;
