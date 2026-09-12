"""Compile exact child and parent send expressions against pinned platform types.

The payload is unknown in this transfer-only contract; message parsing and the
whole native dependency graph are explicitly outside this static fixture.
No generated JavaScript is evaluated and no worker or message port is created.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
arguments = sys.argv[1:]
computer = arguments[0] == "--computer"
entry, protocol, host, output = [Path(value).resolve() for value in (arguments[1:] if computer else arguments)]
output.mkdir(parents=True, exist_ok=False)
inputs = {str(path): path.read_bytes() for path in [entry, protocol, host]}
windows = []


def select(path, label, start, end, optional=False):
    text = inputs[str(path)].decode()
    if optional and start not in text:
        return ""
    assert text.count(start) == 1, label
    first = text.index(start)
    last = text.index(end, first) + len(end)
    raw = text[first:last].encode()
    windows.append({"source": str(path), "label": label,
                    "byteStart": len(text[:first].encode()),
                    "byteEnd": len(text[:last].encode()),
                    "sha256": hashlib.sha256(raw).hexdigest()})
    return raw.decode()


capture = select(entry, "captured Bun send", "const postToParent =", ";", True)
if computer:
    alias = ""
    transport_name = "ComputerWorkerTransport"
    payloads = "type ComputerWorkerInbound = unknown; type ComputerWorkerOutbound = unknown;"
    transport = select(protocol, "actual computer transport", "export interface ComputerWorkerTransport {", "\n}")
    send = select(entry, "actual computer child send", "\t\tsend(message, transfer) {", "\n\t\t},")
    post = select(host, "actual computer parent send", "\t\tsend(message) {", "\n\t\t},")
    parent = "const parent: { send(message: ComputerWorkerInbound): void } = {\n" + post + "\n};"
    parent_calls = 'parent.send({ buffer: array }); parent.send({ type: "plain" });'
else:
    alias = select(protocol, "shared transferable", "export type Transferable =", ";")
    transport_name = "Transport"
    payloads = "type WorkerInbound = unknown; type WorkerOutbound = unknown;"
    transport = select(protocol, "actual Transport interface", "export interface Transport {", "\n}")
    send = select(entry, "actual child send method", "\tsend(msg, transferList) {", "\n\t},")
    post = select(host, "actual parent send expression", "(message, transferList) => worker.postMessage", "}),")[:-1]
    parent = 'const parent: (message: WorkerInbound, transferList?: Transferable[]) => void = ' + post + ';'
    parent_calls = 'parent({ buffer: array, port: messagePort }, [array, messagePort]); parent({ type: "plain" });'
fixture = '\n'.join([
    'import type { parentPort } from "node:worker_threads";',
    payloads,
    alias, transport,
    'declare const port: NonNullable<typeof parentPort>;',
    'declare const worker: Worker;',
    capture,
    f"const child: Pick<{transport_name}, 'send'> = {{", send, '};',
    parent,
    'declare const array: ArrayBuffer;',
    'declare const messagePort: MessagePort;',
    'child.send({ buffer: array, port: messagePort }, [array, messagePort]);',
    parent_calls,
    'child.send({ type: "plain" });',
]) + '\n'
(output / 'send.ts').write_text(fixture)
config = {"compilerOptions": {
    "strict": True, "skipLibCheck": False, "noEmit": True,
    "target": "ESNext", "module": "ESNext", "moduleResolution": "Bundler",
    "types": ["bun", "node"], "lib": ["ESNext", "DOM"],
}, "files": [str(output / 'send.ts')]}
(output / 'tsconfig.json').write_text(json.dumps(config, indent=2)+'\n')
command = [str(root/'node_modules/.bin/tsc'), '-p', str(output/'tsconfig.json'), '--pretty', 'false']
run = subprocess.run(command, cwd=root, capture_output=True, text=True)
(output/'compiler.log').write_text(run.stdout+run.stderr)
evidence = {"inputs": {p: hashlib.sha256(raw).hexdigest() for p, raw in inputs.items()},
            "windows": windows, "fixtureSha256": hashlib.sha256(fixture.encode()).hexdigest(),
            "command": command, "exitCode": run.returncode,
            "unchangedInputs": all(Path(p).read_bytes()==raw for p, raw in inputs.items()),
            "scope": "Actual child/parent send expressions and shared transfer types only; no worker/native execution or complete graph proof."}
(output/'result.json').write_text(json.dumps(evidence, indent=2)+'\n')
print(json.dumps(evidence)); print(run.stdout+run.stderr)
sys.exit(run.returncode or (0 if evidence['unchangedInputs'] else 1))
