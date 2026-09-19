import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { YAML } from "bun";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "reset-settings-observation-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(agentDir, "config.yml"), "codexResets:\n  autoRedeem: no\n  minBlockedMinutes: 60\n  keepCredits: 2\n  salvageHorizonHours: 12\n");
	return { root, agentDir, cwd, config: join(agentDir, "config.yml") };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("reset-policy Settings observation", () => {
	test("rejects a set cycle even when the effective value returns to its capture", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const observation = settings.captureResetPolicySettingsObservation();

		settings.set("codexResets.autoRedeem", "yes");
		settings.set("codexResets.autoRedeem", "no");

		expect(settings.get("codexResets.autoRedeem")).toBe("no");
		expect(() => observation.assertCurrent()).toThrow("Settings observation changed");
	});

	test("observes override and clear operations hidden from effective-change listeners", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({
			agentDir: f.agentDir,
			cwd: f.cwd,
			overrides: { "codexResets.autoRedeem": "no" },
		});
		const changes: unknown[] = [];
		settings.onEffectiveChange((...args) => changes.push(args));

		const sameEffective = settings.captureResetPolicySettingsObservation();
		settings.override("codexResets.autoRedeem", "no");
		expect(changes).toHaveLength(0);
		expect(() => sameEffective.assertCurrent()).toThrow("Settings observation changed");

		const cleared = settings.captureResetPolicySettingsObservation();
		settings.clearOverride("codexResets.autoRedeem");
		settings.override("codexResets.autoRedeem", "no");
		expect(() => cleared.assertCurrent()).toThrow("Settings observation changed");

		const missing = settings.captureResetPolicySettingsObservation();
		settings.clearOverride("codexResets.keepCredits");
		expect(() => missing.assertCurrent()).toThrow("Settings observation changed");
	});

	test("adopts only one exact native auto-redeem set and rejects fake or extra operations", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const missing = settings.captureResetPolicySettingsObservation();
		expect(() => missing.adoptNativeAutoRedeemSet("yes")).toThrow("expected native auto-redeem set");

		const exact = settings.captureResetPolicySettingsObservation();
		settings.set("codexResets.autoRedeem", "yes");
		exact.adoptNativeAutoRedeemSet("yes");
		expect(() => exact.assertCurrent()).not.toThrow();
		expect(() => exact.adoptNativeAutoRedeemSet("yes")).toThrow("already adopted");

		const wrongPath = settings.captureResetPolicySettingsObservation();
		settings.set("codexResets.keepCredits", 4);
		expect(() => wrongPath.adoptNativeAutoRedeemSet("yes")).toThrow("expected native auto-redeem set");

		const extra = settings.captureResetPolicySettingsObservation();
		settings.set("codexResets.autoRedeem", "no");
		settings.set("colorBlindMode", true);
		expect(() => extra.adoptNativeAutoRedeemSet("no")).toThrow("expected native auto-redeem set");
	});

	test("adopts a legitimate same-global-value set under an effective shadow", async () => {
		const f = await fixture();
		await writeFile(f.config, "codexResets:\n  autoRedeem: yes\n  minBlockedMinutes: 60\n  keepCredits: 2\n  salvageHorizonHours: 12\n");
		const settings = await Settings.loadReadOnly({
			agentDir: f.agentDir,
			cwd: f.cwd,
			overrides: { "codexResets.autoRedeem": "no" },
		});
		const changes: unknown[] = [];
		settings.onEffectiveChange((...args) => changes.push(args));
		const observation = settings.captureResetPolicySettingsObservation();

		settings.set("codexResets.autoRedeem", "yes");
		observation.adoptNativeAutoRedeemSet("yes");

		expect(settings.get("codexResets.autoRedeem")).toBe("no");
		expect(changes).toHaveLength(0);
		expect(() => observation.assertCurrent()).not.toThrow();
	});

	test("fences captures before and during a held persisted reload", async () => {
		const f = await fixture();
		const settings = await Settings.loadIsolated({ agentDir: f.agentDir, cwd: f.cwd });
		const before = settings.captureResetPolicySettingsObservation();
		await writeFile(f.config, "codexResets:\n  autoRedeem: yes\n  minBlockedMinutes: 60\n  keepCredits: 2\n  salvageHorizonHours: 12\n");
		const entered = deferred();
		const release = deferred();
		const realReadFile = fs.promises.readFile.bind(fs.promises);
		let held = false;
		const read = spyOn(fs.promises, "readFile").mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
			if (!held && String(args[0]) === f.config) {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return realReadFile(...args);
		});
		try {
			const reloading = settings.reloadFromDisk();
			await entered.promise;
			expect(() => before.assertCurrent()).toThrow("reload is in progress");
			expect(() => before.adoptNativeAutoRedeemSet("yes")).toThrow("reload is in progress");
			expect(() => settings.captureResetPolicySettingsObservation()).toThrow("reload is in progress");
			release.resolve();
			await reloading;
			expect(settings.get("codexResets.autoRedeem")).toBe("yes");
			expect(() => before.assertCurrent()).toThrow("Settings observation changed");
			expect(() => settings.captureResetPolicySettingsObservation().assertCurrent()).not.toThrow();
		} finally {
			read.mockRestore();
			settings.cancelPendingSaves();
		}
	});

	test("fences capture and use throughout a cwd reload held in flush", async () => {
		const f = await fixture();
		const other = join(f.root, "other-held");
		await mkdir(other);
		const settings = await Settings.loadIsolated({ agentDir: f.agentDir, cwd: f.cwd });
		settings.set("colorBlindMode", true);
		const before = settings.captureResetPolicySettingsObservation();
		const locked = deferred();
		const release = deferred();
		const blocker = withFileLock(f.config, async () => {
			locked.resolve();
			await release.promise;
		});
		await locked.promise;

		const reloading = settings.reloadForCwd(other);
		expect(() => before.assertCurrent()).toThrow("reload is in progress");
		expect(() => before.adoptNativeAutoRedeemSet("yes")).toThrow("reload is in progress");
		expect(() => settings.captureResetPolicySettingsObservation()).toThrow("reload is in progress");
		release.resolve();
		await blocker;
		await reloading;
		expect(settings.getCwd()).toBe(other);
		expect(() => before.assertCurrent()).toThrow("Settings observation changed");
		expect(() => settings.captureResetPolicySettingsObservation().assertCurrent()).not.toThrow();
		settings.cancelPendingSaves();
	});

	test("rejects cwd A-to-B-to-A even when values and final scope compare equal", async () => {
		const f = await fixture();
		const other = join(f.root, "other");
		await mkdir(other);
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const observation = settings.captureResetPolicySettingsObservation();
		await settings.reloadForCwd(other);
		await settings.reloadForCwd(f.cwd);
		expect(settings.getCwd()).toBe(f.cwd);
		expect(() => observation.assertCurrent()).toThrow("Settings observation changed");
	});

	test("observes an external reset edit merged into live global state during save", async () => {
		const f = await fixture();
		const settings = await Settings.loadIsolated({ agentDir: f.agentDir, cwd: f.cwd });
		settings.set("colorBlindMode", true);
		const observation = settings.captureResetPolicySettingsObservation();
		await writeFile(f.config, "theme: custom\ncodexResets:\n  autoRedeem: no\n  minBlockedMinutes: 60\n  keepCredits: 7\n  salvageHorizonHours: 12\n");
		await settings.flush();
		expect(settings.get("codexResets.keepCredits")).toBe(7);
		expect(() => observation.assertCurrent()).toThrow("Settings observation changed");
		settings.cancelPendingSaves();
	});

	test("observes writer binding and disposal without exposing token metadata", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const beforeEnable = settings.captureResetPolicySettingsObservation();
		await settings.enableResetPolicyPersistence();
		expect(() => beforeEnable.assertCurrent()).toThrow("Settings observation changed");

		const beforeDisable = settings.captureResetPolicySettingsObservation();
		settings.disableResetPolicyPersistence();
		expect(() => beforeDisable.assertCurrent()).toThrow("Settings observation changed");
		expect(Object.keys(beforeDisable).sort()).toEqual(["adoptNativeAutoRedeemSet", "assertCurrent", "dispose"]);
	});

	test("allows only one concurrent pass to adopt one native set", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const first = settings.captureResetPolicySettingsObservation();
		const second = settings.captureResetPolicySettingsObservation();
		settings.set("codexResets.autoRedeem", "yes");
		first.adoptNativeAutoRedeemSet("yes");
		expect(() => second.adoptNativeAutoRedeemSet("yes")).toThrow("expected native auto-redeem set");
		expect(() => first.assertCurrent()).not.toThrow();
	});

	test("keeps root and child instance histories separate while sharing a writer target", async () => {
		const f = await fixture();
		const root = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const writer = await root.enableResetPolicyPersistence();
		const child = Settings.isolated({ "codexResets.autoRedeem": "no" }, { resetPolicyWriter: writer });
		const rootObservation = root.captureResetPolicySettingsObservation();
		const childObservation = child.captureResetPolicySettingsObservation();

		child.set("codexResets.autoRedeem", "yes");
		childObservation.adoptNativeAutoRedeemSet("yes");
		expect(() => childObservation.assertCurrent()).not.toThrow();
		expect(() => rootObservation.assertCurrent()).not.toThrow();
		await child.flush();
		expect((YAML.parse(await readFile(f.config, "utf8")) as any).codexResets.autoRedeem).toBe("yes");
		expect(() => childObservation.assertCurrent()).not.toThrow();
		expect(() => rootObservation.assertCurrent()).not.toThrow();
		root.disableResetPolicyPersistence();
	});

	test("disposes idempotently and permanently refuses assertion or adoption", async () => {
		const f = await fixture();
		const settings = await Settings.loadReadOnly({ agentDir: f.agentDir, cwd: f.cwd });
		const observation = settings.captureResetPolicySettingsObservation();
		observation.dispose();
		observation.dispose();
		expect(() => observation.assertCurrent()).toThrow("disposed");
		settings.set("codexResets.autoRedeem", "yes");
		expect(() => observation.adoptNativeAutoRedeemSet("yes")).toThrow("disposed");
	});
});
