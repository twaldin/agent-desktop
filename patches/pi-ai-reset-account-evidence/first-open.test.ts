/**
 * Concurrent SQLite first-open contract.
 *
 * Every child imports the selected real package, waits at a process boundary,
 * and then opens the same database. No store or schema method is mocked.
 * `PI_AI_EVIDENCE_PACKAGE` can select an isolated authored/fresh package.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const packageRoot = path.resolve(
	import.meta.dir,
	process.env.PI_AI_EVIDENCE_PACKAGE ?? "../../node_modules/@oh-my-pi/pi-ai",
);
const fixture = path.join(import.meta.dir, "fixtures/concurrent-first-open.ts");
const OPENERS = 8;

let root: string;
let sequence = 0;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "pi-ai-concurrent-first-open-"));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function seedLegacyV7(databasePath: string): void {
	const database = new Database(databasePath);
	try {
		database.run(`
			CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
			INSERT INTO auth_schema_version (id, version) VALUES (1, 7);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
			CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
			INSERT INTO auth_change_revision (id, revision) VALUES (1, 0);
		`);
	} finally {
		database.close();
	}
}

async function concurrentOpen(databasePath: string): Promise<void> {
	const ready = Array.from({ length: OPENERS }, () => Promise.withResolvers<void>());
	const opened = Array.from({ length: OPENERS }, () => false);
	const children = ready.map((signal, index) =>
		Bun.spawn([process.execPath, "--no-env-file", fixture, packageRoot, databasePath], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			ipc(message) {
				const type = (message as { type?: string } | null)?.type;
				if (type === "ready") signal.resolve();
				if (type === "opened") opened[index] = true;
			},
		}),
	);
	try {
		await Promise.all(
			ready.map((signal, index) =>
				Promise.race([
					signal.promise,
					children[index]!.exited.then((code) => {
						throw new Error(`opener ${index} exited ${code} before the start boundary`);
					}),
				]),
			),
		);
		for (const child of children) child.send({ type: "open" });
		const exits = await Promise.all(children.map((child) => child.exited));
		const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
		expect({ exits, opened, errors }).toEqual({
			exits: Array(OPENERS).fill(0),
			opened: Array(OPENERS).fill(true),
			errors: Array(OPENERS).fill(""),
		});
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		await Promise.all(children.map((child) => child.exited));
	}
}

function expectResetColumns(databasePath: string): void {
	const database = new Database(databasePath, { readonly: true });
	try {
		const columns = database.query("PRAGMA table_info(auth_credentials)").all() as Array<{ name: string }>;
		expect(columns.map((column) => column.name)).toContain("reset_incarnation");
		expect(columns.map((column) => column.name)).toContain("reset_refresh_version");
	} finally {
		database.close();
	}
}

describe("SQLite auth store concurrent initialization", () => {
	test(
		"every process can prepare reset-aware statements on a fresh database",
		async () => {
			for (let round = 0; round < 24; round += 1) {
				const databasePath = path.join(root, `fresh-${sequence++}.db`);
				await concurrentOpen(databasePath);
				expectResetColumns(databasePath);
			}
		},
		60_000,
	);

	test(
		"concurrent v7 migration installs reset columns before constructors prepare statements",
		async () => {
			for (let round = 0; round < 8; round += 1) {
				const databasePath = path.join(root, `legacy-v7-${sequence++}.db`);
				seedLegacyV7(databasePath);
				await concurrentOpen(databasePath);
				expectResetColumns(databasePath);
			}
		},
		30_000,
	);
});
