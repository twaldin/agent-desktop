"""Author opt-in process controls into a private copy of the pinned native package.

Feed the result to the shared complete-net-patch producer. This script never
changes the installed package or the maintained installer patch itself.
"""
from pathlib import Path
import sys
import re

root = Path(sys.argv[1]).resolve()

def replace(text, before, after):
    if text.count(before) != 1:
        raise RuntimeError(f"Expected one native source boundary: {before[:100]!r}")
    return text.replace(before, after, 1)

types = '''/** An observation of one process generation in one running broker. */
export interface DaemonObservedTarget {
    brokerId: string;
    name: string;
    id: string;
    generation: number;
}
export type DaemonNamedOperation = Extract<DaemonLegacyOperation, { name: string }>;
/** Unknown operation tags fail closed on brokers predating this capability. */
export type DaemonOperation = DaemonLegacyOperation
    | { op: "observe" }
    | { op: "guarded"; target: DaemonObservedTarget; operation: DaemonNamedOperation };
export type DaemonRpcResult = DaemonLegacyResult
    | { op: "observe"; brokerId: string; daemons: { target: DaemonObservedTarget; daemon: DaemonSnapshot }[] }
    | { op: "guarded"; target: DaemonObservedTarget; result: DaemonLegacyResult };

'''

for relative in ['src/launch/protocol.ts', 'dist/types/launch/protocol.d.ts']:
    path = root / relative
    s = path.read_text()
    s = replace(s, 'export type DaemonOperation =', 'export type DaemonLegacyOperation =')
    s = replace(s, 'export type DaemonRpcResult =', 'export type DaemonLegacyResult =')
    anchor = '/** Authenticated request envelope used by socket clients. */'
    s = replace(s, anchor, types + anchor)
    if relative.endswith('.ts') and not relative.endswith('.d.ts'):
        anchor = 'function parseDaemonOperation(value: unknown): DaemonOperation {'
        parser = '''function observedTarget(value: unknown): DaemonObservedTarget {
	const source = record(value, "observed process target");
	const generation = numberValue(source.generation, "target.generation");
	if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid process generation");
	return { brokerId: stringValue(source.brokerId, "target.brokerId"), name: stringValue(source.name, "target.name"),
		id: stringValue(source.id, "target.id"), generation };
}

function parseDaemonOperation(value: unknown): DaemonOperation {
	const source = record(value, "daemon operation");
	if (source.op === "observe") return { op: "observe" };
	if (source.op === "guarded") {
		const operation = parseDaemonLegacyOperation(source.operation);
		if (!("name" in operation)) throw new Error("Guarded operation requires an original named process");
		const target = observedTarget(source.target);
		if (target.name !== operation.name) throw new Error("Guarded process name does not match its observation");
		return { op: "guarded", target, operation };
	}
	return parseDaemonLegacyOperation(value);
}

function parseDaemonLegacyOperation(value: unknown): DaemonLegacyOperation {'''
        s = replace(s, anchor, parser)
        anchor = 'export function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult {'
        parser = '''export function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult {
	if (operation.op === "observe") {
		const source = record(value, "process observation");
		if (source.op !== "observe" || !Array.isArray(source.daemons)) throw new Error("Invalid process observation");
		const brokerId = stringValue(source.brokerId, "brokerId");
		const daemons = Array.from(source.daemons, item => {
			const row = record(item, "observed process"), target = observedTarget(row.target), daemon = parseDaemonSnapshot(row.daemon);
			if (target.brokerId !== brokerId || target.name !== daemon.name || target.id !== daemon.id) throw new Error("Process observation identity mismatch");
			return { target, daemon };
		});
		if (new Set(daemons.map(row => row.target.name)).size !== daemons.length) throw new Error("Duplicate observed process");
		return { op: "observe", brokerId, daemons };
	}
	if (operation.op === "guarded") {
		const source = record(value, "guarded process result"), target = observedTarget(source.target);
		const expected = operation.target;
		if (source.op !== "guarded" || target.brokerId !== expected.brokerId || target.name !== expected.name || target.id !== expected.id
			|| target.generation !== expected.generation + (operation.operation.op === "restart" ? 1 : 0)) throw new Error("Guarded process result identity mismatch");
		if (record(source.result, "guarded payload").op !== operation.operation.op) throw new Error("Guarded process operation mismatch");
		const result = parseDaemonLegacyResult(operation.operation, source.result);
		if (("daemon" in result && (result.daemon.id !== target.id || result.daemon.name !== target.name))
			|| ("name" in result && result.name !== target.name)) throw new Error("Guarded process payload identity mismatch");
		return { op: "guarded", target, result };
	}
	return parseDaemonLegacyResult(operation, value);
}

function parseDaemonLegacyResult(operation: DaemonLegacyOperation, value: unknown): DaemonLegacyResult {'''
        s = replace(s, anchor, parser)
    path.write_text(s)

path = root / 'src/launch/client.ts'
s = path.read_text()
s = replace(s, 'switch (operation.op) {\n\t\tcase "start":', 'switch (operation.op) {\n\t\tcase "guarded":\n\t\t\treturn requestTimeoutMs(operation.operation);\n\t\tcase "start":')
s = replace(s, '\tasync request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {', '\tasync request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {\n\t\t// Retain the caller\'s original target and input across connection awaits.\n\t\tif (operation.op === "guarded") operation = structuredClone(operation);')
path.write_text(s)

path = root / 'src/launch/broker.ts'
s = path.read_text()
s = replace(s, 'class DaemonBroker {', 'class DaemonBroker {\n\treadonly #observationId = crypto.randomUUID();')
anchor = '\tasync #dispatch(operation: DaemonOperation): Promise<DaemonRpcResult> {'
guarded = '''	async #guarded(operation: Extract<DaemonOperation, { op: "guarded" }>): Promise<DaemonRpcResult> {
		const record = this.#record(operation.target.name);
		let generation = operation.target.generation;
		const assertCurrent = (): void => {
			if (this.#shuttingDown || operation.target.brokerId !== this.#observationId || this.#records.get(record.spec.name) !== record
				|| operation.target.id !== record.snapshot.id || record.generation !== generation || this.#startingNames.has(record.spec.name)) {
				throw new Error("The observed process or broker has changed; refresh before acting");
			}
		};
		assertCurrent();
		const result = await this.#dispatch(operation.operation, assertCurrent, next => {
			if (next !== generation + 1) throw new Error("Unexpected process restart generation");
			generation = next;
			assertCurrent();
		});
		assertCurrent();
		if (result.op === "observe" || result.op === "guarded") throw new Error("Unexpected nested process result");
		// Do not expose live snapshot objects across the wire-response await.
		return { op: "guarded", target: { ...operation.target, generation }, result: structuredClone(result) };
	}

	async #dispatch(operation: DaemonOperation, assertCurrent: () => void = () => {}, adoptGeneration?: (generation: number) => void): Promise<DaemonRpcResult> {'''
s = replace(s, anchor, guarded)
s = replace(s, '\t\tswitch (operation.op) {\n\t\t\tcase "ping":', '''		assertCurrent();
		switch (operation.op) {
			case "observe": {
				await Promise.all([...this.#records.values()].map(record => this.#refreshDetached(record)));
				if (this.#shuttingDown) throw new Error("Daemon broker is shutting down");
				return { op: "observe", brokerId: this.#observationId,
					daemons: orderDaemonsForListing([...this.#records.values()].map(record => record.snapshot)).map(daemon => {
						const record = this.#record(daemon.name);
						return { target: { brokerId: this.#observationId, name: daemon.name, id: daemon.id, generation: record.generation }, daemon: structuredClone(daemon) };
					}) };
			}
			case "guarded":
				return this.#guarded(operation);
			case "ping":''')
s = replace(s, 'return this.#logs(operation);', 'return this.#logs(operation, assertCurrent);')
s = replace(s, 'return this.#wait(operation);', 'return this.#wait(operation, assertCurrent);')
s = replace(s, 'return this.#send(operation);', 'return this.#send(operation, assertCurrent);')
s = replace(s, 'await this.#stopRecord(record, operation.timeoutMs);', 'await this.#stopRecord(record, operation.timeoutMs, assertCurrent);\n\t\t\t\tassertCurrent();')
s = replace(s, 'return this.#restart(operation.name);', 'return this.#restart(operation.name, assertCurrent, adoptGeneration);')
s = replace(s, '\t\t\t\treturn { op: "describe", daemon: record.snapshot, spec: record.spec };', '\t\t\t\tassertCurrent();\n\t\t\t\treturn { op: "describe", daemon: record.snapshot, spec: record.spec };')

# Guard every asynchronous boundary before a targeted native effect or response.
for name in ['logs', 'wait', 'send']:
    old = f'async #{name}(operation: Extract<DaemonOperation, {{ op: "{name}" }}>): Promise<DaemonRpcResult> {{'
    new = f'async #{name}(operation: Extract<DaemonOperation, {{ op: "{name}" }}>, assertCurrent: () => void = () => {{}}): Promise<DaemonRpcResult> {{'
    s = replace(s, old, new)
    start = s.index(new)
    end = s.index('\n\tasync #', start + len(new))
    body = s[start:end]
    body = replace(body, 'await this.#refreshDetached(record);', 'await this.#refreshDetached(record);\n\t\tassertCurrent();')
    if name == 'send':
        body = replace(body, '\t\tif (operation.signal) {', '\t\tassertCurrent();\n\t\tif (operation.signal) {')
    elif name == 'logs':
        body = replace(body, '\t\tconst lines =', '\t\tassertCurrent();\n\t\tconst lines =')
        body = replace(body, '\t\treturn {', '\t\tassertCurrent();\n\t\treturn {')
    else:
        body = replace(body, '\t\tif (generationEnded()) {', '\t\tassertCurrent();\n\t\tif (generationEnded()) {')
    s = s[:start] + body + s[end:]

s = replace(s, 'async #stopRecord(record: ManagedDaemon, timeoutMs: number): Promise<void> {\n\t\tawait this.#refreshDetached(record);', 'async #stopRecord(record: ManagedDaemon, timeoutMs: number, assertCurrent: () => void = () => {}): Promise<void> {\n\t\tawait this.#refreshDetached(record);\n\t\tassertCurrent();')
s = replace(s, '\t\tif (!settled && record.pty) record.pty.kill();', '\t\tassertCurrent();\n\t\tif (!settled && record.pty) record.pty.kill();')
s = replace(s, '''	async #restart(name: string): Promise<DaemonRpcResult> {
		const record = this.#record(name);
		await this.#stopRecord(record, 2_000);
		await record.log?.close();
		record.log = await DaemonLog.open(record.dir);
		record.stopRequested = false;
		await this.#launch(record);
		await record.persistQueue;
		return { op: "restart", daemon: record.snapshot };
	}''', '''	async #restart(name: string, assertCurrent: () => void = () => {}, adoptGeneration?: (generation: number) => void): Promise<DaemonRpcResult> {
		const record = this.#record(name);
		await this.#stopRecord(record, 2_000, assertCurrent);
		assertCurrent();
		await record.log?.close();
		assertCurrent();
		const log = await DaemonLog.open(record.dir);
		try { assertCurrent(); } catch (error) { await log.close(); throw error; }
		record.log = log;
		record.stopRequested = false;
		await this.#launch(record, assertCurrent, adoptGeneration);
		await record.persistQueue;
		assertCurrent();
		return { op: "restart", daemon: record.snapshot };
	}''')
s = replace(s, '\tasync #launch(record: ManagedDaemon): Promise<void> {\n\t\trecord.generation++;', '\tasync #launch(record: ManagedDaemon, assertCurrent: () => void = () => {}, adoptGeneration?: (generation: number) => void): Promise<void> {\n\t\tassertCurrent();\n\t\trecord.generation++;\n\t\tadoptGeneration?.(record.generation);')
s = replace(s, 'await this.#launchDetached(record, generation);', 'await this.#launchDetached(record, generation, assertCurrent);')
s = replace(s, '\tasync #launchDetached(record: ManagedDaemon, generation: number): Promise<void> {', '\tasync #launchDetached(record: ManagedDaemon, generation: number, assertCurrent: () => void = () => {}): Promise<void> {')
s = replace(s, '\t\tconst output = await fs.open(logPath, "a", 0o600);', '\t\tconst output = await fs.open(logPath, "a", 0o600);\n\t\ttry { assertCurrent(); } catch (error) { await output.close(); throw error; }')
path.write_text(s)

# Keep the existing public operation/result unions closed for native callers
# with exhaustive switches. Only the opt-in client overload admits new tags.
names = {"DaemonLegacyOperation": "DaemonOperation", "DaemonLegacyResult": "DaemonRpcResult",
         "DaemonOperation": "DaemonProcessOperation", "DaemonRpcResult": "DaemonProcessResult"}
for relative in ['src/launch/protocol.ts', 'dist/types/launch/protocol.d.ts', 'src/launch/client.ts', 'dist/types/launch/client.d.ts', 'src/launch/broker.ts']:
    path = root / relative
    s = path.read_text()
    s = re.sub(r'\b(?:DaemonLegacyOperation|DaemonLegacyResult|DaemonOperation|DaemonRpcResult)\b', lambda m: names[m.group()], s)
    if relative.endswith('client.ts') or relative.endswith('client.d.ts'):
        s = replace(s, 'type DaemonProcessOperation,', 'type DaemonOperation, type DaemonRpcResult, type DaemonProcessOperation,')
        signature = 'request(operation: DaemonProcessOperation, signal?: AbortSignal): Promise<DaemonProcessResult>;'
        s = replace(s, signature, 'request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;\n\t' + signature)
        if relative.endswith('/client.ts'):
            s = replace(s, '\tasync request(operation:', '\trequest(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;\n\trequest(operation: DaemonProcessOperation, signal?: AbortSignal): Promise<DaemonProcessResult>;\n\tasync request(operation:')
    if relative.endswith('protocol.ts'):
        signature = 'export function parseDaemonRpcResult(operation: DaemonProcessOperation, value: unknown): DaemonProcessResult {'
        s = replace(s, signature, 'export function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult;\nexport function parseDaemonRpcResult(operation: DaemonProcessOperation, value: unknown): DaemonProcessResult;\n' + signature)
    elif relative.endswith('protocol.d.ts'):
        signature = 'export declare function parseDaemonRpcResult(operation: DaemonProcessOperation, value: unknown): DaemonProcessResult;'
        s = replace(s, signature, 'export declare function parseDaemonRpcResult(operation: DaemonOperation, value: unknown): DaemonRpcResult;\n' + signature)
    path.write_text(s)

